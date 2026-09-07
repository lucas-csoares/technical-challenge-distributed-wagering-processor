import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { WalletAlreadyExistsError } from '../../src/application/financial-errors.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wagering/wager-transaction.js';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction.js';
import { requireWallet } from './financial-repository-support.js';
import {
  command,
  createFinancialContext,
  expectLedgerEntry,
  expectNoLedgerEntry,
  expectWalletMatchesLedger,
  findTransaction,
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

describe('criação de wallet', () => {
  test('abertura com saldo zero nasce na version 1 e sem lançamento', async () => {
    const wallet = await openWallet(context, '0.00');
    const snapshot = await readWallet(context, wallet.walletId);

    expect(snapshot.balance).toBe('0.00');
    expect(snapshot.version).toBe(1);

    const entries = await context.manager.execute((scope) =>
      scope.ledger.findByWalletId(wallet.walletId),
    );

    expect(entries).toHaveLength(0);
  });

  test('abertura positiva credita pelo OPENING e mantém a version 1', async () => {
    const wallet = await openWallet(context, '100.00');
    const snapshot = await readWallet(context, wallet.walletId);

    expect(snapshot.balance).toBe('100.00');
    expect(snapshot.version).toBe(1);

    const entries = await context.manager.execute((scope) =>
      scope.ledger.findByWalletId(wallet.walletId),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.direction).toBe(LedgerDirection.Credit);
    expect(entries[0]?.money.toString()).toBe('100.00');
    expect(entries[0]?.balanceBefore.toString()).toBe('0.00');
    expect(entries[0]?.balanceAfter.toString()).toBe('100.00');

    await expectWalletMatchesLedger(context, wallet.walletId);
  });

  test('duas aberturas simultâneas do mesmo player produzem uma única wallet', async () => {
    const playerId = crypto.randomUUID();
    const opening = { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } };

    const raced = await Promise.all([
      outcome(context.createWallet.execute(opening)),
      outcome(context.createWallet.execute(opening)),
    ]);

    const conflicts = raced.filter((result) => result instanceof WalletAlreadyExistsError);

    expect(conflicts).toHaveLength(1);

    const winner = raced.find((result) => !(result instanceof Error));

    if (winner === undefined || winner instanceof Error) {
      throw new Error('Expected exactly one wallet to be created.');
    }

    await expectWalletMatchesLedger(context, winner.walletId);
  });
});

describe('operações que movem saldo', () => {
  test('BET debita, incrementa a version e produz um lançamento DEBIT', async () => {
    const wallet = await openWallet(context, '100.00');

    const bet = await context.processWager.execute(command(wallet));

    expect(bet.status).toBe(WagerTransactionStatus.Processed);
    expect(bet.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(bet.idempotentReplay).toBe(false);

    const snapshot = await readWallet(context, wallet.walletId);

    expect(snapshot.balance).toBe('75.00');
    expect(snapshot.version).toBe(2);

    await expectLedgerEntry(context, wallet.walletId, bet.transactionId, {
      direction: LedgerDirection.Debit,
      amount: '25.00',
      balanceBefore: '100.00',
      balanceAfter: '75.00',
    });
    await expectWalletMatchesLedger(context, wallet.walletId);
  });

  test('WIN credita, incrementa a version e produz um lançamento CREDIT', async () => {
    const wallet = await openWallet(context, '100.00');

    const win = await context.processWager.execute(
      command(wallet, { kind: WagerTransactionKind.Win }),
    );

    expect(win.status).toBe(WagerTransactionStatus.Processed);
    expect(win.balance).toEqual({ amount: '125.00', currency: 'BRL' });

    const snapshot = await readWallet(context, wallet.walletId);

    expect(snapshot.balance).toBe('125.00');
    expect(snapshot.version).toBe(2);

    await expectLedgerEntry(context, wallet.walletId, win.transactionId, {
      direction: LedgerDirection.Credit,
      amount: '25.00',
      balanceBefore: '100.00',
      balanceAfter: '125.00',
    });
    await expectWalletMatchesLedger(context, wallet.walletId);
  });

  test('WIN que referencia uma BET processada registra a referência interna', async () => {
    const wallet = await openWallet(context, '100.00');

    const bet = await context.processWager.execute(
      command(wallet, { externalTransactionId: 'referenced-bet' }),
    );
    const win = await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Win,
        referenceExternalTransactionId: 'referenced-bet',
      }),
    );

    expect(win.status).toBe(WagerTransactionStatus.Processed);

    const persisted = await findTransaction(context, win.transactionId);

    expect(persisted.referenceExternalTransactionId).toBe('referenced-bet');
    expect(persisted.referenceTransactionId).toBe(bet.transactionId);

    await expectWalletMatchesLedger(context, wallet.walletId);
  });
});

