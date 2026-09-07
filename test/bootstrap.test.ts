import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { bootstrap } from '../src/main.js';

test('starts an HTTP server without exposing business endpoints', async () => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Bootstrap tests require NODE_ENV=test.');
  }

  const app = await bootstrap(0);
  const orm = app.get(MikroORM);

  try {
    const response = await fetch(`${await app.getUrl()}/`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ statusCode: 404 });
    expect(await orm.isConnected()).toBe(true);
  } finally {
    await app.close();
  }
  expect(await orm.isConnected()).toBe(false);
});

test.each([-1, 65536, 1.5, Number.NaN])('rejects invalid port %s', async (port) => {
  expect.assertions(1);

  try {
    await bootstrap(port);
  } catch (error) {
    expect(error).toMatchObject({ message: 'PORT must be an integer between 0 and 65535.' });
  }
});
