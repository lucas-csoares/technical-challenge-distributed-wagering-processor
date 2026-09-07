import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction.js';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction.js';
import { assertLedgerBalance } from './financial-repository-support.js';
import {
  createMessagingContext,
  purgeQueues,
  sendToWagerQueue,
  wagerMessage,
  type MessagingContext,
} from './messaging-support.js';

const CONSUMER_NAME = 'wager-transactions-multi';
const INSTANCES = 3;

let context: MessagingContext;

beforeAll(async () => {
  context = await createMessagingContext();
  await purgeQueues(context.options);
});

afterAll(async () => {
  await context.close();
});

interface InstanceReport {
  readonly pid: number;
  readonly received: number;
  readonly acked: number;
}

/**
 * Sobe instâncias de verdade, em processos separados, apontando para o mesmo
 * PostgreSQL e o mesmo SQS.
 *
 * O schema isolado do teste é repassado por argumento para que os processos
 * enxerguem exatamente os mesmos dados.
 */
async function runInstances(count: number): Promise<InstanceReport[]> {
  const processes = Array.from({ length: count }, () =>
    Bun.spawn(
      ['bun', 'run', 'test/integration/workers/wager-instance.ts', context.db.schema, CONSUMER_NAME, '8'],
      { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } },
    ),
  );

  const reports = await Promise.all(
    processes.map(async (child) => {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      if (exitCode !== 0) {
        throw new Error(`Instance failed (${String(exitCode)}): ${stderr}`);
      }

      const line = stdout.trim().split('\n').at(-1) ?? '{}';

      return JSON.parse(line) as InstanceReport;
    }),
  );

  // Processos distintos de verdade.
  expect(new Set(reports.map((report) => report.pid)).size).toBe(count);

  return reports;
}

async function openWallet(amount: string) {
  const playerId = crypto.randomUUID();
  const result = await context.createWallet.execute({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });

  return { playerId, walletId: result.walletId };
}

describe('três instâncias simultâneas sobre o mesmo PostgreSQL e SQS', () => {
  test('100 − 80 − 80 processadas por instâncias distintas deixam saldo 20 e um débito', async () => {
    const wallet = await openWallet('100.00');
    const bet = { amount: '80.00', currency: 'BRL' };

    for (let index = 0; index < 2; index += 1) {
      const message = wagerMessage({
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        overrides: { money: bet },
      });

      // Grupos FIFO distintos para que as duas fiquem disponíveis em paralelo:
      // a serialização que importa é a do lock da wallet, não a da fila.
      await sendToWagerQueue(context, message, `${wallet.walletId}-${String(index)}`);
    }

    const reports = await runInstances(INSTANCES);
    const acked = reports.reduce((total, report) => total + report.acked, 0);

    expect(acked).toBe(2);

    const snapshot = await context.manager.execute(async (scope) => {
      const persisted = await scope.wallets.findById(wallet.walletId);
      const entries = await scope.ledger.findByWalletId(wallet.walletId);

      return {
        balance: persisted?.balance.toString(),
        version: persisted?.version,
        debits: entries.filter((entry) => entry.direction === LedgerDirection.Debit),
      };
    });

    expect(snapshot.balance).toBe('20.00');
    expect(snapshot.version).toBe(2);
    expect(snapshot.debits).toHaveLength(1);
    expect(snapshot.debits[0]?.money.toString()).toBe('80.00');

    const transactions = await context.manager.execute(async (scope) => {
      const entries = await scope.ledger.findByWalletId(wallet.walletId);

      return entries.map((entry) => entry.transactionId);
    });

    expect(transactions).toHaveLength(2); // OPENING + o único débito.

    await context.manager.execute((scope) => assertLedgerBalance(scope, wallet.walletId));
  }, 180000);

  test('a mesma mensagem entregue a instâncias diferentes produz um único efeito', async () => {
    const wallet = await openWallet('100.00');
    const message = wagerMessage({ walletId: wallet.walletId, playerId: wallet.playerId });

    // A mesma identidade de transporte, enviada a grupos distintos: o SQS pode
    // entregá-la a instâncias diferentes, e a Inbox é quem impede o duplo efeito.
    await sendToWagerQueue(context, message, `${wallet.walletId}-a`);

    const reports = await runInstances(INSTANCES);

    expect(reports.reduce((total, report) => total + report.acked, 0)).toBeGreaterThanOrEqual(1);

    const snapshot = await context.manager.execute(async (scope) => {
      const persisted = await scope.wallets.findById(wallet.walletId);
      const entries = await scope.ledger.findByWalletId(wallet.walletId);

      return {
        balance: persisted?.balance.toString(),
        debits: entries.filter((entry) => entry.direction === LedgerDirection.Debit).length,
      };
    });

    expect(snapshot.balance).toBe('75.00');
    expect(snapshot.debits).toBe(1);

    const inbox = await context.manager.execute((scope) =>
      scope.inbox.find(CONSUMER_NAME, message.messageId),
    );

    expect(inbox).toBeDefined();
    await context.manager.execute((scope) => assertLedgerBalance(scope, wallet.walletId));
  }, 180000);

  test('estado persistido sobrevive ao encerramento das instâncias', async () => {
    const wallet = await openWallet('100.00');
    const message = wagerMessage({ walletId: wallet.walletId, playerId: wallet.playerId });

    await sendToWagerQueue(context, message, `${wallet.walletId}-restart`);
    await runInstances(1);

    // Os processos terminaram; nada do que garante consistência vivia neles.
    const afterShutdown = await context.manager.execute(async (scope) => {
      const persisted = await scope.wallets.findById(wallet.walletId);
      const inbox = await scope.inbox.find(CONSUMER_NAME, message.messageId);
      const pending = await scope.outbox.claimPending(50, new Date());

      return {
        balance: persisted?.balance.toString(),
        inboxProcessed: inbox?.processedAt !== undefined,
        pendingEvents: pending.length,
      };
    });

    expect(afterShutdown.balance).toBe('75.00');
    expect(afterShutdown.inboxProcessed).toBe(true);
    // Os eventos aguardam publicação: nada foi perdido com o fim do processo.
    expect(afterShutdown.pendingEvents).toBeGreaterThan(0);

    // Uma instância nova retoma o trabalho pendente da Outbox.
    const published = await context.publishOutbox.execute();

    expect(published.published).toBeGreaterThan(0);

    const transaction = await context.manager.execute((scope) =>
      scope.transactions.findByProviderAndIdempotencyKey(
        'provider-sqs',
        (JSON.parse(message.body) as { data: { idempotencyKey: string } }).data.idempotencyKey,
      ),
    );

    expect(transaction?.status).toBe(WagerTransactionStatus.Processed);
  }, 180000);
});
