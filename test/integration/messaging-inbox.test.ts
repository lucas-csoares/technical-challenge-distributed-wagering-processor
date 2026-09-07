import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  ConsumeWagerMessageUseCase,
  hashMessagePayload,
} from '../../src/application/consume-wager-message.use-case.js';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case.js';
import { FailureCode } from '../../src/domain/shared/failure-code.js';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction.js';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction.js';
import { assertLedgerBalance } from './financial-repository-support.js';
import { Barrier, InboxRaceManager } from './messaging-seams.js';
import {
  CONSUMER_NAME,
  createMessagingContext,
  purgeQueues,
  sendToWagerQueue,
  wagerMessage,
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

async function readWallet(walletId: string) {
  return context.manager.execute(async (scope) => {
    const wallet = await scope.wallets.findById(walletId);

    if (wallet === undefined) {
      throw new Error('Expected wallet.');
    }

    return { balance: wallet.balance.toString(), version: wallet.version };
  });
}

async function ledgerOf(walletId: string) {
  return context.manager.execute((scope) => scope.ledger.findByWalletId(walletId));
}

describe('SQS → caso de uso financeiro', () => {
  test('mensagem real percorre fila, Inbox, ledger e recebe ACK', async () => {
    const wallet = await openWallet('100.00');
    const message = wagerMessage({ walletId: wallet.walletId, playerId: wallet.playerId });

    await sendToWagerQueue(context, message, wallet.walletId);

    const report = await context.consumer.pollOnce(5, 3);

    expect(report.received).toBeGreaterThanOrEqual(1);
    expect(report.acked).toBeGreaterThanOrEqual(1);
    expect(report.retried).toBe(0);

    const snapshot = await readWallet(wallet.walletId);

    expect(snapshot.balance).toBe('75.00');
    expect(snapshot.version).toBe(2);

    // O mesmo núcleo financeiro do HTTP produziu o lançamento.
    const entries = await ledgerOf(wallet.walletId);
    const debits = entries.filter((entry) => entry.direction === LedgerDirection.Debit);

    expect(debits).toHaveLength(1);
    expect(debits[0]?.money.toString()).toBe('25.00');

    // Inbox registrada e marcada como processada, na mesma transação.
    const inbox = await context.manager.execute((scope) =>
      scope.inbox.find(CONSUMER_NAME, message.messageId),
    );

    expect(inbox).toBeDefined();
    expect(inbox?.processedAt).toBeDefined();

    // ACK ocorreu: a fila não reentrega a mensagem.
    const afterAck = await context.consumer.pollOnce(5, 1);
    expect(afterAck.received).toBe(0);
  }, 60000);

  test('rejeição de negócio é terminal, recebe ACK e não move saldo', async () => {
    const wallet = await openWallet('10.00');
    const message = wagerMessage({ walletId: wallet.walletId, playerId: wallet.playerId });

    await sendToWagerQueue(context, message, wallet.walletId);

    const report = await context.consumer.pollOnce(5, 3);

    expect(report.acked).toBeGreaterThanOrEqual(1);

    const transaction = await context.manager.execute((scope) =>
      scope.transactions.findByProviderAndIdempotencyKey(
        'provider-sqs',
        (JSON.parse(message.body) as { data: { idempotencyKey: string } }).data.idempotencyKey,
      ),
    );

    expect(transaction?.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction?.failureCode).toBe(FailureCode.InsufficientFunds);

    const snapshot = await readWallet(wallet.walletId);

    expect(snapshot.balance).toBe('10.00');
    expect(snapshot.version).toBe(1);

    const entries = await ledgerOf(wallet.walletId);
    expect(entries.filter((entry) => entry.transactionId === transaction?.id)).toHaveLength(0);

    // Um evento de rejeição foi gravado na Outbox, na mesma transação.
    const events = await context.manager.execute((scope) =>
      scope.outbox.findByAggregateId(transaction?.id ?? ''),
    );

    expect(events.map((event) => event.eventType)).toEqual(['WagerTransactionRejected']);
  }, 60000);
});

describe('Inbox e redelivery', () => {
  test('crash depois do commit e antes do ACK não duplica efeito', async () => {
    const wallet = await openWallet('100.00');
    const message = wagerMessage({ walletId: wallet.walletId, playerId: wallet.playerId });

    // Primeira entrega: processa e commita, mas o processo "morre" antes do
    // ACK — o consumo é executado direto, sem passar pelo delete da fila.
    await sendToWagerQueue(context, message, wallet.walletId);

    const received = await context.sqs.receive(context.options.wagerQueueUrl, 5, 3);
    const delivered = received.find((item) => item.body === message.body);

    if (delivered === undefined) {
      throw new Error('Expected the message to be delivered.');
    }

    const first = await context.consume.execute(
      JSON.parse(message.body) as never,
      message.body,
    );

    expect(first.kind).toBe('processed');

    const afterCommit = await readWallet(wallet.walletId);
    expect(afterCommit.balance).toBe('75.00');

    // Sem ACK, o SQS reentrega depois do visibility timeout.
    const redelivered = await context.consume.execute(
      JSON.parse(message.body) as never,
      message.body,
    );

    expect(redelivered.kind).toBe('duplicate');

    const afterRedelivery = await readWallet(wallet.walletId);

    expect(afterRedelivery.balance).toBe('75.00');
    expect(afterRedelivery.version).toBe(afterCommit.version);

    const entries = await ledgerOf(wallet.walletId);
    expect(entries.filter((entry) => entry.direction === LedgerDirection.Debit)).toHaveLength(1);

    // Agora o ACK acontece e a mensagem some da fila.
    await context.sqs.deleteMessage(context.options.wagerQueueUrl, delivered.receiptHandle);
  }, 60000);

  test('mesmo messageId com payload diferente é conflito, não replay', async () => {
    const wallet = await openWallet('100.00');
    const messageId = crypto.randomUUID();
    const original = wagerMessage({ messageId, walletId: wallet.walletId, playerId: wallet.playerId });

    const first = await context.consume.execute(
      JSON.parse(original.body) as never,
      original.body,
    );

    expect(first.kind).toBe('processed');

    const tampered = wagerMessage({
      messageId,
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      overrides: { money: { amount: '99.00', currency: 'BRL' } },
    });

    const conflict = await context.consume.execute(
      JSON.parse(tampered.body) as never,
      tampered.body,
    );

    // Aceitar em silêncio aplicaria efeitos de um payload sob a identidade de
    // outro; o conflito é explícito e nada muda.
    expect(conflict.kind).toBe('payload-conflict');

    const snapshot = await readWallet(wallet.walletId);
    expect(snapshot.balance).toBe('75.00');
  }, 60000);

  test('mesma operação em mensagem nova é replay financeiro, não duplicata de Inbox', async () => {
    const wallet = await openWallet('100.00');
    const first = wagerMessage({ walletId: wallet.walletId, playerId: wallet.playerId });
    const parsed = JSON.parse(first.body) as {
      data: { idempotencyKey: string; externalTransactionId: string };
    };

    await context.consume.execute(JSON.parse(first.body) as never, first.body);

    // messageId novo: a Inbox não reconhece, mas a identidade financeira sim.
    const resent = wagerMessage({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      overrides: {
        idempotencyKey: parsed.data.idempotencyKey,
        externalTransactionId: parsed.data.externalTransactionId,
      },
    });

    const outcome = await context.consume.execute(
      JSON.parse(resent.body) as never,
      resent.body,
    );

    expect(outcome.kind).toBe('processed');

    if (outcome.kind === 'processed') {
      expect(outcome.result.idempotentReplay).toBe(true);
    }

    const snapshot = await readWallet(wallet.walletId);

    expect(snapshot.balance).toBe('75.00');
    expect(snapshot.version).toBe(2);
  }, 60000);
});

describe('corrida concorrente pela chave da Inbox', () => {
  /**
   * Duas execuções sobre o mesmo `messageId`, sincronizadas no ponto em que
   * ambas observam a Inbox vazia. É a única forma de exercitar a janela real:
   * executar uma depois da outra testaria a verificação prévia, não a corrida.
   */
  function racingConsumer(): ConsumeWagerMessageUseCase {
    const gated = new InboxRaceManager(context.manager, new Barrier(2));

    return new ConsumeWagerMessageUseCase(
      gated,
      new ProcessWagerTransactionUseCase(gated, {}),
      CONSUMER_NAME,
    );
  }

  test('payloads diferentes: um vence e o outro detecta conflito, sem efeito duplo', async () => {
    const wallet = await openWallet('100.00');
    const messageId = crypto.randomUUID();
    const first = wagerMessage({
      messageId,
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      overrides: { roundId: 'round-race-a' },
    });
    const second = wagerMessage({
      messageId,
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      overrides: { roundId: 'round-race-b' },
    });

    expect(hashMessagePayload(first.body)).not.toBe(hashMessagePayload(second.body));

    const consume = racingConsumer();
    const [a, b] = await Promise.all([
      consume.execute(JSON.parse(first.body) as never, first.body),
      consume.execute(JSON.parse(second.body) as never, second.body),
    ]);

    // Qual das duas vence é decisão do banco; o par de resultados não é.
    expect([a.kind, b.kind].sort()).toEqual(['payload-conflict', 'processed']);

    const winner = a.kind === 'processed' ? first : second;
    const inbox = await context.manager.execute((scope) =>
      scope.inbox.find(CONSUMER_NAME, messageId),
    );

    // Uma única linha, com o corpo de quem venceu.
    expect(inbox?.payloadHash).toBe(hashMessagePayload(winner.body));

    const snapshot = await readWallet(wallet.walletId);

    expect(snapshot.balance).toBe('75.00');
    expect(snapshot.version).toBe(2);

    const entries = await ledgerOf(wallet.walletId);

    expect(entries.filter((entry) => entry.direction === LedgerDirection.Debit)).toHaveLength(1);
    await context.manager.execute((scope) => assertLedgerBalance(scope, wallet.walletId));
  }, 60000);

  test('payload idêntico em concorrência é duplicata segura, não conflito', async () => {
    const wallet = await openWallet('100.00');
    const message = wagerMessage({ walletId: wallet.walletId, playerId: wallet.playerId });
    const consume = racingConsumer();

    const [a, b] = await Promise.all([
      consume.execute(JSON.parse(message.body) as never, message.body),
      consume.execute(JSON.parse(message.body) as never, message.body),
    ]);

    // Perder a corrida com o mesmo corpo é redelivery, e redelivery é normal.
    expect([a.kind, b.kind].sort()).toEqual(['duplicate', 'processed']);

    const snapshot = await readWallet(wallet.walletId);

    expect(snapshot.balance).toBe('75.00');
    expect(snapshot.version).toBe(2);

    const entries = await ledgerOf(wallet.walletId);

    expect(entries.filter((entry) => entry.direction === LedgerDirection.Debit)).toHaveLength(1);

    const inbox = await context.manager.execute((scope) =>
      scope.inbox.find(CONSUMER_NAME, message.messageId),
    );

    expect(inbox?.payloadHash).toBe(hashMessagePayload(message.body));
    await context.manager.execute((scope) => assertLedgerBalance(scope, wallet.walletId));
  }, 60000);
});