describe('operações sem efeito financeiro', () => {
  test('LOSS é processada sem mover saldo, version ou ledger', async () => {
    const wallet = await openWallet(context, '100.00');
    const before = await readWallet(context, wallet.walletId);

    const loss = await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Loss,
        money: { amount: '0.00', currency: 'BRL' },
      }),
    );

    expect(loss.status).toBe(WagerTransactionStatus.Processed);
    expect(loss.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    const after = await readWallet(context, wallet.walletId);

    expect(after.balance).toBe(before.balance);
    expect(after.version).toBe(before.version);

    await expectNoLedgerEntry(context, wallet.walletId, loss.transactionId);
    await expectWalletMatchesLedger(context, wallet.walletId);
  });

  test('WIN referenciando transação inexistente fica PENDING_REFERENCE', async () => {
    const wallet = await openWallet(context, '100.00');
    const before = await readWallet(context, wallet.walletId);

    const pending = await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Win,
        referenceExternalTransactionId: 'win-reference-not-yet-received',
      }),
    );

    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    expect(pending.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    const persisted = await findTransaction(context, pending.transactionId);

    expect(persisted.referenceExternalTransactionId).toBe('win-reference-not-yet-received');
    expect(persisted.referenceTransactionId).toBeUndefined();

    const after = await readWallet(context, wallet.walletId);

    expect(after.balance).toBe(before.balance);
    expect(after.version).toBe(before.version);

    await expectNoLedgerEntry(context, wallet.walletId, pending.transactionId);
    await expectWalletMatchesLedger(context, wallet.walletId);
  });
});

describe('rejeições de negócio', () => {
  test('moeda divergente da wallet é rejeitada com CURRENCY_MISMATCH', async () => {
    const wallet = await openWallet(context, '100.00');
    const before = await readWallet(context, wallet.walletId);

    const rejected = await context.processWager.execute(
      command(wallet, { money: { amount: '25.00', currency: 'USD' } }),
    );

    // A operação é uma rejeição de negócio auditável, não uma exceção: o
    // provedor recebe um código estável e a transação fica persistida.
    expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected.failureCode).toBe('CURRENCY_MISMATCH');
    expect(rejected.idempotentReplay).toBe(false);
    expect(rejected.balance).toEqual({ amount: before.balance, currency: 'BRL' });

    const after = await readWallet(context, wallet.walletId);

    expect(after.balance).toBe(before.balance);
    expect(after.version).toBe(before.version);

    await expectNoLedgerEntry(context, wallet.walletId, rejected.transactionId);
    await expectWalletMatchesLedger(context, wallet.walletId);
  });

  test('wallet de outro player é rejeitada com REFERENCE_MISMATCH', async () => {
    const wallet = await openWallet(context, '100.00');
    const before = await readWallet(context, wallet.walletId);

    const rejected = await context.processWager.execute(
      command({ walletId: wallet.walletId, playerId: crypto.randomUUID() }),
    );

    expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected.failureCode).toBe('REFERENCE_MISMATCH');
    expect(rejected.balance).toEqual({ amount: before.balance, currency: 'BRL' });

    const after = await readWallet(context, wallet.walletId);

    expect(after.balance).toBe(before.balance);
    expect(after.version).toBe(before.version);

    await expectNoLedgerEntry(context, wallet.walletId, rejected.transactionId);
    await expectWalletMatchesLedger(context, wallet.walletId);
  });

  test('BET sem saldo é rejeitada com INSUFFICIENT_FUNDS', async () => {
    const wallet = await openWallet(context, '10.00');
    const before = await readWallet(context, wallet.walletId);

    const rejected = await context.processWager.execute(
      command(wallet, { money: { amount: '25.00', currency: 'BRL' } }),
    );

    expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected.failureCode).toBe('INSUFFICIENT_FUNDS');

    const after = await readWallet(context, wallet.walletId);

    expect(after.balance).toBe(before.balance);
    expect(after.version).toBe(before.version);

    await expectNoLedgerEntry(context, wallet.walletId, rejected.transactionId);
    await expectWalletMatchesLedger(context, wallet.walletId);
  });
});

describe('replay histórico', () => {
  test('repetir uma operação devolve o saldo observado na época, não o atual', async () => {
    const wallet = await openWallet(context, '100.00');
    const original = command(wallet, {
      externalTransactionId: 'history-bet',
      idempotencyKey: 'history-bet',
    });

    const first = await context.processWager.execute(original);

    expect(first.idempotentReplay).toBe(false);
    expect(first.balance).toEqual({ amount: '75.00', currency: 'BRL' });

    // Uma segunda operação move o saldo para longe do resultado original.
    await context.processWager.execute(command(wallet));

    const currentBalance = await readWallet(context, wallet.walletId);

    expect(currentBalance.balance).toBe('50.00');

    const replay = await context.processWager.execute(original);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.balance).toEqual(first.balance);
    expect(replay.balance.amount).not.toBe(currentBalance.balance);

    // O replay não reaplicou o débito.
    const after = await readWallet(context, wallet.walletId);

    expect(after.balance).toBe('50.00');
    await expectWalletMatchesLedger(context, wallet.walletId);
  });
});

describe('invariante final', () => {
  test('a wallet resultante equivale ao saldo reconstruído pelo ledger', async () => {
    const wallet = await openWallet(context, '100.00');

    await context.processWager.execute(command(wallet));
    await context.processWager.execute(command(wallet, { kind: WagerTransactionKind.Win }));
    await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Loss,
        money: { amount: '0.00', currency: 'BRL' },
      }),
    );

    await expectWalletMatchesLedger(context, wallet.walletId);

    const persisted = await context.manager.execute(async (scope) =>
      requireWallet(await scope.wallets.findById(wallet.walletId)),
    );

    expect(persisted.balance.toString()).toBe('100.00');
    expect(persisted.version).toBe(3);
  });
});
