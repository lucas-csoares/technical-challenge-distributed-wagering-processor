import { expect, test } from 'bun:test';
import { createDatabaseOptions } from '../src/infrastructure/persistence/database.config.js';

const development = {
  NODE_ENV: 'development',
  DB_HOST: '127.0.0.1',
  DB_PORT: '5432',
  DB_NAME: 'wagering',
  DB_USER: 'local',
  DB_PASSWORD: 'example-only',
};

test.each(['HOST', 'PORT', 'NAME', 'USER', 'PASSWORD'])('requires DB_%s', (name) => {
  expect(() => createDatabaseOptions({ ...development, [`DB_${name}`]: '' }))
    .toThrow(`DB_${name} is required.`);
});

test.each(['0', '65536', '1.5', 'NaN', '5e3'])('rejects database port %s', (port) => {
  expect(() => createDatabaseOptions({ ...development, DB_PORT: port }))
    .toThrow('DB_PORT must be an integer');
});

test('does not fall back to development credentials in test mode', () => {
  expect(() => createDatabaseOptions({ ...development, NODE_ENV: 'test' }))
    .toThrow('TEST_DB_HOST is required.');
});

test.each(['wagering', 'shared_test'])('refuses an unsafe test database %s', (dbName) => {
  expect(() => createDatabaseOptions({
    ...development,
    NODE_ENV: 'test',
    DB_NAME: 'shared_test',
    TEST_DB_HOST: '127.0.0.1',
    TEST_DB_PORT: '5433',
    TEST_DB_NAME: dbName,
    TEST_DB_USER: 'local_test',
    TEST_DB_PASSWORD: 'example-only',
  })).toThrow('TEST_DB_NAME must end with _test and differ from DB_NAME.');
});

test('keeps test fixtures out of application migrations and global context disabled', () => {
  const config = createDatabaseOptions(development);
  expect(config.allowGlobalContext).toBe(false);
  expect(config.ensureDatabase).toBe(false);
  expect(config.migrations?.path).not.toContain('test');
  expect(config.migrations?.migrationsList).toBeUndefined();
});
