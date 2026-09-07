import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/shared/money.js';
import {
  idempotencyHeader,
  request,
  startHttpTestServer,
  wagerBody,
  type ErrorResponse,
  type HttpTestServer,
  type WagerResponse,
  type WalletResponse,
} from './http-support.js';

let server: HttpTestServer;

beforeAll(async () => {
  server = await startHttpTestServer();
});

afterAll(async () => {
  await server.close();
});

async function createWallet(amount = '100.00'): Promise<WalletResponse> {
  const playerId = crypto.randomUUID();
  const created = await request<WalletResponse>(server, 'POST', '/wallets', {
    body: { playerId, initialBalance: { amount, currency: 'BRL' } },
  });

  expect(created.status).toBe(201);

  return created.body;
}

describe('POST /wallets', () => {
  test('cria wallet zerada sem lançamento de abertura', async () => {
    const wallet = await createWallet('0.00');

    expect(wallet.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(typeof wallet.balance.amount).toBe('string');

    const ledger = await request<{ items: unknown[] }>(
      server,
      'GET',
      `/wallets/${wallet.id}/ledger`,
    );

    expect(ledger.status).toBe(200);
    expect(ledger.body.items).toHaveLength(0);
  });

  test('cria wallet com saldo e reflete o OPENING no ledger', async () => {
    const wallet = await createWallet('1000.00');

    expect(wallet.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);

    const ledger = await request<{
      items: { direction: string; money: { amount: string }; balanceAfter: { amount: string } }[];
    }>(server, 'GET', `/wallets/${wallet.id}/ledger`);

    expect(ledger.body.items).toHaveLength(1);
    expect(ledger.body.items[0]?.direction).toBe('CREDIT');
    expect(ledger.body.items[0]?.money.amount).toBe('1000.00');
    expect(ledger.body.items[0]?.balanceAfter.amount).toBe('1000.00');
  });

  test('wallet duplicada do mesmo player e moeda responde 409', async () => {
    const playerId = crypto.randomUUID();
    const body = { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } };

    expect((await request(server, 'POST', '/wallets', { body })).status).toBe(201);

    const conflict = await request<ErrorResponse>(server, 'POST', '/wallets', { body });

    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('WALLET_ALREADY_EXISTS');
    expect(JSON.stringify(conflict.body)).not.toContain('wallets_player_currency_unique');
  });

  test.each([
    ['campo obrigatório ausente', { initialBalance: { amount: '1.00', currency: 'BRL' } }],
    ['money ausente', { playerId: 'p' }],
    ['tipo incorreto', { playerId: 1, initialBalance: { amount: '1.00', currency: 'BRL' } }],
    [
      'campo desconhecido',
      { playerId: 'p', initialBalance: { amount: '1.00', currency: 'BRL' }, extra: true },
    ],
  ])('payload inválido (%s) responde 400', async (_name, body) => {
    const response = await request<ErrorResponse>(server, 'POST', '/wallets', { body });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_REQUEST');
  });

  test('Money malformado é recusado antes de virar rejeição financeira', async () => {
    const response = await request<ErrorResponse>(server, 'POST', '/wallets', {
      body: { playerId: crypto.randomUUID(), initialBalance: { amount: '10.5', currency: 'BRL' } },
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_MONEY');
  });
});

describe('GET /wallets/:walletId', () => {
  test('devolve saldo e version atuais', async () => {
    const wallet = await createWallet('100.00');

    await request(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId),
      headers: idempotencyHeader(),
    });

    const found = await request<WalletResponse>(server, 'GET', `/wallets/${wallet.id}`);

    expect(found.status).toBe(200);
    expect(found.body.id).toBe(wallet.id);
    expect(found.body.playerId).toBe(wallet.playerId);
    expect(found.body.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(found.body.version).toBe(2);
  });

  test('wallet inexistente responde 404', async () => {
    const response = await request<ErrorResponse>(server, 'GET', `/wallets/${crypto.randomUUID()}`);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  interface LedgerPage {
    items: { id: string; transactionId: string; direction: string; createdAt: string }[];
    nextCursor: string | null;
  }

  test('pagina por cursor estável, sem repetir nem perder lançamentos', async () => {
    const wallet = await createWallet('100.00');

    // OPENING + 4 movimentações = 5 lançamentos.
    for (let index = 0; index < 4; index += 1) {
      const response = await request(server, 'POST', '/wagering/transactions', {
        body: wagerBody(wallet.id, wallet.playerId, {
          kind: 'WIN',
          money: { amount: '1.00', currency: 'BRL' },
        }),
        headers: idempotencyHeader(),
      });

      expect(response.status).toBe(200);
    }

    const first = await request<LedgerPage>(
      server,
      'GET',
      `/wallets/${wallet.id}/ledger?limit=2`,
    );

    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(typeof first.body.nextCursor).toBe('string');

    const collected = [...first.body.items];
    let cursor = first.body.nextCursor;

    while (cursor !== null && cursor !== undefined) {
      const page: { status: number; body: LedgerPage } = await request<LedgerPage>(
        server,
        'GET',
        `/wallets/${wallet.id}/ledger?limit=2&cursor=${encodeURIComponent(cursor)}`,
      );

      expect(page.status).toBe(200);
      collected.push(...page.body.items);
      cursor = page.body.nextCursor;
    }

    expect(collected).toHaveLength(5);
    expect(new Set(collected.map((entry) => entry.id)).size).toBe(5);

    // Ordenação determinística por (createdAt, id).
    const keys = collected.map((entry) => `${entry.createdAt}|${entry.id}`);
    expect([...keys].sort()).toEqual(keys);

    // A última página encerra o histórico.
    expect(cursor === null || cursor === undefined).toBe(true);
  });

  test('cursor inválido responde 400 sem vazar detalhe interno', async () => {
    const wallet = await createWallet('10.00');
    const response = await request<ErrorResponse>(
      server,
      'GET',
      `/wallets/${wallet.id}/ledger?cursor=not-a-cursor`,
    );

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_CURSOR');
  });

  test('limit inválido responde 400', async () => {
    const wallet = await createWallet('10.00');
    const response = await request<ErrorResponse>(
      server,
      'GET',
      `/wallets/${wallet.id}/ledger?limit=0`,
    );

    expect(response.status).toBe(400);
  });

  test('ledger de wallet inexistente responde 404', async () => {
    const response = await request<ErrorResponse>(
      server,
      'GET',
      `/wallets/${crypto.randomUUID()}/ledger`,
    );

    expect(response.status).toBe(404);
  });
});

describe('POST /wagering/transactions', () => {
  test('BET processada responde 200 e debita', async () => {
    const wallet = await createWallet('100.00');
    const response = await request<WagerResponse>(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId),
      headers: idempotencyHeader(),
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('PROCESSED');
    expect(response.body.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(response.body.idempotentReplay).toBe(false);
  });

  test('WIN e LOSS atravessam o mesmo caso de uso', async () => {
    const wallet = await createWallet('100.00');

    const win = await request<WagerResponse>(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId, { kind: 'WIN' }),
      headers: idempotencyHeader(),
    });

    expect(win.status).toBe(200);
    expect(win.body.balance.amount).toBe('125.00');

    const loss = await request<WagerResponse>(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId, {
        kind: 'LOSS',
        money: { amount: '0.00', currency: 'BRL' },
      }),
      headers: idempotencyHeader(),
    });

    expect(loss.status).toBe(200);
    expect(loss.body.status).toBe('PROCESSED');
    expect(loss.body.balance.amount).toBe('125.00');
  });

  test('BET sem saldo responde 422 com failureCode auditável', async () => {
    const wallet = await createWallet('10.00');
    const response = await request<WagerResponse>(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId),
      headers: idempotencyHeader(),
    });

    expect(response.status).toBe(422);
    expect(response.body.status).toBe('REJECTED');
    expect(response.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(response.body.balance).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(response.body.transactionId).toBeDefined();
  });

  test('referência ausente responde 202 e não move o saldo', async () => {
    const wallet = await createWallet('100.00');
    const response = await request<WagerResponse>(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId, {
        kind: 'REFUND',
        referenceExternalTransactionId: 'never-received',
      }),
      headers: idempotencyHeader(),
    });

    expect(response.status).toBe(202);
    expect(response.body.status).toBe('PENDING_REFERENCE');
    expect(response.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    const unchanged = await request<WalletResponse>(server, 'GET', `/wallets/${wallet.id}`);
    expect(unchanged.body.balance.amount).toBe('100.00');
    expect(unchanged.body.version).toBe(1);
  });

  test('Idempotency-Key ausente é erro de contrato, não chega ao use case', async () => {
    const wallet = await createWallet('100.00');
    const response = await request<ErrorResponse>(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId),
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_REQUEST');
    expect(response.body.message).toContain('Idempotency-Key');
  });

  test('kind interno OPENING não é aceito pela API', async () => {
    const wallet = await createWallet('100.00');
    const response = await request<ErrorResponse>(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId, { kind: 'OPENING' }),
      headers: idempotencyHeader(),
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_REQUEST');
  });
});

