import { join } from 'node:path';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { inboxMessageSchema } from './entities/inbox-message.record.js';
import { outboxMessageSchema } from './entities/outbox-message.record.js';
import { wagerTransactionSchema } from './entities/wager-transaction.record.js';
import { walletLedgerEntrySchema } from './entities/wallet-ledger-entry.record.js';
import { walletSchema } from './entities/wallet.record.js';

export function createDatabaseOptions(env: NodeJS.ProcessEnv = process.env) {
  const prefix = env.NODE_ENV === 'test' ? 'TEST_DB_' : 'DB_';

  function required(name: string): string {
    const key = `${prefix}${name}`;
    const value = env[key];

    if (!value?.trim()) {
      throw new Error(`${key} is required.`);
    }

    return value;
  }

  const host = required('HOST');
  const portValue = required('PORT');
  const dbName = required('NAME');
  const user = required('USER');
  const password = required('PASSWORD');
  const port = Number(portValue);

  if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${prefix}PORT must be an integer between 1 and 65535.`);
  }

  if (env.NODE_ENV === 'test' && (!dbName.endsWith('_test') || dbName === env.DB_NAME)) {
    throw new Error('TEST_DB_NAME must end with _test and differ from DB_NAME.');
  }

  return defineConfig({
    host,
    port,
    dbName,
    user,
    password,
    entities: [
      walletSchema,
      wagerTransactionSchema,
      walletLedgerEntrySchema,
      inboxMessageSchema,
      outboxMessageSchema,
    ],
    allowGlobalContext: false,
    ensureDatabase: false,
    debug: false,
    logger: () => undefined,
    pool: { min: 0, max: 5 },
    driverOptions: { connectionTimeoutMillis: 5000 },
    extensions: [Migrator],
    migrations: {
      path: join(import.meta.dirname, 'migrations'),
      glob: 'Migration[0-9]*.{ts,js}',
      transactional: true,
      allOrNothing: true,
      emit: 'ts',
    },
  });
}
