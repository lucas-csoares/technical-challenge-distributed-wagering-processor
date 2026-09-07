import { PurgeQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import { ConsumeWagerMessageUseCase } from '../../src/application/consume-wager-message.use-case.js';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case.js';
import { PublishOutboxUseCase } from '../../src/application/publish-outbox.use-case.js';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case.js';
import type { PendingReferenceSchedule } from '../../src/application/pending-reference-schedule.js';
import { createMessagingOptions, type MessagingOptions } from '../../src/infrastructure/messaging/messaging.config.js';
import { SqsClientAdapter } from '../../src/infrastructure/messaging/sqs/sqs-client.js';
import { SqsMessagePublisher } from '../../src/infrastructure/messaging/sqs/sqs-message-publisher.js';
import { WagerSqsConsumer } from '../../src/infrastructure/messaging/sqs/wager-sqs-consumer.js';
import { defaultOutboxPublishOptions } from '../../src/application/publish-outbox.use-case.js';
import { PrometheusMetrics } from '../../src/infrastructure/observability/prometheus-metrics.js';
import { MikroOrmFinancialTransactionManager } from '../../src/infrastructure/persistence/mikro-orm-financial-transaction-manager.js';
import { createFinancialSchema, type FinancialSchema } from './support.js';

export const CONSUMER_NAME = 'wager-transactions-test';

export interface MessagingContext {
  readonly db: FinancialSchema;
  readonly manager: MikroOrmFinancialTransactionManager;
  readonly options: MessagingOptions;
  readonly sqs: SqsClientAdapter;
  readonly createWallet: CreateWalletUseCase;
  readonly processWager: ProcessWagerTransactionUseCase;
  readonly consume: ConsumeWagerMessageUseCase;
  readonly consumer: WagerSqsConsumer;
  readonly publishOutbox: PublishOutboxUseCase;
  readonly metrics: PrometheusMetrics;
  close(): Promise<void>;
}

export interface MessagingContextOptions {
  readonly pendingReferenceSchedule?: PendingReferenceSchedule;
}

/**
 * Monta o mesmo grafo de objetos que a aplicação usa, sobre um schema isolado
 * e o LocalStack de testes.
 *
 * Os workers não são iniciados: cada teste dirige consumidor, publisher e
 * resolver um ciclo por vez. Um laço de fundo competindo com as asserções
 * produziria falhas intermitentes que não diriam nada sobre o sistema.
 */
export async function createMessagingContext(
  contextOptions: MessagingContextOptions = {},
): Promise<MessagingContext> {
  const db = await createFinancialSchema();
  const metrics = new PrometheusMetrics();
  const manager = new MikroOrmFinancialTransactionManager(db.orm, metrics);
  const options = createMessagingOptions();
  const sqs = new SqsClientAdapter(options);
  const processWager = new ProcessWagerTransactionUseCase(
    manager,
    {},
    contextOptions.pendingReferenceSchedule,
  );
  const consume = new ConsumeWagerMessageUseCase(manager, processWager, CONSUMER_NAME);

  return {
    db,
    manager,
    options,
    sqs,
    createWallet: new CreateWalletUseCase(manager),
    processWager,
    consume,
    metrics,
    consumer: new WagerSqsConsumer(sqs, consume, options, metrics),
    publishOutbox: new PublishOutboxUseCase(
      manager,
      new SqsMessagePublisher(sqs, options),
      defaultOutboxPublishOptions,
      () => new Date(),
      metrics,
    ),
    close: async () => {
      sqs.close();
      await db.close();
    },
  };
}

export interface WagerMessageOptions {
  readonly messageId?: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly overrides?: Record<string, unknown>;
}

export function wagerMessage(options: WagerMessageOptions): {
  messageId: string;
  body: string;
} {
  const messageId = options.messageId ?? crypto.randomUUID();
  const envelope = {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-sqs',
      externalTransactionId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      playerId: options.playerId,
      walletId: options.walletId,
      roundId: 'round-sqs',
      gameId: 'game-sqs',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...options.overrides,
    },
  };

  return { messageId, body: JSON.stringify(envelope) };
}

/** Envia direto pelo cliente, como um provedor externo faria. */
export async function sendToWagerQueue(
  context: MessagingContext,
  message: { messageId: string; body: string },
  groupId = 'test-group',
): Promise<void> {
  await context.sqs.send({
    queueUrl: context.options.wagerQueueUrl,
    body: message.body,
    groupId,
    deduplicationId: message.messageId,
  });
}

/**
 * Esvazia as filas para que um teste não observe mensagens de outro.
 *
 * `PurgeQueue` é limitado a uma chamada por minuto no SQS real; aqui roda
 * contra o LocalStack, onde é imediato.
 */
export async function purgeQueues(options: MessagingOptions): Promise<void> {
  const client = new SQSClient({
    region: options.region,
    endpoint: options.endpoint,
    credentials: options.credentials,
  });

  try {
    for (const queueUrl of [options.wagerQueueUrl, options.dlqUrl, options.eventsQueueUrl]) {
      await client.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
    }
  } finally {
    client.destroy();
  }
}

export async function receiveEvents(
  context: MessagingContext,
  max = 10,
): Promise<{ eventType: string; eventId: string; aggregateId: string; data: Record<string, unknown> }[]> {
  const messages = await context.sqs.receive(context.options.eventsQueueUrl, max, 1);

  return messages.map((message) => {
    const parsed = JSON.parse(message.body) as {
      eventType: string;
      eventId: string;
      aggregateId: string;
      data: Record<string, unknown>;
    };

    return parsed;
  });
}