describe('idempotência HTTP', () => {
  test('a mesma requisição com a mesma key devolve o resultado original', async () => {
    const wallet = await createWallet('100.00');
    const body = wagerBody(wallet.id, wallet.playerId);
    const headers = idempotencyHeader();

    const first = await request<WagerResponse>(server, 'POST', '/wagering/transactions', {
      body,
      headers,
    });

    expect(first.body.idempotentReplay).toBe(false);

    // Uma segunda operação move o saldo para longe do resultado original.
    await request(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId),
      headers: idempotencyHeader(),
    });

    const replay = await request<WagerResponse>(server, 'POST', '/wagering/transactions', {
      body,
      headers,
    });

    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.transactionId).toBe(first.body.transactionId);
    expect(replay.body.balance).toEqual(first.body.balance);

    const current = await request<WalletResponse>(server, 'GET', `/wallets/${wallet.id}`);
    expect(current.body.balance.amount).toBe('50.00');
    expect(replay.body.balance.amount).toBe('75.00');
  });

  test('a mesma key com payload divergente responde 409', async () => {
    const wallet = await createWallet('100.00');
    const headers = idempotencyHeader();

    await request(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId),
      headers,
    });

    const conflict = await request<ErrorResponse>(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId, {
        money: { amount: '30.00', currency: 'BRL' },
      }),
      headers,
    });

    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('o mesmo external id do provider com outra key responde 409', async () => {
    const wallet = await createWallet('100.00');
    const externalTransactionId = crypto.randomUUID();

    await request(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId, { externalTransactionId }),
      headers: idempotencyHeader(),
    });

    const conflict = await request<ErrorResponse>(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId, { externalTransactionId }),
      headers: idempotencyHeader(),
    });

    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('EXTERNAL_TRANSACTION_CONFLICT');
  });
});

