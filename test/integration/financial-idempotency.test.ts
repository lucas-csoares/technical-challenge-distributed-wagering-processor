import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
} from '../../src/application/financial-errors.js';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction.js';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction.js';
import {
  command,
  createFinancialContext,
  expectWalletMatchesLedger,
  openWallet,
  outcome,
  readWallet,
  type FinancialContext,
} from './financial-use-case-support.js';

let context: FinancialContext;

beforeAll(async () => {
  context = await createFinancialContext();
});

afterAll(async () => {
  await context.db.close();
});

async function ledgerEntries(walletId: string) {
  return context.manager.execute((scope) => scope.ledger.findByWalletId(walletId));
}

describe('idempotência sob concorrência', () => {
  test('a mesma aposta enviada 50 vezes em paralelo debita uma única vez', async () => {
    const wallet = await openWallet(context, '100.00');
    const input = command(wallet, {
      idempotencyKey: 'fifty-duplicates',
      externalTransactionId: 'fifty-duplicates',
    });

    const results = await Promise.all(
      Array.from({ length: 50 }, () => context.processWager.execute(input)),
    );

    const applied = results.filter((result) => !result.idempotentReplay);
    const replays = results.filter((result) => result.idempotentReplay);

    expect(applied).toHaveLength(1);
    expect(replays).toHaveLength(49);

    // Todas as 50 respostas descrevem o mesmo resultado.
    const transactionIds = new Set(results.map((result) => result.transactionId));

    expect(transactionIds.size).toBe(1);
    expect(results.every((result) => result.balance.amount === '75.00')).toBe(true);

    const snapshot = await readWallet(context, wallet.walletId);

    expect(snapshot.balance).toBe('75.00');
    expect(snapshot.version).toBe(2);

    const debits = (await ledgerEntries(wallet.walletId)).filter(
      (entry) => entry.direction === LedgerDirection.Debit,
    );

    expect(debits).toHaveLength(1);
    await expectWalletMatchesLedger(context, wallet.walletId);
  });

  test('a mesma chave com payload divergente é conflito, não replay', async () => {
    const first = await openWallet(context, '100.00');
    const second = await openWallet(context, '100.00');

    const results = await Promise.all([
      outcome(
        context.processWager.execute(command(first, { idempotencyKey: 'divergent-payload' })),
      ),
      outcome(
        context.processWager.execute(command(second, { idempotencyKey: 'divergent-payload' })),
      ),
    ]);

    const conflicts = results.filter((result) => result instanceof IdempotencyConflictError);

    expect(conflicts).toHaveLength(1);

    await expectWalletMatchesLedger(context, first.walletId);
    await expectWalletMatchesLedger(context, second.walletId);
  });

  test('o mesmo external id do mesmo provider é conflito de identidade', async () => {
    const first = await openWallet(context, '100.00');
    const second = await openWallet(context, '100.00');
    const externalTransactionId = crypto.randomUUID();

    const results = await Promise.all([
      outcome(context.processWager.execute(command(first, { externalTransactionId }))),
      outcome(context.processWager.execute(command(second, { externalTransactionId }))),
    ]);

    const conflicts = results.filter(
      (result) => result instanceof ExternalTransactionConflictError,
    );

    expect(conflicts).toHaveLength(1);

    await expectWalletMatchesLedger(context, first.walletId);
    await expectWalletMatchesLedger(context, second.walletId);
  });
});

describe('disputa pelo saldo da mesma wallet', () => {
  test('duas apostas de 80.00 sobre 100.00 deixam saldo 20.00 e um único débito', async () => {
    const wallet = await openWallet(context, '100.00');
    const bet = { amount: '80.00', currency: 'BRL' };

    const results = await Promise.all([
      context.processWager.execute(command(wallet, { money: bet })),
      context.processWager.execute(command(wallet, { money: bet })),
    ]);

    const processed = results.filter(
      (result) => result.status === WagerTransactionStatus.Processed,
    );
    const rejected = results.filter(
      (result) => result.status === WagerTransactionStatus.Rejected,
    );

    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.failureCode).toBe('INSUFFICIENT_FUNDS');

    const snapshot = await readWallet(context, wallet.walletId);

    expect(snapshot.balance).toBe('20.00');
    expect(snapshot.version).toBe(2);

    const debits = (await ledgerEntries(wallet.walletId)).filter(
      (entry) => entry.direction === LedgerDirection.Debit,
    );

    expect(debits).toHaveLength(1);
    expect(debits[0]?.money.toString()).toBe('80.00');

    await expectWalletMatchesLedger(context, wallet.walletId);
  });

  test('wallets distintas são processadas em paralelo sem interferência', async () => {
    const wallets = await Promise.all([
      openWallet(context, '100.00'),
      openWallet(context, '100.00'),
      openWallet(context, '100.00'),
    ]);

    await Promise.all(
      wallets.map((wallet) => context.processWager.execute(command(wallet))),
    );

    for (const wallet of wallets) {
      const snapshot = await readWallet(context, wallet.walletId);

      expect(snapshot.balance).toBe('75.00');
      expect(snapshot.version).toBe(2);

      await expectWalletMatchesLedger(context, wallet.walletId);
    }
  });
});
