import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import {
  MetricsPort,
  type DuplicateSource,
  type LockConflictReason,
  type PermanentMessageReason,
  type RetryComponent,
  type WagerTransport,
} from '../../application/ports/metrics.js';
import type { WagerTransactionStatus } from '../../domain/wagering/wager-transaction.js';

/**
 * Content type da exposição do Prometheus.
 *
 * Fica como constante porque o decorator `@Header` do NestJS precisa do valor
 * em tempo de definição da classe; um teste confere que continua igual ao que o
 * registry produz.
 */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Profundidade atual da DLQ, quando o broker responde. */
export type DlqDepthProbe = () => Promise<number | undefined>;

/** Segundos: da ordem de uma consulta rápida à de uma espera longa por lock. */
const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Segundos: lag de Outbox vai de imediato a minutos sob backoff. */
const LAG_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 15, 30, 60, 300];

/**
 * Métricas em formato Prometheus.
 *
 * Cada instância tem seu **próprio** `Registry`, nunca o global do
 * `prom-client`: dois aplicativos no mesmo processo — o caso normal na suíte de
 * testes — colidiriam em "metric already registered" e vazariam contadores de
 * um teste para o outro.
 *
 * Todos os registros passam por `guard`. Observabilidade não pode derrubar um
 * caminho financeiro: se algo aqui falhar, a operação segue e a métrica é que
 * se perde, nunca o contrário.
 */
export class PrometheusMetrics extends MetricsPort {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transações de wagering por status terminal e transporte de entrada.',
    labelNames: ['status', 'transport'] as const,
    registers: [this.registry],
  });

  private readonly processing = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Latência do processamento de uma operação de wagering.',
    labelNames: ['transport'] as const,
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: 'wager_duplicates_total',
    help: 'Duplicatas detectadas, por nível de deduplicação.',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });

  private readonly permanent = new Counter({
    name: 'wager_messages_permanent_total',
    help: 'Mensagens classificadas como permanentemente inaproveitáveis, encaminhadas ao caminho de DLQ pelo redrive policy.',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: 'wager_retries_total',
    help: 'Retentativas efetivas, por componente.',
    labelNames: ['component'] as const,
    registers: [this.registry],
  });

  private readonly lockWait = new Histogram({
    name: 'wallet_lock_wait_seconds',
    help: 'Tempo até adquirir o lock pessimista de uma wallet. Contenção aparece como cauda alta, não como contagem.',
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });

  private readonly lockConflicts = new Counter({
    name: 'wallet_lock_conflicts_total',
    help: 'Erros de lock levantados pelo PostgreSQL (deadlock ou lock indisponível).',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  private readonly outboxLag = new Histogram({
    name: 'outbox_publish_lag_seconds',
    help: 'Idade do evento no instante da publicação: publicado_em menos ocorrido_em.',
    buckets: LAG_BUCKETS,
    registers: [this.registry],
  });

  private readonly outboxOldest = new Gauge({
    name: 'outbox_oldest_pending_age_seconds',
    help: 'Idade do evento pendente mais antigo observado no último ciclo do publisher; zero quando não há pendências.',
    registers: [this.registry],
  });

  private readonly divergences = new Counter({
    name: 'wallet_reconciliation_divergences_total',
    help: 'Reconciliações em que o saldo materializado divergiu do ledger.',
    registers: [this.registry],
  });

  /**
   * A aplicação não move mensagens para a DLQ — quem faz isso é o redrive
   * policy do SQS. Medir aqui seria inventar conhecimento que o processo não
   * tem, então o valor é lido do broker no instante do scrape.
   */
  private readonly dlqDepth: Gauge;

  private probe: DlqDepthProbe = () => Promise.resolve(undefined);

  constructor() {
    super();

    const read = (): Promise<number | undefined> => this.probe();

    this.dlqDepth = new Gauge({
      name: 'wager_dlq_messages',
      help: 'Mensagens aguardando na DLQ, consultadas no broker durante o scrape.',
      registers: [this.registry],
      async collect(): Promise<void> {
        const depth = await read().catch(() => undefined);

        if (depth === undefined) {
          // Sem resposta do broker não há amostra. Publicar zero afirmaria que
          // a DLQ está vazia sem ter olhado, que é pior do que não informar.
          this.remove();
          return;
        }

        this.set(depth);
      },
    });
  }

  /**
   * Liga a métrica ao broker.
   *
   * A ligação é feita pela mensageria, e não pelo construtor, para que a
   * observabilidade não precise conhecer o SQS — do contrário persistência,
   * mensageria e métricas ficariam em um ciclo de dependência entre módulos.
   */
  bindDlqProbe(probe: DlqDepthProbe): void {
    this.probe = probe;
  }

  /** Exposição no formato de texto do Prometheus. */
  async scrape(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  override recordWagerTransaction(
    status: WagerTransactionStatus,
    transport: WagerTransport,
  ): void {
    this.guard(() => {
      this.transactions.inc({ status, transport });
    });
  }

  override observeWagerProcessing(transport: WagerTransport, seconds: number): void {
    this.guard(() => {
      this.processing.observe({ transport }, seconds);
    });
  }

  override recordDuplicate(source: DuplicateSource): void {
    this.guard(() => {
      this.duplicates.inc({ source });
    });
  }

  override recordPermanentMessage(reason: PermanentMessageReason): void {
    this.guard(() => {
      this.permanent.inc({ reason });
    });
  }

  override recordRetry(component: RetryComponent): void {
    this.guard(() => {
      this.retries.inc({ component });
    });
  }

  override observeWalletLockWait(seconds: number): void {
    this.guard(() => {
      this.lockWait.observe(seconds);
    });
  }

  override recordLockConflict(reason: LockConflictReason): void {
    this.guard(() => {
      this.lockConflicts.inc({ reason });
    });
  }

  override observeOutboxPublishLag(seconds: number): void {
    this.guard(() => {
      this.outboxLag.observe(seconds);
    });
  }

  override setOutboxOldestPendingAge(seconds: number): void {
    this.guard(() => {
      this.outboxOldest.set(seconds);
    });
  }

  override recordReconciliationDivergence(): void {
    this.guard(() => {
      this.divergences.inc();
    });
  }

  private guard(record: () => void): void {
    try {
      record();
    } catch {
      // Uma métrica perdida é aceitável; interromper o caminho financeiro não é.
    }
  }
}
