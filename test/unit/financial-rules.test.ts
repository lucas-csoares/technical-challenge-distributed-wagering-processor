import { describe, expect, test } from 'bun:test';
import { InsufficientFundsError } from '../../src/domain/shared/domain-error.js';
import { FailureCode } from '../../src/domain/shared/failure-code.js';
import { Money } from '../../src/domain/shared/money.js';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction.js';
import { WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry.js';
import type { Wallet } from '../../src/domain/wallet/wallet.js';
import { assertReversalIsEligible } from '../../src/domain/wagering/reference-rules.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransaction,
} from '../../src/domain/wagering/wager-transaction.js';
import { AT, brl, LATER, openWallet, transaction } from './support.js';

/**
 * Composição mínima que uma aplicação faria dentro da transação SQL: aplicar a
 * movimentação na wallet, emitir o lançamento e concluir a transação. Serve
 * para observar as regras de negócio juntas — não demonstra atomicidade,
 * concorrência nem idempotência, que dependem do PostgreSQL.
 */
function apply(
  wallet: Wallet,
  wagerTransaction: WagerTransaction,
  reference?: WagerTransaction,
): WalletLedgerEntry {
  const direction = wagerTransaction.ledgerDirectionFor(reference);
  const movement =
    direction === LedgerDirection.Debit
      ? wallet.debit(wagerTransaction.money, LATER)
      : wallet.credit(wagerTransaction.money, LATER);

  wagerTransaction.markProcessed(reference?.id, LATER);

  return WalletLedgerEntry.create({
    ...movement,
    id: `entry-${wagerTransaction.id}`,
    transactionId: wagerTransaction.id,
    createdAt: LATER,
  });
}

function balanceFromLedger(entries: readonly WalletLedgerEntry[], currency: string): Money {
  return entries.reduce(
    (balance, entry) =>
      entry.direction === LedgerDirection.Debit
        ? balance.subtract(entry.money)
        : balance.add(entry.money),
    Money.zero(currency),
  );
}

describe('efeito de cada operação sobre o saldo', () => {
  test('BET debita e produz um lançamento DEBIT', () => {
    const { wallet, movement } = openWallet('100.00');
    const bet = transaction({ money: brl('25.00') });
    const entry = apply(wallet, bet);

    expect(wallet.balance.toString()).toBe('75.00');
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(bet.status).toBe(WagerTransactionStatus.Processed);
    expect(movement).toBeDefined();
  });

  test('BET sem saldo é rejeitada e não move a wallet nem o ledger', () => {
    const { wallet } = openWallet('10.00');
    const bet = transaction({ money: brl('25.00') });

    expect(() => apply(wallet, bet)).toThrow(InsufficientFundsError);

    bet.reject(FailureCode.InsufficientFunds);

    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.version).toBe(1);
    expect(bet.status).toBe(WagerTransactionStatus.Rejected);
    expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('WIN credita e produz um lançamento CREDIT', () => {
    const { wallet } = openWallet('100.00');
    const win = transaction({ kind: WagerTransactionKind.Win, money: brl('90.00') });
    const entry = apply(wallet, win);

    expect(wallet.balance.toString()).toBe('190.00');
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('LOSS registra o resultado sem mover saldo nem gerar lançamento', () => {
    const { wallet } = openWallet('100.00');
    const loss = transaction({ kind: WagerTransactionKind.Loss, money: brl('25.00') });

    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow();

    loss.markProcessed(undefined, LATER);

    expect(loss.status).toBe(WagerTransactionStatus.Processed);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });
});

describe('reversões', () => {
  test('REFUND devolve o valor integral da BET revertida', () => {
    const { wallet } = openWallet('100.00');
    const bet = transaction({ money: brl('25.00') });
    apply(wallet, bet);

    const refund = transaction({
      id: 'tx-refund',
      externalTransactionId: 'ext-refund',
      idempotencyKey: 'provider-a:ext-refund',
      kind: WagerTransactionKind.Refund,
      money: brl('25.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    assertReversalIsEligible(refund, bet, { referenceAlreadyReversedBySameKind: false });
    const entry = apply(wallet, refund, bet);

    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(refund.referenceTransactionId).toBe(bet.id);
  });

  test('ROLLBACK inverte a direção da referência', () => {
    const { wallet } = openWallet('100.00');
    const win = transaction({ kind: WagerTransactionKind.Win, money: brl('40.00') });
    apply(wallet, win);

    const rollback = transaction({
      id: 'tx-rollback',
      externalTransactionId: 'ext-rollback',
      idempotencyKey: 'provider-a:ext-rollback',
      kind: WagerTransactionKind.Rollback,
      money: brl('40.00'),
      referenceExternalTransactionId: win.externalTransactionId,
    });

    assertReversalIsEligible(rollback, win, { referenceAlreadyReversedBySameKind: false });
    const entry = apply(wallet, rollback, win);

    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toString()).toBe('100.00');
  });
});

describe('saldo reconstruído pelo ledger', () => {
  test('a sequência OPENING, BET, WIN e REFUND mantém saldo e ledger equivalentes', () => {
    const { wallet, movement } = openWallet('100.00');
    const entries: WalletLedgerEntry[] = [];

    if (movement === undefined) {
      throw new Error('expected an opening movement for a positive initial balance');
    }

    entries.push(
      WalletLedgerEntry.create({
        ...movement,
        id: 'entry-opening',
        transactionId: 'tx-opening',
        createdAt: AT,
      }),
    );

    const bet = transaction({ money: brl('30.00') });
    entries.push(apply(wallet, bet));

    const win = transaction({
      id: 'tx-win',
      externalTransactionId: 'ext-win',
      idempotencyKey: 'provider-a:ext-win',
      kind: WagerTransactionKind.Win,
      money: brl('12.50'),
    });
    entries.push(apply(wallet, win));

    const refund = transaction({
      id: 'tx-refund',
      externalTransactionId: 'ext-refund',
      idempotencyKey: 'provider-a:ext-refund',
      kind: WagerTransactionKind.Refund,
      money: brl('30.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    assertReversalIsEligible(refund, bet, { referenceAlreadyReversedBySameKind: false });
    entries.push(apply(wallet, refund, bet));

    expect(wallet.balance.toString()).toBe('112.50');
    expect(balanceFromLedger(entries, 'BRL').equals(wallet.balance)).toBe(true);
    expect(entries.every((entry) => entry.isBalanced())).toBe(true);
    expect(wallet.version).toBe(4);
  });
});
