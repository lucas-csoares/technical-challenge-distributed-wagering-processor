import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { FinancialTransactionManager } from '../../src/application/ports/financial-transaction-manager.js';
import { bootstrap } from '../../src/main.js';

export interface HttpTestServer {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly manager: FinancialTransactionManager;
  close(): Promise<void>;
}

export interface HttpResult<T = unknown> {
  readonly status: number;
  readonly body: T;
}

/**
 * Sobe o servidor NestJS real em porta efêmera e aplica as migrations no
 * schema que a aplicação usa de verdade.
 *
 * Os testes financeiros de casos de uso montam schemas isolados, mas aqui o
 * objetivo é exercitar o caminho HTTP completo pela composição real — trocar o
 * schema por baixo do app testaria uma configuração que ninguém executa.
 * As migrations são idempotentes, então rodá-las é seguro em execuções
 * repetidas, e cada teste usa identificadores próprios para não colidir.
 */
export async function startHttpTestServer(): Promise<HttpTestServer> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Integration tests require NODE_ENV=test.');
  }

  const app = await bootstrap(0);
  const orm = app.get(MikroORM);

  try {
    await orm.migrator.up();
  } catch (error) {
    await app.close();
    throw error;
  }

  const baseUrl = await app.getUrl();

  return {
    app,
    baseUrl,
    manager: app.get(FinancialTransactionManager),
    close: () => app.close(),
  };
}

export async function request<T = unknown>(
  server: HttpTestServer,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<HttpResult<T>> {
  const headers: Record<string, string> = { ...options.headers };

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const response = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  const body: unknown = text.length === 0 ? undefined : JSON.parse(text);

  return { status: response.status, body: body as T };
}

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

export interface WagerResponse {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string };
  failureCode?: string;
  idempotentReplay: boolean;
}

export interface ErrorResponse {
  code: string;
  message: string;
}

/** Comando de wagering com identidade nova a cada chamada. */
export function wagerBody(
  walletId: string,
  playerId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    providerId: 'provider-http',
    externalTransactionId: crypto.randomUUID(),
    playerId,
    walletId,
    roundId: 'round-http',
    gameId: 'game-http',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

export function idempotencyHeader(key = crypto.randomUUID()): Record<string, string> {
  return { 'idempotency-key': key };
}
