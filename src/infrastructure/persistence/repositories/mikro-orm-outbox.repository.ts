import { LockMode } from '@mikro-orm/core';
import type { IntegrationEvent } from '../../../application/events/integration-event.js';
import type {
  OutboxMessage,
  OutboxRepository,
} from '../../../application/ports/outbox.repository.js';
import { OutboxMessageRecord } from '../entities/outbox-message.record.js';
import { toUndefined } from '../mappers/nullable.js';
import type { TransactionContext } from '../transaction-context.js';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly context: TransactionContext) {}

  async append(event: IntegrationEvent<unknown>): Promise<void> {
    await this.context.entityManager.insert(OutboxMessageRecord, {
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      eventVersion: event.version,
      correlationId: event.correlationId,
      causationId: event.causationId ?? null,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
      attempts: 0,
      // Publicável assim que a transação financeira commitar.
      nextAttemptAt: event.occurredAt,
      publishedAt: null,
    });
  }

  /**
   * `FOR UPDATE SKIP LOCKED` sobre o índice parcial de pendentes.
   *
   * Publishers concorrentes recebem lotes disjuntos em vez de disputarem as
   * mesmas linhas, e um publisher que morra libera os locks no rollback — as
   * mensagens voltam ao pool sem precisar de claim com expiração própria.
   */
  async claimPending(limit: number, now: Date): Promise<readonly OutboxMessage[]> {
    const records = await this.context.entityManager.find(
      OutboxMessageRecord,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      {
        orderBy: { nextAttemptAt: 'asc', id: 'asc' },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );

    return records.map(toOutboxMessage);
  }

  async markPublished(id: string, at: Date): Promise<void> {
    await this.context.entityManager.nativeUpdate(OutboxMessageRecord, { id }, { publishedAt: at });
  }

  async rescheduleFailed(id: string, attempts: number, nextAttemptAt: Date): Promise<void> {
    await this.context.entityManager.nativeUpdate(
      OutboxMessageRecord,
      { id },
      { attempts, nextAttemptAt },
    );
  }

  async findById(id: string): Promise<OutboxMessage | undefined> {
    const record = await this.context.entityManager.findOne(OutboxMessageRecord, { id });

    return record === null ? undefined : toOutboxMessage(record);
  }

  async findByAggregateId(aggregateId: string): Promise<readonly OutboxMessage[]> {
    const records = await this.context.entityManager.find(
      OutboxMessageRecord,
      { aggregateId },
      { orderBy: { occurredAt: 'asc', id: 'asc' } },
    );

    return records.map(toOutboxMessage);
  }
}

function toOutboxMessage(record: OutboxMessageRecord): OutboxMessage {
  return {
    id: record.id,
    aggregateId: record.aggregateId,
    eventType: record.eventType,
    eventVersion: record.eventVersion,
    correlationId: record.correlationId,
    causationId: toUndefined(record.causationId),
    envelope: record.payload,
    occurredAt: record.occurredAt,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt,
    publishedAt: toUndefined(record.publishedAt),
  };
}
