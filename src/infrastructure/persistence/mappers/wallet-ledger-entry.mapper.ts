import { Money } from '../../../domain/shared/money.js';
import { LedgerDirection } from '../../../domain/wallet/ledger-direction.js';
import { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry.js';
import { WalletLedgerEntryRecord } from '../entities/wallet-ledger-entry.record.js';

export function toWalletLedgerEntryRecord(
  entry: WalletLedgerEntry,
  record = new WalletLedgerEntryRecord(),
): WalletLedgerEntryRecord {
  record.id = entry.id;
  record.walletId = entry.walletId;
  record.transactionId = entry.transactionId;
  record.direction = entry.direction;
  record.currency = entry.money.currency;
  record.amount = entry.money.toString();
  record.balanceBefore = entry.balanceBefore.toString();
  record.balanceAfter = entry.balanceAfter.toString();
  record.createdAt = entry.createdAt;

  return record;
}

/**
 * Reconstrói o lançamento sem revalidar sua aritmética: a linha já foi aceita
 * pelo CHECK do PostgreSQL quando foi gravada.
 */
export function toWalletLedgerEntry(record: WalletLedgerEntryRecord): WalletLedgerEntry {
  const money = (amount: string): Money => Money.from({ amount, currency: record.currency });

  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    money: money(record.amount),
    balanceBefore: money(record.balanceBefore),
    balanceAfter: money(record.balanceAfter),
    createdAt: record.createdAt,
  });
}
