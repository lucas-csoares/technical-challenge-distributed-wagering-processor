import { MessagePublisher } from './ports/message-publisher.js';
import { FinancialTransactionManager } from './ports/financial-transaction-manager.js';
import { noopMetrics, type MetricsPort } from './ports/metrics.js';
import type { OutboxMessage } from './ports/outbox.repository.js';

export interface OutboxPublishOptions {
  readonly batchSize: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const defaultOutboxPublishOptions: OutboxPublishOptions = {
  batchSize: 20,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
};

export interface OutboxPublishReport {
  readonly published: number;
  readonly failed: number;
}

/**
 * Publica eventos pendentes da Outbox.
 *
 * O lote é reservado com `SKIP LOCKED` dentro de uma transação, publicado, e
 * marcado como publicado na mesma transação. A garantia é **at-least-once**,
 * não exactly-once: se o processo morrer entre o `SendMessage` aceito pelo SQS
 * e o commit do `published_at`, a transação reverte e outro publisher enviará
 * o mesmo evento de novo. A duplicata carrega o mesmo `eventId`, que é estável
 * desde a transação financeira, então o consumidor deduplica por ele. Tentar
 * eliminar essa janela exigiria transação distribuída entre PostgreSQL e SQS,
 * que é justamente o que a Outbox existe para evitar.
 *
 * Uma falha de publicação não derruba o lote: a mensagem é reagendada com
 * backoff exponencial e as demais seguem.
 */
export class PublishOutboxUseCase {
  constructor(
    private readonly transactions: FinancialTransactionManager,
    private readonly publisher: MessagePublisher,
    private readonly options: OutboxPublishOptions = defaultOutboxPublishOptions,
    private readonly now: () => Date = () => new Date(),
    private readonly metrics: MetricsPort = noopMetrics,
  ) {}

  async execute(): Promise<OutboxPublishReport> {
    return this.transactions.execute(async (scope) => {
      const pending = await scope.outbox.claimPending(this.options.batchSize, this.now());
      let published = 0;
      let failed = 0;

      this.metrics.setOutboxOldestPendingAge(this.oldestAgeSeconds(pending));

      for (const message of pending) {
        try {
          await this.publisher.publish({
            body: JSON.stringify(message.envelope),
            // Eventos da mesma wallet ou transação mantêm ordem relativa.
            groupId: message.aggregateId,
            deduplicationId: message.id,
          });
          const publishedAt = this.now();
          await scope.outbox.markPublished(message.id, publishedAt);
          this.metrics.observeOutboxPublishLag(this.ageSeconds(message.occurredAt, publishedAt));
          published += 1;
        } catch {
          const attempts = message.attempts + 1;
          await scope.outbox.rescheduleFailed(message.id, attempts, this.backoffFrom(attempts));
          this.metrics.recordRetry('outbox');
          failed += 1;
        }
      }

      return { published, failed };
    });
  }

  /**
   * Lag do lote reivindicado neste ciclo, zero quando não há nada pendente.
   *
   * Mede o que este publisher enxergou, não a fila inteira: uma consulta extra
   * pelo mais antigo global custaria uma varredura a cada ciclo para observar o
   * mesmo sintoma que o lote já revela.
   */
  private oldestAgeSeconds(pending: readonly OutboxMessage[]): number {
    const now = this.now();

    return pending.reduce(
      (oldest, message) => Math.max(oldest, this.ageSeconds(message.occurredAt, now)),
      0,
    );
  }

  private ageSeconds(occurredAt: Date, at: Date): number {
    return Math.max(0, (at.getTime() - occurredAt.getTime()) / 1_000);
  }

  private backoffFrom(attempts: number): Date {
    const delay = Math.min(
      this.options.baseDelayMs * 2 ** (attempts - 1),
      this.options.maxDelayMs,
    );

    return new Date(this.now().getTime() + delay);
  }
}
