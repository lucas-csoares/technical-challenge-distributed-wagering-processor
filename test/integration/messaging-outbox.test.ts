import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MessagePublisher } from '../../src/application/ports/message-publisher.js';
import { PublishOutboxUseCase } from '../../src/application/publish-outbox.use-case.js';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction.js';
import {
  createMessagingContext,
  purgeQueues,
  receiveEvents,
  type MessagingContext,
} from './messaging-support.js';

let context: MessagingContext;

beforeAll(async () => {
  context = await createMessagingContext();
  await purgeQueues(context.options);
});

afterAll(async () => {
  await context.close();
});

async function openWallet(amount = '100.00') {
  const playerId = crypto.randomUUID();
  const result = await context.createWallet.execute({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });

  return { playerId, walletId: result.walletId };
}

function command(wallet: { walletId: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-outbox',
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-outbox',
    gameId: 'game-outbox',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  } as Parameters<typeof context.processWager.execute>[0];
}

async function eventTypesFor(aggregateId: string): Promise<string[]> {
  const events = await context.manager.execute((scope) =>
    scope.outbox.findByAggregateId(aggregateId),
  );

  return events.map((event) => event.eventType);
}

describe('eventos mínimos gravados na Outbox', () => {
  test('BET processada gera processamento e mudança de saldo', async () => {
    const wallet = await openWallet();
    const result = await context.processWager.execute(command(wallet));

    expect(await eventTypesFor(result.transactionId)).toEqual(['WagerTransactionProcessed']);
    expect(await eventTypesFor(wallet.walletId)).toContain('WalletBalanceChanged');
  });

  test('WIN processada gera processamento e mudança de saldo', async () => {
    const wallet = await openWallet();
    const result = await context.processWager.execute(
      command(wallet, { kind: WagerTransactionKind.Win }),
    );

    expect(await eventTypesFor(result.transactionId)).toEqual(['WagerTransactionProcessed']);
    expect(await eventTypesFor(wallet.walletId)).toContain('WalletBalanceChanged');
  });

  test('LOSS gera processamento sem mudança de saldo', async () => {
    const wallet = await openWallet();
    const result = await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Loss,
        money: { amount: '0.00', currency: 'BRL' },
      }),
    );

    expect(await eventTypesFor(result.transactionId)).toEqual(['WagerTransactionProcessed']);
    // O saldo não mudou, então nenhum WalletBalanceChanged pode existir.
    expect(await eventTypesFor(wallet.walletId)).not.toContain('WalletBalanceChanged');
  });

  test('REFUND e ROLLBACK processados geram processamento e mudança de saldo', async () => {
    const wallet = await openWallet();
    const bet = await context.processWager.execute(
      command(wallet, { externalTransactionId: 'outbox-bet' }),
    );
    const refund = await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Refund,
        externalTransactionId: 'outbox-refund',
        referenceExternalTransactionId: 'outbox-bet',
      }),
    );
    const rollback = await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'outbox-refund',
      }),
    );

    expect(await eventTypesFor(bet.transactionId)).toEqual(['WagerTransactionProcessed']);
    expect(await eventTypesFor(refund.transactionId)).toEqual(['WagerTransactionProcessed']);
    expect(await eventTypesFor(rollback.transactionId)).toEqual(['WagerTransactionProcessed']);

    const walletEvents = await eventTypesFor(wallet.walletId);
    expect(walletEvents.filter((type) => type === 'WalletBalanceChanged')).toHaveLength(3);
  });

  test('REJECTED gera apenas o evento de rejeição', async () => {
    const wallet = await openWallet('10.00');
    const result = await context.processWager.execute(command(wallet));

    expect(await eventTypesFor(result.transactionId)).toEqual(['WagerTransactionRejected']);
    expect(await eventTypesFor(wallet.walletId)).not.toContain('WalletBalanceChanged');
  });

  test('PENDING_REFERENCE gera apenas o evento de pendência', async () => {
    const wallet = await openWallet();
    const result = await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'never-arrives',
      }),
    );

    expect(await eventTypesFor(result.transactionId)).toEqual([
      'WagerTransactionPendingReference',
    ]);
    expect(await eventTypesFor(wallet.walletId)).not.toContain('WalletBalanceChanged');
  });
});

describe('replay não duplica eventos', () => {
  test('50 duplicatas concorrentes produzem um débito e um par de eventos', async () => {
    const wallet = await openWallet();
    const input = command(wallet, {
      idempotencyKey: 'outbox-fifty',
      externalTransactionId: 'outbox-fifty',
    });

    const results = await Promise.all(
      Array.from({ length: 50 }, () => context.processWager.execute(input)),
    );

    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);

    const transactionId = results[0]?.transactionId ?? '';

    expect(await eventTypesFor(transactionId)).toEqual(['WagerTransactionProcessed']);

    const balanceEvents = (await eventTypesFor(wallet.walletId)).filter(
      (type) => type === 'WalletBalanceChanged',
    );

    // Um único débito, um único evento de mudança de saldo.
    expect(balanceEvents).toHaveLength(1);
  }, 60000);
});