describe('consultas de transação', () => {
  test('busca pelo id interno e pela identidade externa do provider', async () => {
    const wallet = await createWallet('100.00');
    const externalTransactionId = crypto.randomUUID();

    const created = await request<WagerResponse>(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId, { externalTransactionId }),
      headers: idempotencyHeader(),
    });

    interface TransactionView {
      transactionId: string;
      providerId: string;
      externalTransactionId: string;
      kind: string;
      status: string;
      money: { amount: string; currency: string };
      payloadHash?: string;
      idempotencyKey?: string;
    }

    const byId = await request<TransactionView>(
      server,
      'GET',
      `/wagering/transactions/${created.body.transactionId}`,
    );

    expect(byId.status).toBe(200);
    expect(byId.body.transactionId).toBe(created.body.transactionId);
    expect(byId.body.kind).toBe('BET');
    expect(byId.body.status).toBe('PROCESSED');
    expect(byId.body.money).toEqual({ amount: '25.00', currency: 'BRL' });

    // Detalhes internos da idempotência não fazem parte do contrato público.
    expect(byId.body.payloadHash).toBeUndefined();
    expect(byId.body.idempotencyKey).toBeUndefined();

    const byIdentity = await request<TransactionView>(
      server,
      'GET',
      `/providers/provider-http/wagering/transactions/${externalTransactionId}`,
    );

    expect(byIdentity.status).toBe(200);
    expect(byIdentity.body.transactionId).toBe(created.body.transactionId);
  });

  test('a identidade externa tem escopo de provider', async () => {
    const wallet = await createWallet('100.00');
    const externalTransactionId = crypto.randomUUID();

    await request(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId, { externalTransactionId }),
      headers: idempotencyHeader(),
    });

    const otherProvider = await request<ErrorResponse>(
      server,
      'GET',
      `/providers/provider-outro/wagering/transactions/${externalTransactionId}`,
    );

    expect(otherProvider.status).toBe(404);
  });

  test('transação inexistente responde 404', async () => {
    const response = await request<ErrorResponse>(
      server,
      'GET',
      `/wagering/transactions/${crypto.randomUUID()}`,
    );

    expect(response.status).toBe(404);
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  test('wallet consistente reporta diferença zero', async () => {
    const wallet = await createWallet('100.00');

    await request(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId),
      headers: idempotencyHeader(),
    });

    interface Reconciliation {
      walletId: string;
      storedBalance: { amount: string; currency: string };
      calculatedBalance: { amount: string; currency: string };
      difference: { amount: string; currency: string };
      consistent: boolean;
      checkedEntries: number;
    }

    const response = await request<Reconciliation>(
      server,
      'POST',
      `/wallets/${wallet.id}/reconciliation`,
    );

    expect(response.status).toBe(200);
    expect(response.body.walletId).toBe(wallet.id);
    expect(response.body.storedBalance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(response.body.calculatedBalance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(response.body.difference).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(response.body.consistent).toBe(true);
    expect(response.body.checkedEntries).toBe(2);
  });

  test('detecta divergência e não corrige a wallet', async () => {
    const wallet = await createWallet('100.00');

    // O ledger é imutável e as constraints impedem forjar inconsistência pelo
    // caminho normal. A fixture altera apenas o saldo materializado, que é a
    // corrupção que a reconciliação existe para encontrar.
    await server.manager.execute(async (scope) => {
      const stored = await scope.wallets.findByIdForUpdate(wallet.id);

      if (stored === undefined) {
        throw new Error('Expected the fixture wallet.');
      }

      stored.credit(Money.from({ amount: '5.00', currency: 'BRL' }), new Date());
      await scope.wallets.save(stored);
    });

    interface Reconciliation {
      storedBalance: { amount: string };
      calculatedBalance: { amount: string };
      difference: { amount: string };
      consistent: boolean;
      checkedEntries: number;
    }

    const response = await request<Reconciliation>(
      server,
      'POST',
      `/wallets/${wallet.id}/reconciliation`,
    );

    expect(response.status).toBe(200);
    expect(response.body.consistent).toBe(false);
    expect(response.body.storedBalance.amount).toBe('105.00');
    expect(response.body.calculatedBalance.amount).toBe('100.00');
    expect(response.body.difference.amount).toBe('5.00');
    expect(response.body.checkedEntries).toBe(1);

    // A reconciliação relata; ela não repara.
    const afterReport = await request<WalletResponse>(server, 'GET', `/wallets/${wallet.id}`);
    expect(afterReport.body.balance.amount).toBe('105.00');

    // Repetir mantém o mesmo diagnóstico: nada foi silenciosamente ajustado.
    const again = await request<Reconciliation>(
      server,
      'POST',
      `/wallets/${wallet.id}/reconciliation`,
    );
    expect(again.body.consistent).toBe(false);
    expect(again.body.difference.amount).toBe('5.00');
  });

  test('reconciliação de wallet inexistente responde 404', async () => {
    const response = await request<ErrorResponse>(
      server,
      'POST',
      `/wallets/${crypto.randomUUID()}/reconciliation`,
    );

    expect(response.status).toBe(404);
  });
});

