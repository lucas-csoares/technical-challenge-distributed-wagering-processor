import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroOrmFinancialTransactionManager } from '../../src/infrastructure/persistence/mikro-orm-financial-transaction-manager.js';
import { createFinancialSchema, type FinancialSchema } from './support.js';
import { assertLedgerBalance, openingFixture, persistCredit, persistOpening, requireWallet } from './financial-repository-support.js';

let db: FinancialSchema;
let manager: MikroOrmFinancialTransactionManager;

beforeAll(async () => {
  db = await createFinancialSchema();
  manager = new MikroOrmFinancialTransactionManager(db.orm);
});
afterAll(async () => { await db.close(); });

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function withDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error('Timed out coordinating PostgreSQL locks.')); }, 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A prova é pg_blocking_pids, não o tempo decorrido. O polling só cede a CPU. */
async function waitForBlockedTransactions(count: number): Promise<number[]> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await db.orm.em.fork().execute<{ pid: number }[]>(`
      select distinct a.pid
        from pg_stat_activity a
        join pg_locks l on l.pid = a.pid
       where l.relation = to_regclass(?)
         and l.mode = 'RowShareLock'
         and a.wait_event_type = 'Lock'
         and cardinality(pg_blocking_pids(a.pid)) > 0
    `, [`${db.schema}.wallets`]);
    if (rows.length === count) return rows.map(row => row.pid);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`PostgreSQL did not report ${String(count)} blocked wallet transactions.`);
}

describe('pessimistic locking por wallet no PostgreSQL', () => {
  test('três contextos serializam a mesma wallet e releem saldo após esperar pelo commit', async () => {
    const fixture = openingFixture('10.00');
    await manager.execute(async scope => { await persistOpening(scope, fixture); });
    const locked = signal();
    const release = signal();
    const observed: string[] = [];

    const first = manager.execute(async scope => {
      const wallet = requireWallet(await scope.wallets.findByIdForUpdate(fixture.wallet.id));
      await persistCredit(scope, wallet);
      locked.resolve();
      await release.promise;
    });
    const contenders = [1, 2].map(async () => {
      await locked.promise;
      return manager.execute(async scope => {
        // A tem UPDATE não confirmado; cada identity map guarda o saldo antigo.
        const beforeLock = requireWallet(await scope.wallets.findById(fixture.wallet.id));
        expect(beforeLock.balance.toString()).toBe('10.00');
        const wallet = requireWallet(await scope.wallets.findByIdForUpdate(fixture.wallet.id));
        observed.push(wallet.balance.toString());
        await persistCredit(scope, wallet);
      });
    });
    const completion = Promise.allSettled([first, ...contenders]);
    try {
      await withDeadline(locked.promise);
      const pids = await waitForBlockedTransactions(2);
      expect(new Set(pids).size).toBe(2);
      expect(observed).toEqual([]);
    } finally {
      locked.resolve();
      release.resolve();
      const results = await withDeadline(completion);
      for (const result of results) expect(result.status).toBe('fulfilled');
    }
    expect(observed).toEqual(['10.01', '10.02']);
    await manager.execute(async scope => {
      const wallet = requireWallet(await scope.wallets.findById(fixture.wallet.id));
      expect(wallet.balance.toString()).toBe('10.03');
      expect(wallet.version).toBe(4);
      expect(await scope.ledger.findByWalletId(wallet.id)).toHaveLength(4);
      await assertLedgerBalance(scope, wallet.id);
    });
  }, 20000);

  test('wallets diferentes prosseguem enquanto a primeira transação ainda mantém seu lock', async () => {
    const a = openingFixture();
    const b = openingFixture();
    await manager.execute(async scope => {
      await persistOpening(scope, a);
      await persistOpening(scope, b);
    });
    const locked = signal();
    const release = signal();
    let firstFinished = false;
    const first = manager.execute(async scope => {
      await scope.wallets.findByIdForUpdate(a.wallet.id);
      locked.resolve();
      await release.promise;
      firstFinished = true;
    });
    const second = (async () => {
      await locked.promise;
      await manager.execute(async scope => {
        const wallet = requireWallet(await scope.wallets.findByIdForUpdate(b.wallet.id));
        await persistCredit(scope, wallet);
      });
    })();
    const completion = Promise.allSettled([first, second]);
    try {
      await withDeadline(second);
      expect(firstFinished).toBe(false);
    } finally {
      locked.resolve();
      release.resolve();
      const results = await withDeadline(completion);
      for (const result of results) expect(result.status).toBe('fulfilled');
    }
    await manager.execute(async scope => {
      expect((await scope.wallets.findById(b.wallet.id))?.balance.toString()).toBe('100.01');
      await assertLedgerBalance(scope, a.wallet.id);
      await assertLedgerBalance(scope, b.wallet.id);
    });
  }, 20000);

  test('rollback libera o lock e o próximo contexto observa somente o estado confirmado', async () => {
    const fixture = openingFixture('10.00');
    await manager.execute(async scope => { await persistOpening(scope, fixture); });
    const locked = signal();
    const release = signal();
    const rollbackError = new Error('Intentional lock holder rollback');
    let observed: string | undefined;
    const first = manager.execute(async scope => {
      const wallet = requireWallet(await scope.wallets.findByIdForUpdate(fixture.wallet.id));
      await persistCredit(scope, wallet, '5.00');
      locked.resolve();
      await release.promise;
      throw rollbackError;
    });
    const second = (async () => {
      await locked.promise;
      await manager.execute(async scope => {
        const wallet = requireWallet(await scope.wallets.findByIdForUpdate(fixture.wallet.id));
        observed = wallet.balance.toString();
        await persistCredit(scope, wallet);
      });
    })();
    const completion = Promise.allSettled([first, second]);
    try {
      await withDeadline(locked.promise);
      expect(await waitForBlockedTransactions(1)).toHaveLength(1);
      expect(observed).toBeUndefined();
    } finally {
      locked.resolve();
      release.resolve();
      const [a, b] = await withDeadline(completion);
      expect(a).toEqual({ status: 'rejected', reason: rollbackError });
      expect(b?.status).toBe('fulfilled');
    }
    expect(observed).toBe('10.00');
    await manager.execute(async scope => {
      const wallet = requireWallet(await scope.wallets.findById(fixture.wallet.id));
      expect(wallet.balance.toString()).toBe('10.01');
      expect(wallet.version).toBe(2);
      expect(await scope.ledger.findByWalletId(wallet.id)).toHaveLength(2);
      await assertLedgerBalance(scope, wallet.id);
    });
  }, 20000);
});
