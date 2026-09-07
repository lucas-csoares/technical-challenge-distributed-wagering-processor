import { describe, expect, test } from 'bun:test';
import { hashMessagePayload } from '../../src/application/consume-wager-message.use-case.js';
import { WagerTransactionProcessed } from '../../src/application/events/wagering-events.js';
import { ExponentialPendingReferenceSchedule } from '../../src/application/pending-reference-schedule.js';
import { BackgroundWorker } from '../../src/infrastructure/messaging/background-worker.js';
import { createMessagingOptions } from '../../src/infrastructure/messaging/messaging.config.js';
import { parseWagerEnvelope } from '../../src/infrastructure/messaging/sqs/wager-envelope.js';

const AT = new Date('2026-09-07T12:00:00.000Z');

describe('envelope de evento de integração', () => {
  function event(causationId?: string) {
    return new WagerTransactionProcessed({
      eventId: 'event-1',
      aggregateId: 'tx-1',
      correlationId: 'provider-a:key-1',
      ...(causationId === undefined ? {} : { causationId }),
      occurredAt: AT,
      data: {
        transactionId: 'tx-1',
        providerId: 'provider-a',
        externalTransactionId: 'ext-1',
        walletId: 'wallet-1',
        playerId: 'player-1',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        balance: { amount: '75.00', currency: 'BRL' },
        referenceTransactionId: undefined,
      },
    });
  }

  test('serializa tipo, versão e instante em formato estável', () => {
    const envelope = event().toJSON();

    expect(envelope.eventType).toBe('WagerTransactionProcessed');
    expect(envelope.version).toBe(1);
    expect(envelope.eventId).toBe('event-1');
    expect(envelope.aggregateId).toBe('tx-1');
    expect(envelope.occurredAt).toBe('2026-09-07T12:00:00.000Z');
  });

  test('valores monetários permanecem string decimal, nunca number', () => {
    const envelope = event().toJSON();
    const serialized = JSON.stringify(envelope);

    expect(envelope.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(envelope.data.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(serialized).toContain('"amount":"25.00"');
    // Um número apareceria sem aspas no JSON.
    expect(serialized).not.toContain('"amount":25');
  });

  test('causationId só aparece quando existe', () => {
    expect('causationId' in event().toJSON()).toBe(false);
    expect(event('msg-1').toJSON().causationId).toBe('msg-1');
  });

  test('o envelope sobrevive a um round-trip JSON', () => {
    const envelope = event('msg-1').toJSON();
    const parsed: unknown = JSON.parse(JSON.stringify(envelope));

    expect(parsed).toEqual(envelope);
  });
});

describe('hash de payload da Inbox', () => {
  test('é estável para o mesmo corpo e diferente para corpos distintos', () => {
    const body = '{"messageId":"m-1"}';

    expect(hashMessagePayload(body)).toBe(hashMessagePayload(body));
    expect(hashMessagePayload(body)).not.toBe(hashMessagePayload('{"messageId":"m-2"}'));
  });

  test('distingue corpos que diferem apenas na ordem das chaves', () => {
    // É identidade de transporte: o corpo recebido é comparado como veio, sem
    // canonicalização. Quem normaliza semanticamente é a idempotência
    // financeira, com seu próprio hash canônico.
    expect(hashMessagePayload('{"a":1,"b":2}')).not.toBe(hashMessagePayload('{"b":2,"a":1}'));
  });
});

describe('backoff de PENDING_REFERENCE', () => {
  const schedule = new ExponentialPendingReferenceSchedule({
    baseDelayMs: 1_000,
    maxDelayMs: 8_000,
    maxAttempts: 5,
  });

  test('a primeira tentativa usa o atraso base', () => {
    expect(schedule.firstAttemptAt(AT).getTime() - AT.getTime()).toBe(1_000);
  });

  test('dobra a cada tentativa e satura no teto', () => {
    const delays = [1, 2, 3, 4].map((attempts) => {
      const next = schedule.nextAttemptAt(attempts, AT);

      return next === undefined ? undefined : next.getTime() - AT.getTime();
    });

    expect(delays).toEqual([2_000, 4_000, 8_000, 8_000]);
  });

  test('desiste ao esgotar as tentativas, em vez de adiar para sempre', () => {
    expect(schedule.nextAttemptAt(5, AT)).toBeUndefined();
    expect(schedule.nextAttemptAt(6, AT)).toBeUndefined();
  });
});

describe('configuração de mensageria', () => {
  const base = {
    NODE_ENV: 'test',
    TEST_SQS_ENDPOINT: 'http://127.0.0.1:4567',
    TEST_WAGER_QUEUE_URL: 'http://localhost/test-wager',
    TEST_WAGER_DLQ_URL: 'http://localhost/test-dlq',
    TEST_EVENTS_QUEUE_URL: 'http://localhost/test-events',
  };

  test('em teste, seleciona exclusivamente as variáveis TEST_', () => {
    const options = createMessagingOptions({
      ...base,
      WAGER_QUEUE_URL: 'http://localhost/dev-wager',
    });

    expect(options.wagerQueueUrl).toBe('http://localhost/test-wager');
    expect(options.endpoint).toBe('http://127.0.0.1:4567');
  });

  test('recusa a ausência de uma fila obrigatória', () => {
    expect(() => createMessagingOptions({ ...base, TEST_WAGER_QUEUE_URL: '' })).toThrow(
      'TEST_WAGER_QUEUE_URL is required.',
    );
  });

  test('recusa apontar os testes para a fila de desenvolvimento', () => {
    expect(() =>
      createMessagingOptions({ ...base, WAGER_QUEUE_URL: 'http://localhost/test-wager' }),
    ).toThrow('must differ from the development queues');
  });
});

describe('envelope de transporte da fila', () => {
  const valid = {
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
      money: { amount: '25.00', currency: 'BRL' },
    },
  };

  function parse(overrides: Record<string, unknown>) {
    return parseWagerEnvelope(JSON.stringify({ ...valid, ...overrides }));
  }

  test('aceita um envelope completo', () => {
    expect(parseWagerEnvelope(JSON.stringify(valid))?.messageId).toBe('msg-1');
  });

  test('recusa corpo que não é JSON de objeto', () => {
    expect(parseWagerEnvelope('não é json')).toBeUndefined();
    expect(parseWagerEnvelope('"texto"')).toBeUndefined();
  });

  test('recusa envelope sem occurredAt', () => {
    expect(parse({ occurredAt: undefined })).toBeUndefined();
    expect(parse({ occurredAt: '' })).toBeUndefined();
  });

  test('recusa occurredAt que não é string', () => {
    expect(parse({ occurredAt: 1788779220278 })).toBeUndefined();
    expect(parse({ occurredAt: { at: '2026-09-07T12:00:00.000Z' } })).toBeUndefined();
  });

  test('recusa occurredAt fora do formato ISO-8601 com fuso', () => {
    // Sem fuso a instrução é ambígua, e datas locais são a origem clássica de
    // divergência entre provedor e processador.
    expect(parse({ occurredAt: '2026-09-07 12:00:00' })).toBeUndefined();
    expect(parse({ occurredAt: '2026-09-07T12:00:00' })).toBeUndefined();
    expect(parse({ occurredAt: '07/09/2026' })).toBeUndefined();
  });

  test('recusa occurredAt com formato válido mas data inexistente', () => {
    expect(parse({ occurredAt: '2026-02-31T00:00:00.000Z' })).toBeUndefined();
    expect(parse({ occurredAt: '2026-13-01T00:00:00.000Z' })).toBeUndefined();
  });

  test('aceita offset explícito além de Z', () => {
    expect(parse({ occurredAt: '2026-09-07T09:00:00-03:00' })).toBeDefined();
  });

  test('recusa tipo desconhecido e identidade ausente', () => {
    expect(parse({ type: 'SomethingElse' })).toBeUndefined();
    expect(parse({ messageId: '' })).toBeUndefined();
  });

  test('recusa payload sem campo obrigatório do comando', () => {
    expect(parse({ data: { ...valid.data, walletId: '' } })).toBeUndefined();
    expect(parse({ data: { ...valid.data, money: { amount: 25, currency: 'BRL' } } })).toBeUndefined();
  });
});

describe('parada limpa de worker de fundo', () => {
  test('stop aguarda o ciclo em andamento antes de encerrar', async () => {
    let started = 0;
    let finished = 0;
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const worker = new BackgroundWorker({ name: 'test-worker', intervalMs: 5 }, async () => {
      started += 1;
      await blocked;
      finished += 1;
    });

    worker.start();
    await Bun.sleep(10);

    expect(started).toBe(1);
    expect(finished).toBe(0);

    // `stop()` não pode devolver o controle com trabalho pela metade: é isso
    // que impede o `SIGTERM` de interromper uma mensagem entre o commit e o ACK.
    const stopping = worker.stop();
    release();
    await stopping;

    expect(finished).toBe(1);

    const cyclesAtStop = started;
    await Bun.sleep(30);

    // E nenhum ciclo novo é adquirido depois da parada.
    expect(started).toBe(cyclesAtStop);
  });

  test('um ciclo que falha não derruba o laço nem impede a parada', async () => {
    let cycles = 0;
    const worker = new BackgroundWorker({ name: 'failing-worker', intervalMs: 1 }, async () => {
      cycles += 1;
      await Promise.resolve();
      throw new Error('cycle failure');
    });

    worker.start();
    await Bun.sleep(20);
    await worker.stop();

    expect(cycles).toBeGreaterThan(1);
  });
});
