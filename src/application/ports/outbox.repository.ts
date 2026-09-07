import type { IntegrationEvent, IntegrationEventEnvelope } from '../events/integration-event.js';

export interface OutboxMessage {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly envelope: IntegrationEventEnvelope<unknown>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly publishedAt: Date | undefined;
}

export interface OutboxRepository {
  /** Grava o evento na mesma transação do efeito financeiro que o originou. */
  append(event: IntegrationEvent<unknown>): Promise<void>;
  /**
   * Reserva um lote de pendentes vencidas para este publisher.
   *
   * A reserva é o próprio lock de linha da transação, adquirido com
   * `SKIP LOCKED`: publishers concorrentes pegam lotes disjuntos em vez de
   * disputar as mesmas linhas, e um publisher que morra libera o lock no
   * rollback, devolvendo as mensagens ao pool.
   */
  claimPending(limit: number, now: Date): Promise<readonly OutboxMessage[]>;
  markPublished(id: string, at: Date): Promise<void>;
  /** Reagenda com backoff após falha de publicação. */
  rescheduleFailed(id: string, attempts: number, nextAttemptAt: Date): Promise<void>;
  findById(id: string): Promise<OutboxMessage | undefined>;
  findByAggregateId(aggregateId: string): Promise<readonly OutboxMessage[]>;
}