describe('publicação da Outbox', () => {
  test('publica pendentes no SQS e marca published_at', async () => {
    const wallet = await openWallet();
    const result = await context.processWager.execute(command(wallet));

    const report = await context.publishOutbox.execute();

    expect(report.published).toBeGreaterThanOrEqual(2);
    expect(report.failed).toBe(0);

    const persisted = await context.manager.execute((scope) =>
      scope.outbox.findByAggregateId(result.transactionId),
    );

    expect(persisted[0]?.publishedAt).toBeDefined();

    // A linha permanece como evidência operacional, não é removida.
    expect(persisted).toHaveLength(1);

    const delivered = await receiveEvents(context, 10);
    expect(delivered.some((event) => event.eventType === 'WagerTransactionProcessed')).toBe(true);
  }, 60000);

  test('dois publishers concorrentes não perdem nem travam eventos', async () => {
    const wallet = await openWallet('1000.00');

    for (let index = 0; index < 6; index += 1) {
      await context.processWager.execute(command(wallet));
    }

    const pendingBefore = await context.manager.execute((scope) =>
      scope.outbox.claimPending(100, new Date()),
    );

    expect(pendingBefore.length).toBeGreaterThan(0);

    const [first, second] = await Promise.all([
      context.publishOutbox.execute(),
      context.publishOutbox.execute(),
    ]);

    const remaining = await context.manager.execute((scope) =>
      scope.outbox.claimPending(100, new Date()),
    );

    // Nada ficou pendente e nenhum publisher travou esperando o outro.
    expect(remaining).toHaveLength(0);
    expect(first.published + second.published).toBeGreaterThanOrEqual(pendingBefore.length);
  }, 60000);

  test('evento pendente após queda do publisher original é publicado por outro', async () => {
    const wallet = await openWallet();
    const result = await context.processWager.execute(command(wallet));

    // Publisher que falha ao enviar: a mensagem é reagendada, não perdida.
    const failing = new PublishOutboxUseCase(
      context.manager,
      new (class extends MessagePublisher {
        override publish(): Promise<void> {
          return Promise.reject(new Error('publisher crashed'));
        }
      })(),
      { batchSize: 20, baseDelayMs: 0, maxDelayMs: 0 },
    );

    const failedReport = await failing.execute();

    expect(failedReport.failed).toBeGreaterThanOrEqual(1);
    expect(failedReport.published).toBe(0);

    const stillPending = await context.manager.execute((scope) =>
      scope.outbox.findByAggregateId(result.transactionId),
    );

    expect(stillPending[0]?.publishedAt).toBeUndefined();
    expect(stillPending[0]?.attempts).toBeGreaterThanOrEqual(1);

    // Outro publisher assume e conclui o trabalho.
    const recovered = await context.publishOutbox.execute();

    expect(recovered.published).toBeGreaterThanOrEqual(1);

    const published = await context.manager.execute((scope) =>
      scope.outbox.findByAggregateId(result.transactionId),
    );

    expect(published[0]?.publishedAt).toBeDefined();
  }, 60000);

  test('o eventId é estável, então uma republicação é deduplicável', async () => {
    const wallet = await openWallet();
    const result = await context.processWager.execute(command(wallet));

    const before = await context.manager.execute((scope) =>
      scope.outbox.findByAggregateId(result.transactionId),
    );

    await context.publishOutbox.execute();

    const after = await context.manager.execute((scope) =>
      scope.outbox.findByAggregateId(result.transactionId),
    );

    // O identificador nasce na transação financeira e não muda na publicação:
    // é por ele que o consumidor deduplica uma entrega repetida.
    expect(after[0]?.id).toBe(before[0]?.id ?? '');
    expect(after[0]?.envelope.eventId).toBe(before[0]?.id ?? '');
  }, 60000);
});

describe('observabilidade da Outbox', () => {
  /** Valor de uma série pelo nome, sem depender da ordem do texto exposto. */
  function valueOf(exposition: string, series: string): number {
    const line = exposition.split('\n').find((entry) => entry.startsWith(`${series} `));

    return line === undefined ? 0 : Number.parseFloat(line.slice(series.length + 1));
  }

  test('o lag de publicação é medido e o pendente mais antigo é exposto', async () => {
    const wallet = await openWallet();

    await context.processWager.execute(command(wallet));

    const before = valueOf(await context.metrics.scrape(), 'outbox_publish_lag_seconds_count');
    const report = await context.publishOutbox.execute();

    expect(report.published).toBeGreaterThanOrEqual(2);

    const exposition = await context.metrics.scrape();

    // Um lag por evento publicado: a definição é publicado_em − ocorrido_em.
    expect(valueOf(exposition, 'outbox_publish_lag_seconds_count')).toBe(
      before + report.published,
    );
    expect(valueOf(exposition, 'outbox_oldest_pending_age_seconds')).toBeGreaterThan(0);
  }, 60000);

  test('sem pendências, a idade do mais antigo volta a zero', async () => {
    // Um ciclo vazio significa que não há atraso a reportar; manter o último
    // valor faria a métrica acusar um acúmulo que já foi drenado.
    await context.publishOutbox.execute();

    const exposition = await context.metrics.scrape();

    expect(valueOf(exposition, 'outbox_oldest_pending_age_seconds')).toBe(0);
  }, 60000);
});
