import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { bootstrap } from '../src/main.js';
import { FinancialTransactionManager } from '../src/application/ports/financial-transaction-manager.js';

test('starts an HTTP server with the financial scope wired', async () => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Bootstrap tests require NODE_ENV=test.');
  }

  const app = await bootstrap(0);
  const orm = app.get(MikroORM);

  try {
    const response = await fetch(`${await app.getUrl()}/`);
    expect(response.status).toBe(404);
    // Rota inexistente também passa pelo filtro: o corpo de erro é sempre
    // `{ code, message }`, sem `statusCode` nem detalhes de framework.
    expect(await response.json()).toEqual({
      code: 'NOT_FOUND',
      message: 'Cannot GET /',
    });
    expect(await orm.isConnected()).toBe(true);
    const manager = app.get(FinancialTransactionManager);
    expect(await manager.execute(async scope => Promise.resolve(Object.keys(scope).sort())))
      .toEqual(['inbox', 'ledger', 'outbox', 'transactions', 'wallets']);
  } finally {
    await app.close();
  }
  expect(await orm.isConnected()).toBe(false);
}, 15000);

test.each([-1, 65536, 1.5, Number.NaN])('rejects invalid port %s', async (port) => {
  expect.assertions(1);

  try {
    await bootstrap(port);
  } catch (error) {
    expect(error).toMatchObject({ message: 'PORT must be an integer between 0 and 65535.' });
  }
});
