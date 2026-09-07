import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { ConsoleLogger, Logger, type LoggerService } from '@nestjs/common';
import type { ConsumeWagerMessageUseCase } from '../../src/application/consume-wager-message.use-case.js';
import { PrometheusMetrics } from '../../src/infrastructure/observability/prometheus-metrics.js';
import type { MessagingOptions } from '../../src/infrastructure/messaging/messaging.config.js';
import type { SqsClientAdapter } from '../../src/infrastructure/messaging/sqs/sqs-client.js';
import { WagerSqsConsumer } from '../../src/infrastructure/messaging/sqs/wager-sqs-consumer.js';
import { FinancialPersistenceError } from '../../src/application/ports/persistence-error.js';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction.js';

interface CapturedLog {
  readonly level: 'log' | 'warn' | 'error';
  readonly payload: unknown;
}

/**
 * Sink de log em memória.
 *
 * Assertar sobre o objeto que o código emite é mais estável do que inspecionar
 * bytes em `stdout`, e é exatamente o que um coletor JSON receberia.
 */
class LogSink implements LoggerService {
  readonly records: CapturedLog[] = [];

  log(message: unknown): void {
    this.records.push({ level: 'log', payload: message });
  }

  warn(message: unknown): void {
    this.records.push({ level: 'warn', payload: message });
  }

  error(message: unknown): void {
    this.records.push({ level: 'error', payload: message });
  }

  entries(event: string): Record<string, unknown>[] {
    return this.records
      .map((record) => record.payload)
      .filter(
        (payload): payload is Record<string, unknown> =>
          typeof payload === 'object' && payload !== null && 'event' in payload,
      )
      .filter((payload) => payload.event === event);
  }
}

const OPTIONS: MessagingOptions = {
  region: 'us-east-1',
  endpoint: 'http://127.0.0.1:4567',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  wagerQueueUrl: 'http://localhost/wager',
  dlqUrl: 'http://localhost/dlq',
  eventsQueueUrl: 'http://localhost/events',
};

const MONEY = { amount: '25.00', currency: 'BRL' };

function envelopeBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    messageId: 'msg-1',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-09-07T12:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'key-1',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: MONEY,
      ...overrides,
    },
  });
}

/**
 * Só o que o consumidor usa do cliente: uma entrega e o `ACK`.
 *
 * O comportamento real do SQS é exercitado contra LocalStack nos testes de
 * integração; aqui o alvo é o que o adaptador registra, e um cliente de verdade
 * só acrescentaria latência de rede à asserção.
 */
function sqsWith(body: string): { client: SqsClientAdapter; deleted: string[] } {
  const deleted: string[] = [];
  let delivered = false;

  const client = {
    receive: () => {
      if (delivered) {
        return Promise.resolve([]);
      }

      delivered = true;

      return Promise.resolve([
        { messageId: 'sqs-1', receiptHandle: 'receipt-1', body, receiveCount: 1 },
      ]);
    },
    deleteMessage: (_queueUrl: string, receiptHandle: string) => {
      deleted.push(receiptHandle);

      return Promise.resolve();
    },
  } as unknown as SqsClientAdapter;

  return { client, deleted };
}

function consumerFor(
  body: string,
  outcome: () => Promise<unknown>,
  metrics: PrometheusMetrics,
): { consumer: WagerSqsConsumer; deleted: string[] } {
  const { client, deleted } = sqsWith(body);
  const consume = { execute: outcome } as unknown as ConsumeWagerMessageUseCase;

  return { consumer: new WagerSqsConsumer(client, consume, OPTIONS, metrics), deleted };
}

const sink = new LogSink();

beforeEach(() => {
  sink.records.length = 0;
  Logger.overrideLogger(sink);
});

afterAll(() => {
  Logger.overrideLogger(new ConsoleLogger({ json: true }));
});