describe('health', () => {
  test('liveness responde sem depender do banco', async () => {
    const response = await request<{ status: string }>(server, 'GET', '/health/live');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  test('readiness confirma PostgreSQL e SQS alcançáveis', async () => {
    const response = await request<{
      status: string;
      dependencies: Record<string, string>;
    }>(server, 'GET', '/health/ready');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.dependencies.postgres).toBe('ok');
    expect(response.body.dependencies.sqs).toBe('ok');
  });
});

describe('contrato de erro', () => {
  test('nenhuma resposta de erro vaza detalhe de infraestrutura', async () => {
    const wallet = await createWallet('10.00');
    const responses = await Promise.all([
      request(server, 'GET', `/wallets/${crypto.randomUUID()}`),
      request(server, 'POST', '/wallets', { body: {} }),
      request(server, 'GET', `/wallets/${wallet.id}/ledger?cursor=bad`),
      request(server, 'POST', '/wagering/transactions', {
        body: wagerBody(wallet.id, wallet.playerId),
      }),
    ]);

    for (const response of responses) {
      const serialized = JSON.stringify(response.body);

      expect(serialized).not.toMatch(/SQLSTATE|23505|23514|DriverException|EntityManager/i);
      expect(serialized).not.toContain('node_modules');
      expect(response.body).toHaveProperty('code');
      expect(response.body).toHaveProperty('message');
    }
  });

  test('a wallet permanece coerente com o ledger após o tráfego HTTP', async () => {
    const wallet = await createWallet('100.00');

    await request(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId),
      headers: idempotencyHeader(),
    });
    await request(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId, { kind: 'WIN' }),
      headers: idempotencyHeader(),
    });

    const reconciliation = await request<{ consistent: boolean }>(
      server,
      'POST',
      `/wallets/${wallet.id}/reconciliation`,
    );

    expect(reconciliation.body.consistent).toBe(true);

    const persisted = await server.manager.execute((scope) => scope.wallets.findById(wallet.id));
    expect(persisted?.balance.toString()).toBe('100.00');
  });
});
