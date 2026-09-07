import type { FilterQuery } from '@mikro-orm/core';
import type {
  LedgerPageQuery,
  WalletLedgerRepository,
} from '../../../application/ports/wallet-ledger.repository.js';
import type { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry.js';
import { WalletLedgerEntryRecord } from '../entities/wallet-ledger-entry.record.js';
import { toWalletLedgerEntry, toWalletLedgerEntryRecord } from '../mappers/wallet-ledger-entry.mapper.js';
import type { TransactionContext } from '../transaction-context.js';

export class MikroOrmWalletLedgerRepository implements WalletLedgerRepository {
  constructor(private readonly context: TransactionContext) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    // INSERT explícito: nem mesmo repetir o id pode virar UPDATE ou upsert.
    await this.context.entityManager.insert(WalletLedgerEntryRecord, toWalletLedgerEntryRecord(entry));
  }

  async findByWalletId(walletId: string): Promise<readonly WalletLedgerEntry[]> {
    const records = await this.context.entityManager.find(WalletLedgerEntryRecord, { walletId }, {
      orderBy: { createdAt: 'asc', id: 'asc' },
    });
    return records.map(toWalletLedgerEntry);
  }

  /**
   * Keyset sobre `(created_at, id)`, a mesma ordenação do índice
   * `wallet_ledger_entries_wallet_idx`, para que a página não dependa de
   * offset nem escaneie o histórico já entregue.
   */
  async findPage(query: LedgerPageQuery): Promise<readonly WalletLedgerEntry[]> {
    const after = query.after;
    const position: FilterQuery<WalletLedgerEntryRecord> | undefined =
      after === undefined
        ? undefined
        : {
            $or: [
              { createdAt: { $gt: after.createdAt } },
              { createdAt: after.createdAt, id: { $gt: after.id } },
            ],
          };

    const records = await this.context.entityManager.find(
      WalletLedgerEntryRecord,
      position === undefined ? { walletId: query.walletId } : { $and: [{ walletId: query.walletId }, position] },
      { orderBy: { createdAt: 'asc', id: 'asc' }, limit: query.limit },
    );

    return records.map(toWalletLedgerEntry);
  }
}
