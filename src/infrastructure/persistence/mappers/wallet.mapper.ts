import { Money } from '../../../domain/shared/money.js';
import { Wallet } from '../../../domain/wallet/wallet.js';
import { WalletRecord } from '../entities/wallet.record.js';

/**
 * Tradução entre `Wallet` e sua linha.
 *
 * A volta usa `Wallet.rehydrate`, que reconstrói o estado persistido sem gerar
 * ids ou timestamps, sem incrementar `version` e sem reaplicar movimentações.
 */
export function toWalletRecord(wallet: Wallet, record = new WalletRecord()): WalletRecord {
  record.id = wallet.id;
  record.playerId = wallet.playerId;
  record.currency = wallet.currency;
  record.balance = wallet.balance.toString();
  record.version = wallet.version;
  record.createdAt = wallet.createdAt;
  record.updatedAt = wallet.updatedAt;

  return record;
}

export function toWallet(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: Money.from({ amount: record.balance, currency: record.currency }),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
