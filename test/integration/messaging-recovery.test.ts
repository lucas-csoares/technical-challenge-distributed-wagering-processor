import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ExponentialPendingReferenceSchedule } from '../../src/application/pending-reference-schedule.js';
import { ResolvePendingReferencesUseCase } from '../../src/application/resolve-pending-references.use-case.js';
import { FailureCode } from '../../src/domain/shared/failure-code.js';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wagering/wager-transaction.js';
import { assertLedgerBalance } from './financial-repository-support.js';
import {
  createMessagingContext,
  purgeQueues,
  sendToWagerQueue,
  type MessagingContext,
} from './messaging-support.js';

/** Agenda de teste: sem espera real, e expira em duas tentativas. */
const IMMEDIATE_SCHEDULE = new ExponentialPendingReferenceSchedule({
  baseDelayMs: 0,
  maxDelayMs: 0,
  maxAttempts: 2,
});

let context: MessagingContext;

beforeAll(async () => {
  context = await createMessagingContext({ pendingReferenceSchedule: IMMEDIATE_SCHEDULE });
  await purgeQueues(context.options);
});

afterAll(async () => {
  await context.close();
});

function resolver(): ResolvePendingReferencesUseCase {
  return new ResolvePendingReferencesUseCase(
    context.manager,
    {},
    IMMEDIATE_SCHEDULE,
    context.metrics,
  );
}

async function openWallet(amount = '100.00') {
  const playerId = crypto.randomUUID();
  const result = await context.createWallet.execute({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });

  return { playerId, walletId: result.walletId };
}

function command(
  wallet: { walletId: string; playerId: string },
  overrides: Record<string, unknown> = {},
) {
  return {
    providerId: 'provider-recovery',
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-recovery',
    gameId: 'game-recovery',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  } as Parameters<typeof context.processWager.execute>[0];
}

describe('atomicidade da unidade transacional', () => {
  test('um erro antes do commit não deixa wallet, ledger nem Outbox alterados', async () => {
    const wallet = await openWallet();
    const failure = new Error('rollback before commit');

    let observed: unknown;

    try {
      await context.manager.execute(async (scope) => {
        const result = await context.processWager.executeInScope(scope, command(wallet), {
          correlationId: 'rollback-test',
        });

        expect(result.status).toBe(WagerTransactionStatus.Processed);

        // Tudo já foi escrito nesta transação; o erro reverte o conjunto.
        throw failure;
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBe(failure);

    const snapshot = await context.manager.execute(async (scope) => {
      const persisted = await scope.wallets.findById(wallet.walletId);
      const entries = await scope.ledger.findByWalletId(wallet.walletId);
      const events = await scope.outbox.findByAggregateId(wallet.walletId);

      return {
        balance: persisted?.balance.toString(),
        version: persisted?.version,
        debits: entries.filter((entry) => entry.direction === LedgerDirection.Debit).length,
        events: events.length,
      };
    });

    expect(snapshot.balance).toBe('100.00');
    expect(snapshot.version).toBe(1);
    expect(snapshot.debits).toBe(0);
    expect(snapshot.events).toBe(0);
  }, 60000);
});

describe('referência fora de ordem', () => {
  test('pendência é resolvida quando a referência chega, movimentando uma única vez', async () => {
    const wallet = await openWallet();
    const externalBet = crypto.randomUUID();

    const pending = await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: externalBet,
      }),
    );

    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);

    // A referência chega depois.
    await context.processWager.execute(command(wallet, { externalTransactionId: externalBet }));

    const report = await resolver().execute();

    expect(report.resolved).toBe(1);

    const resolved = await context.manager.execute((scope) =>
      scope.transactions.findById(pending.transactionId),
    );

    expect(resolved?.status).toBe(WagerTransactionStatus.Processed);

    const entries = await context.manager.execute((scope) =>
      scope.ledger.findByWalletId(wallet.walletId),
    );
    const refundEntries = entries.filter((entry) => entry.transactionId === pending.transactionId);

    expect(refundEntries).toHaveLength(1);
    expect(refundEntries[0]?.direction).toBe(LedgerDirection.Credit);

    const events = await context.manager.execute((scope) =>
      scope.outbox.findByAggregateId(pending.transactionId),
    );

    expect(events.map((event) => event.eventType)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
    ]);

    // Rodar de novo não reaplica nada.
    const second = await resolver().execute();
    expect(second.resolved).toBe(0);

    await context.manager.execute((scope) => assertLedgerBalance(scope, wallet.walletId));
  }, 60000);

  test('referência que nunca chega expira em REJECTED com código estável', async () => {
    const wallet = await openWallet();

    const pending = await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: crypto.randomUUID(),
      }),
    );

    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);

    // Duas tentativas sem referência esgotam a agenda de teste.
    await resolver().execute();
    const expiring = await resolver().execute();

    expect(expiring.rejected).toBe(1);

    const rejected = await context.manager.execute((scope) =>
      scope.transactions.findById(pending.transactionId),
    );

    expect(rejected?.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected?.failureCode).toBe(FailureCode.ReferenceNotFound);

    const events = await context.manager.execute((scope) =>
      scope.outbox.findByAggregateId(pending.transactionId),
    );

    expect(events.map((event) => event.eventType)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);

    const snapshot = await context.manager.execute((scope) =>
      scope.wallets.findById(wallet.walletId),
    );

    expect(snapshot?.balance.toString()).toBe('100.00');
  }, 60000);

  test('dois workers sobre a mesma pendência aplicam o efeito uma única vez', async () => {
    const wallet = await openWallet();
    const externalBet = crypto.randomUUID();

    const pending = await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: externalBet,
      }),
    );

    await context.processWager.execute(command(wallet, { externalTransactionId: externalBet }));

    const [first, second] = await Promise.all([resolver().execute(), resolver().execute()]);

    expect(first.resolved + second.resolved).toBe(1);

    const entries = await context.manager.execute((scope) =>
      scope.ledger.findByWalletId(wallet.walletId),
    );

    expect(entries.filter((entry) => entry.transactionId === pending.transactionId)).toHaveLength(1);
    await context.manager.execute((scope) => assertLedgerBalance(scope, wallet.walletId));
  }, 60000);

  test('o agendamento sobrevive a reinício porque vive na linha', async () => {
    const wallet = await openWallet();

    const pending = await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: crypto.randomUUID(),
      }),
    );

    await resolver().execute();

    const afterFirstAttempt = await context.manager.execute((scope) =>
      scope.transactions.findById(pending.transactionId),
    );

    // Um worker novo (outro processo, na prática) continua de onde parou.
    expect(afterFirstAttempt?.referenceAttempts).toBe(1);
    expect(afterFirstAttempt?.nextReferenceAttemptAt).toBeDefined();
  }, 60000);
});

