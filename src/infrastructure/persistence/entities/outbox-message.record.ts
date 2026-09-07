import { EntitySchema } from '@mikro-orm/core';
import type { IntegrationEventEnvelope } from '../../../application/events/integration-event.js';

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  eventVersion!: number;
  correlationId!: string;
  causationId!: string | null;
  payload!: IntegrationEventEnvelope<unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt!: Date | null;
}

export const outboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'string', length: 64, primary: true, fieldName: 'id' },
    aggregateId: { type: 'string', length: 64, fieldName: 'aggregate_id' },
    eventType: { type: 'string', length: 64, fieldName: 'event_type' },
    eventVersion: { type: 'integer', fieldName: 'event_version' },
    correlationId: { type: 'string', length: 128, fieldName: 'correlation_id' },
    causationId: { type: 'string', length: 128, nullable: true, fieldName: 'causation_id' },
    payload: { type: 'json', columnType: 'jsonb', fieldName: 'payload' },
    occurredAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'occurred_at' },
    attempts: { type: 'integer', fieldName: 'attempts' },
    nextAttemptAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'next_attempt_at' },
    publishedAt: {
      type: 'datetime',
      columnType: 'timestamptz',
      nullable: true,
      fieldName: 'published_at',
    },
  },
});
