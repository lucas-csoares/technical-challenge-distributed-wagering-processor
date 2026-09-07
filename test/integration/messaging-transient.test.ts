import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ConsumeWagerMessageUseCase } from '../../src/application/consume-wager-message.use-case.js';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case.js';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction.js';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction.js';
import { WagerSqsConsumer } from '../../src/infrastructure/messaging/sqs/wager-sqs-consumer.js';
import { assertLedgerBalance } from './financial-repository-support.js';
import { FailOnceAfterInboxRegister } from './messaging-seams.js';
import {
  CONSUMER_NAME,
  createMessagingContext,
  purgeQueues,
  sendToWagerQueue,
  wagerMessage,
  type MessagingContext,
} from './messaging-support.js';

/** Margem confortável sobre o visibility timeout real da fila de teste. */
const REDELIVERY_DEADLINE_MS = 90_000;

let context: MessagingContext;

beforeAll(async () => {
  context = await createMessagingContext();
  await purgeQueues(context.options);
});

afterAll(async () => {
  await context.close();
});

/**
 * Um consumidor idêntico ao da aplicação, exceto pela fronteira transacional
 * instrumentada: a falha é injetada na infraestrutura, e o caminho percorrido
 * — receive, parsing, caso de uso, transação, rollback, ausência de `ACK` — é o
 * de produção.
 */
function consumerThatFailsOnce(seam: FailOnceAfterInboxRegister): WagerSqsConsumer {
  const consume = new ConsumeWagerMessageUseCase(
    seam,
    new ProcessWagerTransactionUseCase(seam, {}),
    CONSUMER_NAME,
  );

  return new WagerSqsConsumer(context.sqs, consume, context.options);
}

/** Observa a reentrega sem processá-la, só para ler o contador do SQS. */
async function waitForRedelivery(body: string): Promise<number> {
  const deadline = Date.now() + REDELIVERY_DEADLINE_MS;

  while (Date.now() < deadline) {
    const messages = await context.sqs.receive(context.options.wagerQueueUrl, 10, 5);
    const again = messages.find((message) => message.body === body);

    if (again !== undefined) {
      return again.receiveCount;
    }
  }

  return 0;
}

async function pollUntilAcked(): Promise<number> {
  const deadline = Date.now() + REDELIVERY_DEADLINE_MS;

  while (Date.now() < deadline) {
    const report = await context.consumer.pollOnce(5, 5);

    if (report.acked > 0) {
      return report.acked;
    }
  }

  return 0;
}

describe('falha transitória durante o consumo', () => {
  test('sem ACK, a reentrega conclui e o efeito financeiro acontece uma única vez', async () => {
    const playerId = crypto.randomUUID();
    const created = await context.createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const walletId = created.walletId;
    const message = wagerMessage({ walletId, playerId });

    await sendToWagerQueue(context, message, walletId);

    const seam = new FailOnceAfterInboxRegister(context.manager);
    const failing = consumerThatFailsOnce(seam);

    // Primeira entrega: a unidade de trabalho escreve tudo e aborta antes do
    // commit, exatamente como uma indisponibilidade do banco faria.
    const firstAttempt = await failing.pollOnce(5, 5);

    expect(firstAttempt.received).toBeGreaterThanOrEqual(1);
    expect(firstAttempt.acked).toBe(0);
    expect(firstAttempt.retried).toBeGreaterThanOrEqual(1);
    expect(seam.failures).toBe(1);

    // O rollback não deixou meio efeito em lugar nenhum.
    const afterFailure = await context.manager.execute(async (scope) => {
      const wallet = await scope.wallets.findById(walletId);
      const entries = await scope.ledger.findByWalletId(walletId);

      return {
        balance: wallet?.balance.toString(),
        version: wallet?.version,
        debits: entries.filter((entry) => entry.direction === LedgerDirection.Debit).length,
        inbox: await scope.inbox.find(CONSUMER_NAME, message.messageId),
        events: (await scope.outbox.findByAggregateId(walletId)).length,
      };
    });

    expect(afterFailure.balance).toBe('100.00');
    expect(afterFailure.version).toBe(1);
    expect(afterFailure.debits).toBe(0);
    expect(afterFailure.inbox).toBeUndefined();
    expect(afterFailure.events).toBe(0);

    // A mensagem voltou: um `ACK` a teria removido da fila para sempre. O
    // contador de entregas do próprio SQS é a prova, não um log.
    const receiveCount = await waitForRedelivery(message.body);

    expect(receiveCount).toBeGreaterThanOrEqual(2);

    // Segunda tentativa, agora pelo caminho saudável.
    expect(await pollUntilAcked()).toBe(1);

    const afterRetry = await context.manager.execute(async (scope) => {
      const wallet = await scope.wallets.findById(walletId);
      const entries = await scope.ledger.findByWalletId(walletId);
      const debits = entries.filter((entry) => entry.direction === LedgerDirection.Debit);
      const transaction = await scope.transactions.findByProviderAndIdempotencyKey(
        'provider-sqs',
        (JSON.parse(message.body) as { data: { idempotencyKey: string } }).data.idempotencyKey,
      );

      return {
        balance: wallet?.balance.toString(),
        version: wallet?.version,
        debits,
        inbox: await scope.inbox.find(CONSUMER_NAME, message.messageId),
        status: transaction?.status,
        events: await scope.outbox.findByAggregateId(transaction?.id ?? ''),
      };
    });

    expect(afterRetry.balance).toBe('75.00');
    expect(afterRetry.version).toBe(2);
    expect(afterRetry.debits).toHaveLength(1);
    expect(afterRetry.debits[0]?.money.toString()).toBe('25.00');
    expect(afterRetry.inbox?.processedAt).toBeDefined();
    expect(afterRetry.status).toBe(WagerTransactionStatus.Processed);
    expect(afterRetry.events.map((event) => event.eventType)).toEqual([
      'WagerTransactionProcessed',
    ]);

    // A falha foi injetada uma única vez: a conclusão veio do caminho real.
    expect(seam.failures).toBe(1);
    await context.manager.execute((scope) => assertLedgerBalance(scope, walletId));
  }, 240000);
});
