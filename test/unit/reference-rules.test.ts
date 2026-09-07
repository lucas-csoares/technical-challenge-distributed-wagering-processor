import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  DomainRuleViolationError,
  InsufficientFundsError,
  ReversalWouldOverdrawError,
} from '../../src/domain/shared/domain-error.js';
import { FailureCode } from '../../src/domain/shared/failure-code.js';
import {
  assertReversalDoesNotOverdraw,
  assertReversalIsEligible,
  assertWinReferenceIsEligible,
  type ReversalFacts,
} from '../../src/domain/wagering/reference-rules.js';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction.js';
import { brl, LATER, openWallet, processedTransaction, transaction, usd } from './support.js';

const NOT_REVERSED: ReversalFacts = { referenceAlreadyReversedBySameKind: false };
const ALREADY_REVERSED: ReversalFacts = { referenceAlreadyReversedBySameKind: true };

function processedBet(overrides: Parameters<typeof processedTransaction>[0] = {}) {
  return processedTransaction({
    id: 'tx-bet',
    externalTransactionId: 'ext-bet',
    idempotencyKey: 'provider-a:ext-bet',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    ...overrides,
  });
}

function reversal(kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback, money = '25.00') {
  return transaction({
    id: 'tx-reversal',
    externalTransactionId: 'ext-reversal',
    idempotencyKey: 'provider-a:ext-reversal',
    kind,
    money: brl(money),
    referenceExternalTransactionId: 'ext-bet',
  });
}

function expectFailureCode(operation: () => void, code: FailureCode): void {
  try {
    operation();
    throw new Error('expected the rule to reject the operation');
  } catch (error) {
    expect(error).toBeInstanceOf(DomainRuleViolationError);
    expect((error as DomainRuleViolationError).failureCode).toBe(code);
  }
}

describe('tipos de referência elegíveis', () => {
  test('REFUND reverte uma BET processada', () => {
    expect(() =>
      assertReversalIsEligible(reversal(WagerTransactionKind.Refund), processedBet(), NOT_REVERSED),
    ).not.toThrow();
  });

  test.each([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ] as const)('ROLLBACK reverte %s processada', (kind) => {
    const reference = processedBet({
      kind,
      referenceExternalTransactionId:
        kind === WagerTransactionKind.Refund ? 'ext-origin' : undefined,
    });

    expect(() =>
      assertReversalIsEligible(reversal(WagerTransactionKind.Rollback), reference, NOT_REVERSED),
    ).not.toThrow();
  });

  test.each([WagerTransactionKind.Win, WagerTransactionKind.Loss] as const)(
    'REFUND não reverte %s',
    (kind) => {
      expectFailureCode(
        () =>
          assertReversalIsEligible(
            reversal(WagerTransactionKind.Refund),
            processedBet({ kind }),
            NOT_REVERSED,
          ),
        FailureCode.ReferenceKindNotEligible,
      );
    },
  );

  test.each([WagerTransactionKind.Loss, WagerTransactionKind.Rollback] as const)(
    'ROLLBACK não reverte %s',
    (kind) => {
      const reference = processedBet({
        kind,
        referenceExternalTransactionId:
          kind === WagerTransactionKind.Rollback ? 'ext-origin' : undefined,
      });

      expectFailureCode(
        () =>
          assertReversalIsEligible(reversal(WagerTransactionKind.Rollback), reference, NOT_REVERSED),
        FailureCode.ReferenceKindNotEligible,
      );
    },
  );
});

describe('estado e valor da referência', () => {
  test('referência ainda não processada é recusada', () => {
    expectFailureCode(
      () =>
        assertReversalIsEligible(
          reversal(WagerTransactionKind.Refund),
          transaction({ id: 'tx-bet', kind: WagerTransactionKind.Bet }),
          NOT_REVERSED,
        ),
      FailureCode.ReferenceNotProcessed,
    );
  });

  test('referência rejeitada é recusada', () => {
    const rejected = transaction({ id: 'tx-bet', kind: WagerTransactionKind.Bet });
    rejected.reject(FailureCode.InsufficientFunds);

    expectFailureCode(
      () => assertReversalIsEligible(reversal(WagerTransactionKind.Refund), rejected, NOT_REVERSED),
      FailureCode.ReferenceNotProcessed,
    );
  });

  test.each(['24.99', '25.01', '12.50'])('reversão parcial de %p é recusada', (amount) => {
    expectFailureCode(
      () =>
        assertReversalIsEligible(
          reversal(WagerTransactionKind.Refund, amount),
          processedBet(),
          NOT_REVERSED,
        ),
      FailureCode.ReferenceAmountMismatch,
    );
  });
});

