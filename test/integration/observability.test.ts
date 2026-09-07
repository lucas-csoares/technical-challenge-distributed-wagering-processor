import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/shared/money.js';
import {
  idempotencyHeader,
  request,
  startHttpTestServer,
  wagerBody,
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

/** Exposição corrente, lida pelo mesmo endpoint que um coletor usaria. */
async function scrape(): Promise<string> {
  const response = await fetch(`${server.baseUrl}/metrics`);

  expect(response.status).toBe(200);

  return response.text();
}

/**
 * Valor de uma série específica, localizado por nome e não por posição.
 *
 * A ordem do texto do Prometheus não é contrato; assertar sobre ela produziria
 * um teste que quebra ao acrescentar qualquer métrica.
 */
function valueOf(exposition: string, series: string): number {
  const line = exposition.split('\n').find((entry) => entry.startsWith(`${series} `));

  return line === undefined ? 0 : Number.parseFloat(line.slice(series.length + 1));
}

async function createWallet(amount: string): Promise<WalletResponse> {
  const response = await request<WalletResponse>(server, 'POST', '/wallets', {
    body: {
      playerId: crypto.randomUUID(),
      initialBalance: { amount, currency: 'BRL' },
    },
  });

  expect(response.status).toBe(201);

  return response.body;
}

describe('GET /metrics', () => {
  test('responde em formato Prometheus, sem autenticação', async () => {
    const response = await fetch(`${server.baseUrl}/metrics`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toContain('# TYPE');
  });

  test('todas as métricas exigidas pelo desafio são expostas', async () => {
    const exposition = await scrape();

    for (const name of [
      // transações por status
      'wager_transactions_total',
      // latência de processamento
      'wager_processing_duration_seconds',
      // duplicatas detectadas
      'wager_duplicates_total',
      // retries
      'wager_retries_total',
      // mensagens em DLQ, e as classificadas como permanentes pela aplicação
      'wager_dlq_messages',
      'wager_messages_permanent_total',
      // conflitos de lock
      'wallet_lock_wait_seconds',
      'wallet_lock_conflicts_total',
      // outbox lag
      'outbox_publish_lag_seconds',
      'outbox_oldest_pending_age_seconds',
      // divergência de reconciliação
      'wallet_reconciliation_divergences_total',
    ]) {
      expect(exposition).toContain(`# TYPE ${name}`);
    }
  });
});

describe('métricas do caminho HTTP', () => {
  test('uma operação processada conta status, transporte e latência', async () => {
    const wallet = await createWallet('100.00');
    const series = 'wager_transactions_total{status="PROCESSED",transport="http"}';
    const latency = 'wager_processing_duration_seconds_count{transport="http"}';
    const before = await scrape();

    const response = await request<WagerResponse>(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId),
      headers: idempotencyHeader(),
    });

    expect(response.status).toBe(200);

    const after = await scrape();

    expect(valueOf(after, series)).toBe(valueOf(before, series) + 1);
    expect(valueOf(after, latency)).toBe(valueOf(before, latency) + 1);
  });

  test('rejeição de negócio é contada separadamente do sucesso', async () => {
    const wallet = await createWallet('10.00');
    const series = 'wager_transactions_total{status="REJECTED",transport="http"}';
    const before = await scrape();

    const response = await request<WagerResponse>(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId),
      headers: idempotencyHeader(),
    });

    expect(response.status).toBe(422);
    expect(valueOf(await scrape(), series)).toBe(valueOf(before, series) + 1);
  });

  test('replay idempotente conta como duplicata do nível financeiro', async () => {
    const wallet = await createWallet('100.00');
    const series = 'wager_duplicates_total{source="financial_idempotency"}';
    const body = wagerBody(wallet.id, wallet.playerId);
    const headers = idempotencyHeader();

    await request<WagerResponse>(server, 'POST', '/wagering/transactions', { body, headers });

    const before = await scrape();
    const replay = await request<WagerResponse>(server, 'POST', '/wagering/transactions', {
      body,
      headers,
    });

    expect(replay.body.idempotentReplay).toBe(true);
    expect(valueOf(await scrape(), series)).toBe(valueOf(before, series) + 1);
  });

  test('a espera pelo lock da wallet é observada a cada operação', async () => {
    const wallet = await createWallet('100.00');
    const series = 'wallet_lock_wait_seconds_count';
    const before = await scrape();

    await request<WagerResponse>(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId),
      headers: idempotencyHeader(),
    });

    // Com lock pessimista a disputa vira espera, não erro: é a duração que
    // revela a hot wallet, e o contador de conflitos só se move em deadlock.
    expect(valueOf(await scrape(), series)).toBeGreaterThan(valueOf(before, series));
  });

  test('um cabeçalho de correlação é aceito sem alterar o resultado', async () => {
    const wallet = await createWallet('100.00');
    const correlationId = `probe-${crypto.randomUUID()}`;

    const response = await request<WagerResponse>(server, 'POST', '/wagering/transactions', {
      body: wagerBody(wallet.id, wallet.playerId),
      headers: { ...idempotencyHeader(), 'x-correlation-id': correlationId },
    });

    expect(response.status).toBe(200);
    expect(response.body.balance.amount).toBe('75.00');
  });
});

describe('divergência de reconciliação', () => {
  test('é contabilizada em métrica, além de sinalizada na resposta', async () => {
    const wallet = await createWallet('100.00');
    const series = 'wallet_reconciliation_divergences_total';

    // O ledger é imutável; a fixture corrompe apenas o saldo materializado, que
    // é exatamente a divergência que a reconciliação existe para encontrar.
    await server.manager.execute(async (scope) => {
      const stored = await scope.wallets.findByIdForUpdate(wallet.id);

      if (stored === undefined) {
        throw new Error('Expected the fixture wallet.');
      }

      stored.credit(Money.from({ amount: '5.00', currency: 'BRL' }), new Date());
      await scope.wallets.save(stored);
    });

    const before = await scrape();
    const response = await request<{ consistent: boolean; difference: { amount: string } }>(
      server,
      'POST',
      `/wallets/${wallet.id}/reconciliation`,
    );

    expect(response.body.consistent).toBe(false);
    expect(response.body.difference.amount).toBe('5.00');
    expect(valueOf(await scrape(), series)).toBe(valueOf(before, series) + 1);

    // Reportar não é reparar: o saldo divergente continua lá para investigação.
    const after = await request<WalletResponse>(server, 'GET', `/wallets/${wallet.id}`);
    expect(after.body.balance.amount).toBe('105.00');
  });

  test('uma wallet consistente não move o contador', async () => {
    const wallet = await createWallet('100.00');
    const series = 'wallet_reconciliation_divergences_total';
    const before = await scrape();

    const response = await request<{ consistent: boolean }>(
      server,
      'POST',
      `/wallets/${wallet.id}/reconciliation`,
    );

    expect(response.body.consistent).toBe(true);
    expect(valueOf(await scrape(), series)).toBe(valueOf(before, series));
  });
});
