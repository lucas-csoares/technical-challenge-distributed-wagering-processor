import { MikroORM } from '@mikro-orm/postgresql';
import { createDatabaseOptions } from '../../src/infrastructure/persistence/database.config.js';

export interface FinancialSchema {
  readonly orm: MikroORM;
  readonly schema: string;
  close(): Promise<void>;
}

/**
 * Aplica a migration financeira real em um schema exclusivo do banco de testes.
 *
 * O isolamento por schema permite que arquivos de teste rodem sem disputar as
 * mesmas tabelas, e mantém a verificação sobre o SQL versionado — não sobre um
 * schema sincronizado pelo ORM, que não é usado em lugar nenhum do projeto.
 */
export async function createFinancialSchema(): Promise<FinancialSchema> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Integration tests require NODE_ENV=test.');
  }

  const options = createDatabaseOptions();
  const schema = `fin_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const orm = await MikroORM.init({
    ...options,
    schema,
    migrations: { ...options.migrations, schema, snapshot: false },
  });

  let created = false;

  async function assertTestDatabase(): Promise<void> {
    const rows = await orm.em
      .fork()
      .execute<{ name: string }[]>('select current_database() as name');

    if (
      process.env.NODE_ENV !== 'test' ||
      rows[0]?.name !== options.dbName ||
      !options.dbName?.endsWith('_test') ||
      options.dbName === process.env.DB_NAME ||
      !/^fin_test_[a-f0-9]{32}$/.test(schema)
    ) {
      throw new Error('Refusing test schema changes outside the configured test database.');
    }
  }

  async function close(): Promise<void> {
    try {
      if (created) {
        await assertTestDatabase();
        await orm.em.fork().execute(`drop schema "${schema}" cascade`);
      }
    } finally {
      await orm.close();
    }
  }

  try {
    await assertTestDatabase();
    await orm.em.fork().execute(`create schema "${schema}"`);
    created = true;
    await orm.migrator.up();
  } catch (error) {
    await close();
    throw error;
  }

  return { orm, schema, close };
}

/**
 * Executa uma instrução esperando que o PostgreSQL a recuse, e devolve o texto
 * completo do erro — incluindo as causas, onde o nome da constraint aparece.
 */
export async function expectRejection(
  target: FinancialSchema,
  sql: string,
  params: unknown[] = [],
): Promise<string> {
  try {
    await target.orm.em.fork().execute(sql, params);
  } catch (error) {
    const parts: string[] = [];

    for (let current: unknown = error, depth = 0; current !== undefined && depth < 5; depth += 1) {
      if (!(current instanceof Error)) {
        break;
      }

      parts.push(current.message);
      current = current.cause;
    }

    return parts.join(' | ');
  }

  throw new Error(`Expected PostgreSQL to reject: ${sql}`);
}

export const WALLET_COLUMNS = 'id, player_id, currency, balance, version, created_at, updated_at';

export interface WalletRow {
  id: string;
  playerId?: string;
  currency?: string;
  balance?: string;
  version?: number;
}

export function walletValues(row: WalletRow): unknown[] {
  const now = new Date();

  return [
    row.id,
    row.playerId ?? 'player-1',
    row.currency ?? 'BRL',
    row.balance ?? '100.00',
    row.version ?? 1,
    now,
    now,
  ];
}

export const TRANSACTION_COLUMNS = [
  'id',
  'provider_id',
  'external_transaction_id',
  'idempotency_key',
  'payload_hash',
  'wallet_id',
  'player_id',
  'round_id',
  'game_id',
  'kind',
  'status',
  'currency',
  'amount',
  'reference_external_transaction_id',
  'reference_transaction_id',
  'failure_code',
  'created_at',
  'processed_at',
].join(', ');

export interface TransactionRow {
  id: string;
  walletId: string;
  providerId?: string | null;
  externalTransactionId?: string | null;
  idempotencyKey?: string | null;
  payloadHash?: string | null;
  playerId?: string;
  roundId?: string | null;
  gameId?: string | null;
  kind?: string;
  status?: string;
  currency?: string;
  amount?: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  failureCode?: string | null;
  processedAt?: Date | null;
}

function pick<T>(value: T | null | undefined, fallback: T | null): T | null {
  return value === undefined ? fallback : value;
}

/**
 * Valores posicionais de uma linha de `wager_transactions`.
 *
 * `OPENING` não recebe identidade externa por padrão; qualquer campo pode ser
 * forçado, inclusive para `null`, para exercitar as constraints.
 */
export function transactionValues(row: TransactionRow): unknown[] {
  const internal = (row.kind ?? 'BET') === 'OPENING';
  const external = pick(row.externalTransactionId, internal ? null : `ext-${row.id}`);
  const provider = pick(row.providerId, internal ? null : 'provider-a');

  return [
    row.id,
    provider,
    external,
    pick(row.idempotencyKey, internal ? null : `${String(provider)}:${String(external)}`),
    pick(row.payloadHash, internal ? null : `hash-${row.id}`),
    row.walletId,
    row.playerId ?? 'player-1',
    pick(row.roundId, internal ? null : 'round-1'),
    pick(row.gameId, internal ? null : 'fortune-chimp'),
    row.kind ?? 'BET',
    row.status ?? 'PENDING',
    row.currency ?? 'BRL',
    row.amount ?? '25.00',
    pick(row.referenceExternalTransactionId, null),
    pick(row.referenceTransactionId, null),
    pick(row.failureCode, null),
    new Date(),
    pick(row.processedAt, null),
  ];
}

export const LEDGER_COLUMNS = [
  'id',
  'wallet_id',
  'transaction_id',
  'direction',
  'currency',
  'amount',
  'balance_before',
  'balance_after',
  'created_at',
].join(', ');

export interface LedgerRow {
  id: string;
  walletId: string;
  transactionId: string;
  direction?: string;
  currency?: string;
  amount?: string;
  balanceBefore?: string;
  balanceAfter?: string;
}

export function ledgerValues(row: LedgerRow): unknown[] {
  return [
    row.id,
    row.walletId,
    row.transactionId,
    row.direction ?? 'DEBIT',
    row.currency ?? 'BRL',
    row.amount ?? '25.00',
    row.balanceBefore ?? '100.00',
    row.balanceAfter ?? '75.00',
    new Date(),
  ];
}

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}