describe('compatibilidade da referência', () => {
  test.each([
    ['provider', { providerId: 'provider-b' }],
    ['player', { playerId: 'player-2' }],
    ['wallet', { walletId: 'wallet-2' }],
    ['rodada', { roundId: 'round-2' }],
  ] as const)('referência de outro %s é recusada', (_name, overrides) => {
    expectFailureCode(
      () =>
        assertReversalIsEligible(
          reversal(WagerTransactionKind.Refund),
          processedBet(overrides),
          NOT_REVERSED,
        ),
      FailureCode.ReferenceMismatch,
    );
  });

  test('referência em outra moeda falha com CURRENCY_MISMATCH', () => {
    const reference = processedBet({ money: usd('25.00') });

    expect(() =>
      assertReversalIsEligible(reversal(WagerTransactionKind.Refund), reference, NOT_REVERSED),
    ).toThrow(CurrencyMismatchError);
    expectFailureCode(
      () => assertReversalIsEligible(reversal(WagerTransactionKind.Refund), reference, NOT_REVERSED),
      FailureCode.CurrencyMismatch,
    );
  });
});

describe('reversão única por tipo de operação', () => {
  test('a mesma referência não é revertida duas vezes pelo mesmo tipo', () => {
    expectFailureCode(
      () =>
        assertReversalIsEligible(
          reversal(WagerTransactionKind.Refund),
          processedBet(),
          ALREADY_REVERSED,
        ),
      FailureCode.ReferenceAlreadyReversed,
    );
  });

  test('uma BET já estornada por REFUND continua elegível a ROLLBACK', () => {
    expect(() =>
      assertReversalIsEligible(
        reversal(WagerTransactionKind.Rollback),
        processedBet(),
        NOT_REVERSED,
      ),
    ).not.toThrow();
  });
});

describe('referência opcional de WIN', () => {
  test('WIN referencia a BET processada da mesma rodada com valor diferente', () => {
    const win = transaction({
      id: 'tx-win',
      externalTransactionId: 'ext-win',
      idempotencyKey: 'provider-a:ext-win',
      kind: WagerTransactionKind.Win,
      money: brl('90.00'),
      referenceExternalTransactionId: 'ext-bet',
    });

    expect(() => { assertWinReferenceIsEligible(win, processedBet()); }).not.toThrow();
  });

  test('WIN só referencia uma BET, e apenas quando processada', () => {
    const win = transaction({
      id: 'tx-win',
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: 'ext-bet',
    });

    expectFailureCode(
      () => { assertWinReferenceIsEligible(win, processedBet({ kind: WagerTransactionKind.Win })); },
      FailureCode.ReferenceKindNotEligible,
    );
    expectFailureCode(
      () => {
        assertWinReferenceIsEligible(win, transaction({ id: 'tx-bet' }));
      },
      FailureCode.ReferenceNotProcessed,
    );
  });
});

describe('reversão que produziria saldo negativo', () => {
  test('é rejeitada com um código distinto do de saldo insuficiente', () => {
    const { wallet } = openWallet('10.00');

    expectFailureCode(
      () => { assertReversalDoesNotOverdraw(wallet, brl('10.01')); },
      FailureCode.ReversalWouldOverdraw,
    );
    expect(() => assertReversalDoesNotOverdraw(wallet, brl('10.01'))).toThrow(
      ReversalWouldOverdrawError,
    );
    expect(() => wallet.debit(brl('10.01'), LATER)).toThrow(InsufficientFundsError);
    expect(FailureCode.ReversalWouldOverdraw).not.toBe(FailureCode.InsufficientFunds);
  });

  test('reversão coberta pelo saldo é permitida, inclusive no valor exato', () => {
    const { wallet } = openWallet('10.00');

    expect(() => { assertReversalDoesNotOverdraw(wallet, brl('10.00')); }).not.toThrow();
  });

  test('a wallet mantém seu próprio guarda de saldo não negativo', () => {
    const { wallet } = openWallet('10.00');

    expect(() => wallet.debit(brl('10.01'), LATER)).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('10.00');
  });
});
