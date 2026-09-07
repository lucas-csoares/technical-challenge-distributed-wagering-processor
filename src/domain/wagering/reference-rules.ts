import {
  CurrencyMismatchError,
  InvalidInputError,
  InvalidReferenceError,
  ReversalWouldOverdrawError,
} from '../shared/domain-error.js';
import { FailureCode } from '../shared/failure-code.js';
import type { Money } from '../shared/money.js';
import type { Wallet } from '../wallet/wallet.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.js';

/**
 * `ROLLBACK` referencia `BET`, `WIN` ou `REFUND`; `REFUND` referencia apenas
 * `BET`.
 */
const ELIGIBLE_REFERENCE_KINDS: Readonly<Record<string, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

/**
 * Fatos sobre o histórico persistido que o domínio não é capaz de descobrir
 * sozinho.
 *
 * A unicidade de uma reversão depende do que já foi confirmado no banco, e
 * não de estruturas em memória. A aplicação consulta o histórico dentro da
 * mesma transação SQL e entrega o resultado aqui como um fato explícito.
 */
export interface ReversalFacts {
  /**
   * Já existe uma reversão `PROCESSED` da mesma referência com o **mesmo**
   * `kind`. A regra do desafio proíbe reverter duas vezes pelo mesmo tipo de
   * operação; uma `BET` já estornada por `REFUND` continua elegível a
   * `ROLLBACK`.
   */
  readonly referenceAlreadyReversedBySameKind: boolean;
}

/**
 * Regras de `REFUND` e `ROLLBACK` sobre a transação referenciada.
 *
 * A ordem das verificações é estável, porque define qual `failureCode` o
 * provedor recebe quando mais de uma condição falha.
 */
export function assertReversalIsEligible(
  reversal: WagerTransaction,
  reference: WagerTransaction,
  facts: ReversalFacts,
): void {
  if (!reversal.requiresReference()) {
    throw new InvalidInputError(`${reversal.kind} is not a reversal.`);
  }

  assertReferenceIsCompatible(reversal, reference);

  const eligibleKinds = ELIGIBLE_REFERENCE_KINDS[reversal.kind] ?? [];

  if (!eligibleKinds.includes(reference.kind)) {
    throw new InvalidReferenceError(
      `${reversal.kind} cannot reverse a ${reference.kind} transaction.`,
      FailureCode.ReferenceKindNotEligible,
    );
  }

  if (reference.status !== WagerTransactionStatus.Processed) {
    throw new InvalidReferenceError(
      `The referenced transaction is ${reference.status}, not PROCESSED.`,
      FailureCode.ReferenceNotProcessed,
    );
  }

  // Reversão parcial está fora de escopo: o valor precisa ser o integral.
  if (!reversal.money.equals(reference.money)) {
    throw new InvalidReferenceError(
      'A reversal must carry the full amount of its reference.',
      FailureCode.ReferenceAmountMismatch,
    );
  }

  if (facts.referenceAlreadyReversedBySameKind) {
    throw new InvalidReferenceError(
      `The referenced transaction was already reversed by a ${reversal.kind}.`,
      FailureCode.ReferenceAlreadyReversed,
    );
  }
}

/**
 * `WIN` pode referenciar a `BET` da mesma rodada, mas não é obrigada a isso.
 *
 * Quando a referência é informada, ela precisa ser compatível e apontar para
 * uma `BET` `PROCESSED`. O valor **não** precisa coincidir: um prêmio é
 * naturalmente diferente da aposta. Como `WIN` não é uma reversão, a regra de
 * reversão única não se aplica — uma `BET` pode ter `WIN` e `ROLLBACK`.
 */
export function assertWinReferenceIsEligible(
  win: WagerTransaction,
  reference: WagerTransaction,
): void {
  if (win.kind !== WagerTransactionKind.Win) {
    throw new InvalidInputError(`${win.kind} is not a WIN.`);
  }

  assertReferenceIsCompatible(win, reference);

  if (reference.kind !== WagerTransactionKind.Bet) {
    throw new InvalidReferenceError(
      `WIN cannot reference a ${reference.kind} transaction.`,
      FailureCode.ReferenceKindNotEligible,
    );
  }

  if (reference.status !== WagerTransactionStatus.Processed) {
    throw new InvalidReferenceError(
      `The referenced transaction is ${reference.status}, not PROCESSED.`,
      FailureCode.ReferenceNotProcessed,
    );
  }
}

/**
 * Guarda aplicada antes de debitar a wallet em uma reversão (`ROLLBACK` de
 * `WIN` ou de `REFUND`).
 *
 * Existe para que a rejeição carregue `REVERSAL_WOULD_OVERDRAW` em vez de
 * `INSUFFICIENT_FUNDS`: uma aposta sem saldo é situação de jogo, uma reversão
 * sem saldo é inconsistência operacional. `Wallet.debit` mantém seu próprio
 * guarda como última barreira da invariante de saldo não negativo.
 */
export function assertReversalDoesNotOverdraw(wallet: Wallet, money: Money): void {
  if (wallet.balance.isLessThan(money)) {
    throw new ReversalWouldOverdrawError();
  }
}

/** Mesmo provider, player, wallet, moeda e rodada. */
function assertReferenceIsCompatible(
  transaction: WagerTransaction,
  reference: WagerTransaction,
): void {
  if (transaction.providerId !== reference.providerId) {
    throw new InvalidReferenceError(
      'The referenced transaction belongs to another provider.',
      FailureCode.ReferenceMismatch,
    );
  }

  if (transaction.playerId !== reference.playerId) {
    throw new InvalidReferenceError(
      'The referenced transaction belongs to another player.',
      FailureCode.ReferenceMismatch,
    );
  }

  if (transaction.walletId !== reference.walletId) {
    throw new InvalidReferenceError(
      'The referenced transaction belongs to another wallet.',
      FailureCode.ReferenceMismatch,
    );
  }

  if (transaction.money.currency !== reference.money.currency) {
    throw new CurrencyMismatchError(reference.money.currency, transaction.money.currency);
  }

  if (transaction.roundId !== reference.roundId) {
    throw new InvalidReferenceError(
      'The referenced transaction belongs to another round.',
      FailureCode.ReferenceMismatch,
    );
  }
}