describe('logs estruturados do consumo', () => {
  test('uma operação processada produz um evento com identidade e desfecho', async () => {
    const metrics = new PrometheusMetrics();
    const { consumer, deleted } = consumerFor(
      envelopeBody(),
      () =>
        Promise.resolve({
          kind: 'processed',
          result: {
            transactionId: 'tx-1',
            status: WagerTransactionStatus.Processed,
            balance: { amount: '75.00', currency: 'BRL' },
            idempotentReplay: false,
          },
        }),
      metrics,
    );

    await consumer.pollOnce();

    const [entry] = sink.entries('wager.processed');

    expect(entry).toBeDefined();
    // A identidade logada é a da Inbox — a do envelope —, não a do transporte.
    expect(entry?.messageId).toBe('msg-1');
    expect(entry?.correlationId).toBe('provider-a:key-1');
    expect(entry?.providerId).toBe('provider-a');
    expect(entry?.walletId).toBe('wallet-1');
    expect(entry?.transactionId).toBe('tx-1');
    expect(entry?.status).toBe(WagerTransactionStatus.Processed);
    expect(deleted).toEqual(['receipt-1']);
  });

  test('nenhum log carrega valor monetário nem o corpo da mensagem', async () => {
    const metrics = new PrometheusMetrics();
    const body = envelopeBody();
    const { consumer } = consumerFor(
      body,
      () =>
        Promise.resolve({
          kind: 'processed',
          result: {
            transactionId: 'tx-1',
            status: WagerTransactionStatus.Processed,
            balance: { amount: '75.00', currency: 'BRL' },
            idempotentReplay: false,
          },
        }),
      metrics,
    );

    await consumer.pollOnce();

    const serialized = JSON.stringify(sink.records);

    // Diagnóstico precisa saber *qual* operação, não *quanto* ela movimentou.
    expect(serialized).not.toContain('25.00');
    expect(serialized).not.toContain('75.00');
    expect(serialized).not.toContain('WagerTransactionRequested');
    expect(serialized).not.toContain(body);
  });

  test('duplicata e conflito de payload são eventos distintos', async () => {
    const metrics = new PrometheusMetrics();
    const duplicate = consumerFor(
      envelopeBody(),
      () => Promise.resolve({ kind: 'duplicate' }),
      metrics,
    );

    await duplicate.consumer.pollOnce();

    expect(sink.entries('inbox.duplicate')).toHaveLength(1);
    expect(duplicate.deleted).toEqual(['receipt-1']);

    sink.records.length = 0;

    const conflict = consumerFor(
      envelopeBody(),
      () => Promise.resolve({ kind: 'payload-conflict' }),
      metrics,
    );

    await conflict.consumer.pollOnce();

    expect(sink.entries('inbox.payload_conflict')).toHaveLength(1);
    // Conflito não recebe `ACK`: segue para a DLQ pelo redrive policy.
    expect(conflict.deleted).toEqual([]);
  });

  test('mensagem malformada é registrada sem chegar ao caso de uso', async () => {
    const metrics = new PrometheusMetrics();
    const { consumer, deleted } = consumerFor(
      '{"nonsense":true}',
      () => Promise.reject(new Error('the use case must not be reached')),
      metrics,
    );

    await consumer.pollOnce();

    const [entry] = sink.entries('wager.message.malformed');

    expect(entry?.messageId).toBe('sqs-1');
    expect(entry?.receiveCount).toBe(1);
    expect(deleted).toEqual([]);
  });

  test('falha transitória é registrada como tal, com a mensagem sem ACK', async () => {
    const metrics = new PrometheusMetrics();
    const { consumer, deleted } = consumerFor(
      envelopeBody(),
      () => Promise.reject(new FinancialPersistenceError(new Error('db down'))),
      metrics,
    );

    await consumer.pollOnce();

    const [entry] = sink.entries('wager.message.failed');

    expect(entry?.transient).toBe(true);
    expect(entry?.correlationId).toBe('provider-a:key-1');
    expect(deleted).toEqual([]);
  });
});

describe('métricas do consumo', () => {
  async function expositionAfter(outcome: () => Promise<unknown>, body = envelopeBody()) {
    const metrics = new PrometheusMetrics();
    const { consumer } = consumerFor(body, outcome, metrics);

    await consumer.pollOnce();

    return metrics.scrape();
  }

  test('processada conta status, transporte e latência', async () => {
    const exposition = await expositionAfter(() =>
      Promise.resolve({
        kind: 'processed',
        result: {
          transactionId: 'tx-1',
          status: WagerTransactionStatus.Processed,
          balance: { amount: '75.00', currency: 'BRL' },
          idempotentReplay: false,
        },
      }),
    );

    expect(exposition).toContain('wager_transactions_total{status="PROCESSED",transport="sqs"} 1');
    expect(exposition).toContain('wager_processing_duration_seconds_count{transport="sqs"} 1');
  });

  test('replay financeiro conta como duplicata do nível financeiro', async () => {
    const exposition = await expositionAfter(() =>
      Promise.resolve({
        kind: 'processed',
        result: {
          transactionId: 'tx-1',
          status: WagerTransactionStatus.Processed,
          balance: { amount: '75.00', currency: 'BRL' },
          idempotentReplay: true,
        },
      }),
    );

    expect(exposition).toContain('wager_duplicates_total{source="financial_idempotency"} 1');
  });

  test('redelivery conta como duplicata de transporte', async () => {
    const exposition = await expositionAfter(() => Promise.resolve({ kind: 'duplicate' }));

    expect(exposition).toContain('wager_duplicates_total{source="inbox_redelivery"} 1');
  });

  test('conflito de payload e mensagem malformada contam como permanentes', async () => {
    const conflict = await expositionAfter(() => Promise.resolve({ kind: 'payload-conflict' }));
    const malformed = await expositionAfter(
      () => Promise.reject(new Error('unreachable')),
      '{"nonsense":true}',
    );

    expect(conflict).toContain('wager_messages_permanent_total{reason="payload_conflict"} 1');
    expect(malformed).toContain('wager_messages_permanent_total{reason="malformed"} 1');
  });

  test('falha que devolve a mensagem à fila conta como retry do consumidor', async () => {
    const exposition = await expositionAfter(() =>
      Promise.reject(new FinancialPersistenceError(new Error('db down'))),
    );

    expect(exposition).toContain('wager_retries_total{component="sqs_consumer"} 1');
  });
});
