import { LockMode } from '@mikro-orm/core';
import type { WagerTransactionRepository } from '../../../application/ports/wager-transaction.repository.js';
import type { WagerTransaction } from '../../../domain/wagering/wager-transaction.js';
import { WagerTransactionRecord } from '../entities/wager-transaction.record.js';
import { toWagerTransaction, toWagerTransactionRecord } from '../mappers/wager-transaction.mapper.js';
import type { TransactionContext } from '../transaction-context.js';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly context: TransactionContext) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.context.entityManager.findOne(WagerTransactionRecord, { id });
    return record === null ? undefined : toWagerTransaction(record);
  }

  async findByProviderAndExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.context.entityManager.findOne(WagerTransactionRecord, {
      providerId, externalTransactionId,
    });
    return record === null ? undefined : toWagerTransaction(record);
  }

  async findByProviderAndIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.context.entityManager.findOne(WagerTransactionRecord, {
      providerId, idempotencyKey,
    });
    return record === null ? undefined : toWagerTransaction(record);
  }

  async hasProcessedReversalForReference(referenceTransactionId: string, kind: 'REFUND' | 'ROLLBACK'): Promise<boolean> {
    const count = await this.context.entityManager.count(WagerTransactionRecord, {
      referenceTransactionId, kind, status: 'PROCESSED',
    });
    return count > 0;
  }

  async findByIdForUpdate(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.context.entityManager.findOne(
      WagerTransactionRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );

    return record === null ? undefined : toWagerTransaction(record);
  }

  async claimDuePendingReferences(limit: number, now: Date): Promise<readonly string[]> {
    const records = await this.context.entityManager.find(
      WagerTransactionRecord,
      { status: 'PENDING_REFERENCE', nextReferenceAttemptAt: { $lte: now } },
      {
        orderBy: { nextReferenceAttemptAt: 'asc', id: 'asc' },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        fields: ['id'],
      },
    );

    return records.map((record) => record.id);
  }

  async save(transaction: WagerTransaction): Promise<void> {
    const em = this.context.entityManager;
    const existing = await em.findOne(WagerTransactionRecord, { id: transaction.id });
    em.persist(toWagerTransactionRecord(transaction, existing ?? undefined));
    await em.flush();
  }
}
