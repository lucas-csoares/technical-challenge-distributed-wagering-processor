import { expect } from 'bun:test';
import type { FinancialTransactionScope } from '../../src/application/ports/financial-transaction-manager.js';
import { Money } from '../../src/domain/shared/money.js';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction.js';
import { WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry.js';
import { Wallet } from '../../src/domain/wallet/wallet.js';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wagering/wager-transaction.js';

export const AT = new Date('2026-09-06T12:00:00.000Z');
export const LATER = new Date('2026-09-06T12:05:00.000Z');
export const id = (): string => crypto.randomUUID();
export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

/** Fixture financeira completa; não é o futuro caso de uso de abertura. */
export function openingFixture(amount = '100.00') {
  const { wallet, movement } = Wallet.open({
    id: id(), playerId: id(), initialBalance: brl(amount), openedAt: AT,
  });
  if (movement === undefined) {
    throw new Error('Opening fixture requires a positive balance.');
  }
  const transaction = WagerTransaction.createOpening({
    id: id(), walletId: wallet.id, playerId: wallet.playerId,
    money: wallet.balance, createdAt: AT,
  });
  transaction.markProcessed(undefined, AT);
  const entry = WalletLedgerEntry.create({ ...movement, id: id(), transactionId: transaction.id, createdAt: AT });
  return { wallet, transaction, entry };
}

export async function persistOpening(scope: FinancialTransactionScope, fixture: ReturnType<typeof openingFixture>) {
  await scope.wallets.save(fixture.wallet);
  await scope.transactions.save(fixture.transaction);
  await scope.ledger.append(fixture.entry);
}

/** Composição mínima para testar atualização sob lock, sem regras de um use case de WIN. */
export async function persistCredit(scope: FinancialTransactionScope, wallet: Wallet, amount = '0.01') {
  const transaction = WagerTransaction.create({
    id: id(), providerId: 'provider-a', externalTransactionId: id(), idempotencyKey: id(),
    payloadHash: 'fixture-hash', walletId: wallet.id, playerId: wallet.playerId,
    roundId: 'round-1', gameId: 'game-1', kind: WagerTransactionKind.Win,
    money: brl(amount), createdAt: LATER,
  });
  const movement = wallet.credit(transaction.money, LATER);
  transaction.markProcessed(undefined, LATER);
  const entry = WalletLedgerEntry.create({ ...movement, id: id(), transactionId: transaction.id, createdAt: LATER });
  await scope.wallets.save(wallet);
  await scope.transactions.save(transaction);
  await scope.ledger.append(entry);
  return { transaction, entry };
}

export function requireWallet(wallet: Wallet | undefined): Wallet {
  if (wallet === undefined) throw new Error('Expected fixture wallet.');
  return wallet;
}

export async function assertLedgerBalance(scope: FinancialTransactionScope, walletId: string): Promise<void> {
  const wallet = requireWallet(await scope.wallets.findById(walletId));
  const entries = await scope.ledger.findByWalletId(walletId);
  const reconstructed = entries.reduce((balance, entry) =>
    entry.direction === LedgerDirection.Credit ? balance.add(entry.money) : balance.subtract(entry.money),
  Money.zero(wallet.currency));
  expect(wallet.balance.equals(reconstructed)).toBe(true);
  expect(entries.every(entry => entry.isBalanced())).toBe(true);
}