describe('DLQ', () => {
  test('mensagem malformada não toca em dinheiro e chega à DLQ após o limite', async () => {
    const poison = { messageId: crypto.randomUUID(), body: JSON.stringify({ nonsense: true }) };

    await sendToWagerQueue(context, poison, 'poison-group');

    // `maxReceiveCount = 3`: são necessárias três entregas sem ACK, e cada uma
    // só volta depois do visibility timeout da fila. Esperar por ele é o que o
    // mecanismo real exige — encurtar aqui testaria outra coisa.
    let landedInDlq = false;
    const deadline = Date.now() + 90_000;

    while (!landedInDlq && Date.now() < deadline) {
      const report = await context.consumer.pollOnce(5, 5);

      // Uma poison message nunca recebe ACK.
      expect(report.acked).toBe(0);

      const dlq = await context.sqs.receive(context.options.dlqUrl, 5, 2);
      landedInDlq = dlq.some((message) => message.body === poison.body);
    }

    expect(landedInDlq).toBe(true);

    // Nenhuma transação financeira foi criada por uma mensagem sem forma.
    const inbox = await context.manager.execute((scope) =>
      scope.inbox.find('wager-transactions-test', poison.messageId),
    );

    expect(inbox).toBeUndefined();
  }, 120000);
});

describe('observabilidade do worker de referência', () => {
  function valueOf(exposition: string, series: string): number {
    const line = exposition.split('\n').find((entry) => entry.startsWith(`${series} `));

    return line === undefined ? 0 : Number.parseFloat(line.slice(series.length + 1));
  }

  test('adiamento conta retry e resolução conta transação do worker', async () => {
    const wallet = await openWallet();
    const externalBet = crypto.randomUUID();
    const retries = 'wager_retries_total{component="pending_reference"}';
    const processed = 'wager_transactions_total{status="PROCESSED",transport="pending_reference_worker"}';
    const before = await context.metrics.scrape();

    const pending = await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: externalBet,
      }),
    );

    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);

    // Primeiro ciclo: a referência ainda não existe, então a pendência é adiada.
    await resolver().execute();

    const afterReschedule = await context.metrics.scrape();
    expect(valueOf(afterReschedule, retries)).toBe(valueOf(before, retries) + 1);

    await context.processWager.execute(command(wallet, { externalTransactionId: externalBet }));
    await resolver().execute();

    const afterResolve = await context.metrics.scrape();
    expect(valueOf(afterResolve, processed)).toBe(valueOf(before, processed) + 1);
  }, 60000);
});
