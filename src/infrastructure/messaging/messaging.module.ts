import {
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConsumeWagerMessageUseCase } from '../../application/consume-wager-message.use-case.js';
import { MessagePublisher } from '../../application/ports/message-publisher.js';
import { FinancialTransactionManager } from '../../application/ports/financial-transaction-manager.js';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.use-case.js';
import {
  PublishOutboxUseCase,
  defaultOutboxPublishOptions,
} from '../../application/publish-outbox.use-case.js';
import { defaultPendingReferenceSchedule } from '../../application/pending-reference-schedule.js';
import { ResolvePendingReferencesUseCase } from '../../application/resolve-pending-references.use-case.js';
import { MetricsPort } from '../../application/ports/metrics.js';
import { FinancialApplicationModule } from '../financial-application.module.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { PrometheusMetrics } from '../observability/prometheus-metrics.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { BackgroundWorker } from './background-worker.js';
import { createMessagingOptions, type MessagingOptions } from './messaging.config.js';
import { SqsClientAdapter } from './sqs/sqs-client.js';
import { SqsMessagePublisher } from './sqs/sqs-message-publisher.js';
import { WagerSqsConsumer } from './sqs/wager-sqs-consumer.js';

export const MESSAGING_OPTIONS = Symbol('MESSAGING_OPTIONS');
export const WAGER_CONSUMER_NAME = 'wager-transactions';

/** Nomes dos workers, para que o shutdown os encontre sem string solta. */
const WORKERS = Symbol('MESSAGING_WORKERS');

/**
 * Composição da mensageria.
 *
 * Os workers só sobem quando `MESSAGING_WORKERS_ENABLED` está ligado. Os testes
 * de integração dirigem consumidor e publisher explicitamente, um ciclo por
 * vez, o que os torna determinísticos — um laço de fundo competindo com as
 * asserções produziria falhas intermitentes que não dizem nada sobre o sistema.
 */
@Module({
  imports: [PersistenceModule, FinancialApplicationModule, ObservabilityModule],
  providers: [
    { provide: MESSAGING_OPTIONS, useFactory: (): MessagingOptions => createMessagingOptions() },
    {
      provide: SqsClientAdapter,
      inject: [MESSAGING_OPTIONS],
      useFactory: (options: MessagingOptions) => new SqsClientAdapter(options),
    },
    {
      provide: MessagePublisher,
      inject: [SqsClientAdapter, MESSAGING_OPTIONS],
      useFactory: (sqs: SqsClientAdapter, options: MessagingOptions) =>
        new SqsMessagePublisher(sqs, options),
    },
    {
      provide: ConsumeWagerMessageUseCase,
      inject: [FinancialTransactionManager, ProcessWagerTransactionUseCase],
      useFactory: (
        transactions: FinancialTransactionManager,
        processWager: ProcessWagerTransactionUseCase,
      ) => new ConsumeWagerMessageUseCase(transactions, processWager, WAGER_CONSUMER_NAME),
    },
    {
      provide: WagerSqsConsumer,
      inject: [SqsClientAdapter, ConsumeWagerMessageUseCase, MESSAGING_OPTIONS, MetricsPort],
      useFactory: (
        sqs: SqsClientAdapter,
        consume: ConsumeWagerMessageUseCase,
        options: MessagingOptions,
        metrics: MetricsPort,
      ) => new WagerSqsConsumer(sqs, consume, options, metrics),
    },
    {
      provide: PublishOutboxUseCase,
      inject: [FinancialTransactionManager, MessagePublisher, MetricsPort],
      useFactory: (
        transactions: FinancialTransactionManager,
        publisher: MessagePublisher,
        metrics: MetricsPort,
      ) =>
        new PublishOutboxUseCase(
          transactions,
          publisher,
          defaultOutboxPublishOptions,
          () => new Date(),
          metrics,
        ),
    },
    {
      provide: ResolvePendingReferencesUseCase,
      inject: [FinancialTransactionManager, MetricsPort],
      useFactory: (transactions: FinancialTransactionManager, metrics: MetricsPort) =>
        new ResolvePendingReferencesUseCase(
          transactions,
          {},
          defaultPendingReferenceSchedule,
          metrics,
        ),
    },
    {
      provide: WORKERS,
      inject: [WagerSqsConsumer, PublishOutboxUseCase, ResolvePendingReferencesUseCase],
      useFactory: (
        consumer: WagerSqsConsumer,
        outbox: PublishOutboxUseCase,
        pending: ResolvePendingReferencesUseCase,
      ): BackgroundWorker[] => [
        new BackgroundWorker({ name: 'WagerSqsConsumer', intervalMs: 200 }, async () => {
          await consumer.pollOnce();
        }),
        new BackgroundWorker({ name: 'OutboxPublisher', intervalMs: 500 }, async () => {
          await outbox.execute();
        }),
        new BackgroundWorker({ name: 'PendingReferenceWorker', intervalMs: 2_000 }, async () => {
          await pending.execute();
        }),
      ],
    },
  ],
  exports: [
    SqsClientAdapter,
    WagerSqsConsumer,
    PublishOutboxUseCase,
    ResolvePendingReferencesUseCase,
    ConsumeWagerMessageUseCase,
    MessagePublisher,
    MESSAGING_OPTIONS,
  ],
})
export class MessagingModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MessagingModule.name);

  constructor(
    @Inject(WORKERS) private readonly workers: BackgroundWorker[],
    private readonly sqs: SqsClientAdapter,
    private readonly metrics: PrometheusMetrics,
  ) {}

  onModuleInit(): void {
    // A profundidade da DLQ é do broker, não do processo: a métrica pergunta a
    // ele no scrape em vez de a aplicação fingir que sabe.
    this.metrics.bindDlqProbe(() => this.sqs.dlqDepth());

    if (process.env.MESSAGING_WORKERS_ENABLED !== 'true') {
      this.logger.log({ event: 'messaging.workers.disabled' });

      return;
    }

    for (const worker of this.workers) {
      worker.start();
    }

    this.logger.log({
      event: 'messaging.workers.started',
      workers: this.workers.map((worker) => worker.name),
    });
  }

  /**
   * Em `SIGTERM`, os workers param de adquirir trabalho novo e o ciclo em
   * andamento é concluído. O que não tiver recebido `ACK` volta pela
   * visibilidade do SQS, e o que já commitou está seguro pela Inbox.
   */
  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.stop()));
    this.sqs.close();
    this.logger.log({ event: 'messaging.workers.stopped' });
  }
}
