import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { createDatabaseOptions } from '../../src/infrastructure/persistence/database.config.js';
import { Migration20260906000000 } from '../fixtures/Migration20260906000000.js';

test('connects, migrates up/down, commits, rolls back and closes PostgreSQL', async () => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Persistence tests require NODE_ENV=test.');
  }

  const options = createDatabaseOptions();
  const schema = `infra_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const orm = await MikroORM.init({
    ...options,
    schema,
    migrations: {
      ...options.migrations,
      schema,
      migrationsList: [Migration20260906000000],
      snapshot: false,
    },
  });
  let schemaCreated = false;

  async function assertTestDatabase(): Promise<void> {
    const rows = await orm.em.fork().execute<{ name: string }[]>('select current_database() as name');
    if (
      process.env.NODE_ENV !== 'test' ||
      rows[0]?.name !== options.dbName ||
      !options.dbName?.endsWith('_test') ||
      options.dbName === process.env.DB_NAME ||
      !/^infra_test_[a-f0-9]{32}$/.test(schema)
    ) {
      throw new Error('Refusing test schema changes outside the configured test database.');
    }
  }

  try {
    await assertTestDatabase();
    expect(await orm.isConnected()).toBe(true);
    await orm.em.fork().execute(`create schema "${schema}"`);
    schemaCreated = true;

    const migrator = orm.migrator;
    expect(await migrator.getPending()).toHaveLength(1);
    await migrator.up();
    expect(await migrator.getExecuted()).toHaveLength(1);
    expect(await migrator.getPending()).toHaveLength(0);

    const table = `"${schema}".persistence_probe`;
    await orm.em.fork().transactional(async (em) => {
      await em.execute(`insert into ${table} (id, value) values (?, ?)`, ['committed', 'saved']);
    });
    expect(await orm.em.fork().execute(`select id, value from ${table}`)).toEqual([
      { id: 'committed', value: 'saved' },
    ]);

    const rollbackError = new Error('Intentional rollback');
    let observedError: unknown;
    try {
      await orm.em.fork().transactional(async (em) => {
        await em.execute(`insert into ${table} (id, value) values (?, ?)`, ['rolled-back', 'discarded']);
        throw rollbackError;
      });
    } catch (error) {
      observedError = error;
    }
    expect(observedError).toBe(rollbackError);
    expect(await orm.em.fork().execute(`select id from ${table} order by id`)).toEqual([
      { id: 'committed' },
    ]);

    await migrator.down();
    expect(await migrator.getExecuted()).toHaveLength(0);
    expect(await migrator.getPending()).toHaveLength(1);
    const rows = await orm.em.fork().execute<{ name: string | null }[]>(
      'select to_regclass(?)::text as name', [`${schema}.persistence_probe`],
    );
    expect(rows[0]?.name).toBeNull();
  } finally {
    try {
      if (schemaCreated) {
        await assertTestDatabase();
        await orm.em.fork().execute(`drop schema "${schema}" cascade`);
      }
    } finally {
      await orm.close();
    }
  }

  expect(await orm.isConnected()).toBe(false);
}, 30000);
