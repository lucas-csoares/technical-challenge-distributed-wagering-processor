import { afterAll, beforeAll, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { createDatabaseOptions } from '../../src/infrastructure/persistence/database.config.js';

/**
 * Reversibilidade da migration financeira contra PostgreSQL real.
 *
 * O teste usa o migrator de verdade nos dois sentidos. O schema isolado é
 * removido apenas no `finally`, depois que o `down()` já foi verificado — um
 * `drop schema cascade` faria os objetos desaparecerem de qualquer jeito e não
 * provaria nada sobre o `down()`.
 */

const FINANCIAL_TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
];

const CRITICAL_CONSTRAINTS = [
  'wallets_player_currency_unique',
  'wallets_balance_not_negative_check',
  'wallets_version_check',
  'wager_transactions_failure_code_check',
  'wager_transactions_internal_identity_check',
  'wager_transactions_internal_reference_check',
  'wager_transactions_wallet_fkey',
  'wallet_ledger_entries_arithmetic_check',
  'wallet_ledger_entries_transaction_unique',
  'wallet_ledger_entries_transaction_fkey',
];

const CRITICAL_INDEXES = [
  'wager_transactions_provider_external_unique',
  'wager_transactions_idempotency_key_unique',
  'wager_transactions_opening_per_wallet_unique',
  'wager_transactions_wallet_created_idx',
  'wager_transactions_pending_reference_idx',
  'wager_transactions_processed_reversal_unique',
  'wallet_ledger_entries_wallet_idx',
  'outbox_messages_pending_idx',
  'wager_transactions_pending_due_idx',
  'inbox_messages_pkey',
];

const LEDGER_TRIGGERS = [
  'wallet_ledger_entries_no_update',
  'wallet_ledger_entries_no_delete',
  'wallet_ledger_entries_no_truncate',
];

const IMMUTABILITY_FUNCTION = 'wallet_ledger_entries_reject_mutation';

let orm: MikroORM;
let schema: string;
let schemaCreated = false;

async function tableNames(): Promise<string[]> {
  const rows = await orm.em
    .fork()
    .execute<
      { name: string }[]
    >('select tablename as name from pg_tables where schemaname = ?', [schema]);

  return rows.map((row) => row.name).sort();
}

async function constraintNames(): Promise<string[]> {
  const rows = await orm.em.fork().execute<{ name: string }[]>(
    `select c.conname as name
       from pg_constraint c
       join pg_namespace n on n.oid = c.connamespace
      where n.nspname = ?`,
    [schema],
  );

  return rows.map((row) => row.name);
}

async function indexNames(): Promise<string[]> {
  const rows = await orm.em
    .fork()
    .execute<
      { name: string }[]
    >('select indexname as name from pg_indexes where schemaname = ?', [schema]);

  return rows.map((row) => row.name);
}

async function triggerNames(): Promise<string[]> {
  const rows = await orm.em.fork().execute<{ name: string }[]>(
    `select t.tgname as name
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ? and not t.tgisinternal`,
    [schema],
  );

  return rows.map((row) => row.name);
}

async function functionNames(): Promise<string[]> {
  const rows = await orm.em.fork().execute<{ name: string }[]>(
    `select p.proname as name
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = ?`,
    [schema],
  );

  return rows.map((row) => row.name);
}

async function assertTestDatabase(): Promise<void> {
  const options = createDatabaseOptions();
  const rows = await orm.em
    .fork()
    .execute<{ name: string }[]>('select current_database() as name');

  if (
    process.env.NODE_ENV !== 'test' ||
    rows[0]?.name !== options.dbName ||
    !options.dbName?.endsWith('_test') ||
    options.dbName === process.env.DB_NAME ||
    !/^migration_test_[a-f0-9]{32}$/.test(schema)
  ) {
    throw new Error('Refusing test schema changes outside the configured test database.');
  }
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Integration tests require NODE_ENV=test.');
  }

  const options = createDatabaseOptions();
  schema = `migration_test_${crypto.randomUUID().replaceAll('-', '')}`;
  orm = await MikroORM.init({
    ...options,
    schema,
    migrations: { ...options.migrations, schema, snapshot: false },
  });

  await assertTestDatabase();
  await orm.em.fork().execute(`create schema "${schema}"`);
  schemaCreated = true;
});

afterAll(async () => {
  try {
    if (schemaCreated) {
      await assertTestDatabase();
      await orm.em.fork().execute(`drop schema "${schema}" cascade`);
    }
  } finally {
    await orm.close();
  }
});

test('a migration financeira sobe, reverte e sobe de novo', async () => {
  const migrator = orm.migrator;

  expect(await tableNames()).toEqual([]);
  expect(await migrator.getPending()).toHaveLength(4);

  await migrator.up();

  expect(await migrator.getExecuted()).toHaveLength(4);
  expect(await migrator.getPending()).toHaveLength(0);

  const tablesAfterUp = await tableNames();
  for (const table of FINANCIAL_TABLES) {
    expect(tablesAfterUp).toContain(table);
  }

  const constraintsAfterUp = await constraintNames();
  for (const constraint of CRITICAL_CONSTRAINTS) {
    expect(constraintsAfterUp).toContain(constraint);
  }

  const indexesAfterUp = await indexNames();
  for (const index of CRITICAL_INDEXES) {
    expect(indexesAfterUp).toContain(index);
  }

  const triggersAfterUp = await triggerNames();
  for (const trigger of LEDGER_TRIGGERS) {
    expect(triggersAfterUp).toContain(trigger);
  }

  expect(await functionNames()).toContain(IMMUTABILITY_FUNCTION);

  await migrator.down();
  await migrator.down();
  await migrator.down();
  await migrator.down();

  expect(await migrator.getExecuted()).toHaveLength(0);
  expect(await migrator.getPending()).toHaveLength(4);

  // O `down()` precisa levar embora tudo o que o `up()` criou, inclusive a
  // função dos triggers, que não some junto com a tabela.
  const tablesAfterDown = await tableNames();
  for (const table of FINANCIAL_TABLES) {
    expect(tablesAfterDown).not.toContain(table);
  }

  expect(await triggerNames()).toEqual([]);
  expect(await functionNames()).not.toContain(IMMUTABILITY_FUNCTION);

  const constraintsAfterDown = await constraintNames();
  for (const constraint of CRITICAL_CONSTRAINTS) {
    expect(constraintsAfterDown).not.toContain(constraint);
  }

  const indexesAfterDown = await indexNames();
  for (const index of CRITICAL_INDEXES) {
    expect(indexesAfterDown).not.toContain(index);
  }

  await migrator.up();

  expect(await migrator.getExecuted()).toHaveLength(4);
  expect(await functionNames()).toContain(IMMUTABILITY_FUNCTION);
  expect(await migrator.getPending()).toHaveLength(0);

  const tablesAfterReapply = await tableNames();
  for (const table of FINANCIAL_TABLES) {
    expect(tablesAfterReapply).toContain(table);
  }

  const constraintsAfterReapply = await constraintNames();
  for (const constraint of CRITICAL_CONSTRAINTS) {
    expect(constraintsAfterReapply).toContain(constraint);
  }

  const indexesAfterReapply = await indexNames();
  for (const index of CRITICAL_INDEXES) {
    expect(indexesAfterReapply).toContain(index);
  }

  const triggersAfterReapply = await triggerNames();
  for (const trigger of LEDGER_TRIGGERS) {
    expect(triggersAfterReapply).toContain(trigger);
  }
}, 60000);

