import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wagering/wager-transaction.js';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction.js';
import {
  command,
  createFinancialContext,
  expectLedgerEntry,
  expectNoLedgerEntry,
  expectWalletMatchesLedger,
  findTransaction,
  openWallet,
  readWallet,
  type FinancialContext,
  type OpenedWallet,
} from './financial-use-case-support.js';

let context: FinancialContext;

beforeAll(async () => {
  context = await createFinancialContext();
});

afterAll(async () => {
  await context.db.close();
});

/** `BET` processada de `25.00`, ponto de partida das reversões. */
async function processedBet(wallet: OpenedWallet, externalTransactionId: string) {
  return context.processWager.execute(command(wallet, { externalTransactionId }));
}

describe('REFUND', () => {
  test('referência ainda inexistente fica PENDING_REFERENCE, sem tocar o saldo', async () => {
    const wallet = await openWallet(context, '100.00');
    const before = await readWallet(context, wallet.walletId);

    const pending = await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'refund-reference-not-yet-received',
      }),
    );

    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    expect(pending.balance).toEqual({ amount: before.balance, currency: 'BRL' });

    const persisted = await findTransaction(context, pending.transactionId);

    expect(persisted.referenceExternalTransactionId).toBe('refund-reference-not-yet-received');
    expect(persisted.referenceTransactionId).toBeUndefined();

    const after = await readWallet(context, wallet.walletId);

    expect(after.balance).toBe(before.balance);
    expect(after.version).toBe(before.version);

    await expectNoLedgerEntry(context, wallet.walletId, pending.transactionId);
    await expectWalletMatchesLedger(context, wallet.walletId);
  });

  test('estorna a BET integralmente com um lançamento CREDIT', async () => {
    const wallet = await openWallet(context, '100.00');
    const bet = await processedBet(wallet, 'refund-bet');

    const refund = await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'refund-bet',
      }),
    );

    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    const persisted = await findTransaction(context, refund.transactionId);

    expect(persisted.referenceTransactionId).toBe(bet.transactionId);

    const snapshot = await readWallet(context, wallet.walletId);

    expect(snapshot.balance).toBe('100.00');
    expect(snapshot.version).toBe(3);

    await expectLedgerEntry(context, wallet.walletId, refund.transactionId, {
      direction: LedgerDirection.Credit,
      amount: '25.00',
      balanceBefore: '75.00',
      balanceAfter: '100.00',
    });
    await expectWalletMatchesLedger(context, wallet.walletId);
  });

  test('valor diferente da referência é rejeitado como reversão parcial', async () => {
    const wallet = await openWallet(context, '100.00');
    await processedBet(wallet, 'partial-refund-bet');

    const before = await readWallet(context, wallet.walletId);

    const rejected = await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Refund,
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: 'partial-refund-bet',
      }),
    );

    expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');

    const after = await readWallet(context, wallet.walletId);

    expect(after.balance).toBe(before.balance);
    expect(after.version).toBe(before.version);

    await expectNoLedgerEntry(context, wallet.walletId, rejected.transactionId);
    await expectWalletMatchesLedger(context, wallet.walletId);
  });

  test('dois REFUND simultâneos da mesma BET produzem um estorno só', async () => {
    const wallet = await openWallet(context, '100.00');
    await processedBet(wallet, 'duplicate-refund-bet');

    const refunds = await Promise.all([
      context.processWager.execute(
        command(wallet, {
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'duplicate-refund-bet',
        }),
      ),
      context.processWager.execute(
        command(wallet, {
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'duplicate-refund-bet',
        }),
      ),
    ]);

    const processed = refunds.filter(
      (result) => result.status === WagerTransactionStatus.Processed,
    );
    const rejected = refunds.filter(
      (result) => result.status === WagerTransactionStatus.Rejected,
    );

    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.failureCode).toBe('REFERENCE_ALREADY_REVERSED');

    // O perdedor da corrida é persistido e auditável, mas não move dinheiro.
    const loser = rejected[0];

    if (loser === undefined) {
      throw new Error('Expected one rejected refund.');
    }

    await expectNoLedgerEntry(context, wallet.walletId, loser.transactionId);

    const snapshot = await readWallet(context, wallet.walletId);

    expect(snapshot.balance).toBe('100.00');
    await expectWalletMatchesLedger(context, wallet.walletId);
  });
});

describe('ROLLBACK inverte a direção da referência', () => {
  test('ROLLBACK de BET credita de volta', async () => {
    const wallet = await openWallet(context, '100.00');
    const bet = await processedBet(wallet, 'rollback-bet');

    const rollback = await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'rollback-bet',
      }),
    );

    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    const persisted = await findTransaction(context, rollback.transactionId);

    expect(persisted.referenceTransactionId).toBe(bet.transactionId);

    const snapshot = await readWallet(context, wallet.walletId);

    expect(snapshot.balance).toBe('100.00');
    expect(snapshot.version).toBe(3);

    // BET debitou; o rollback credita exatamente o mesmo valor.
    await expectLedgerEntry(context, wallet.walletId, bet.transactionId, {
      direction: LedgerDirection.Debit,
      amount: '25.00',
      balanceBefore: '100.00',
      balanceAfter: '75.00',
    });
    await expectLedgerEntry(context, wallet.walletId, rollback.transactionId, {
      direction: LedgerDirection.Credit,
      amount: '25.00',
      balanceBefore: '75.00',
      balanceAfter: '100.00',
    });
    await expectWalletMatchesLedger(context, wallet.walletId);
  });

  test('ROLLBACK de WIN debita', async () => {
    const wallet = await openWallet(context, '100.00');

    const win = await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Win,
        externalTransactionId: 'rollback-win',
      }),
    );

    expect(win.balance).toEqual({ amount: '125.00', currency: 'BRL' });

    const rollback = await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'rollback-win',
      }),
    );

    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    const persisted = await findTransaction(context, rollback.transactionId);

    expect(persisted.referenceTransactionId).toBe(win.transactionId);

    const snapshot = await readWallet(context, wallet.walletId);

    expect(snapshot.balance).toBe('100.00');
    expect(snapshot.version).toBe(3);

    await expectLedgerEntry(context, wallet.walletId, win.transactionId, {
      direction: LedgerDirection.Credit,
      amount: '25.00',
      balanceBefore: '100.00',
      balanceAfter: '125.00',
    });
    await expectLedgerEntry(context, wallet.walletId, rollback.transactionId, {
      direction: LedgerDirection.Debit,
      amount: '25.00',
      balanceBefore: '125.00',
      balanceAfter: '100.00',
    });
    await expectWalletMatchesLedger(context, wallet.walletId);
  });

  test('ROLLBACK de REFUND debita', async () => {
    const wallet = await openWallet(context, '100.00');
    await processedBet(wallet, 'rollback-refund-bet');

    const refund = await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Refund,
        externalTransactionId: 'rollback-refund',
        referenceExternalTransactionId: 'rollback-refund-bet',
      }),
    );

    expect(refund.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    const rollback = await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'rollback-refund',
      }),
    );

    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.balance).toEqual({ amount: '75.00', currency: 'BRL' });

    const persisted = await findTransaction(context, rollback.transactionId);

    expect(persisted.referenceTransactionId).toBe(refund.transactionId);

    const snapshot = await readWallet(context, wallet.walletId);

    expect(snapshot.balance).toBe('75.00');
    expect(snapshot.version).toBe(4);

    // REFUND creditou; o rollback do REFUND debita de volta.
    await expectLedgerEntry(context, wallet.walletId, refund.transactionId, {
      direction: LedgerDirection.Credit,
      amount: '25.00',
      balanceBefore: '75.00',
      balanceAfter: '100.00',
    });
    await expectLedgerEntry(context, wallet.walletId, rollback.transactionId, {
      direction: LedgerDirection.Debit,
      amount: '25.00',
      balanceBefore: '100.00',
      balanceAfter: '75.00',
    });
    await expectWalletMatchesLedger(context, wallet.walletId);
  });
});

describe('reversão sem saldo', () => {
  test('ROLLBACK que deixaria o saldo negativo é rejeitado sem movimento parcial', async () => {
    const wallet = await openWallet(context, '100.00');

    await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Win,
        money: { amount: '100.00', currency: 'BRL' },
        externalTransactionId: 'overdraw-win',
      }),
    );

    // Gasta o prêmio: reverter o WIN agora exigiria mais do que a wallet tem.
    await context.processWager.execute(
      command(wallet, { money: { amount: '150.00', currency: 'BRL' } }),
    );

    const before = await readWallet(context, wallet.walletId);

    expect(before.balance).toBe('50.00');

    const rejected = await context.processWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Rollback,
        money: { amount: '100.00', currency: 'BRL' },
        referenceExternalTransactionId: 'overdraw-win',
      }),
    );

    // Código distinto de INSUFFICIENT_FUNDS: aposta sem saldo é situação de
    // jogo, reversão sem saldo é inconsistência operacional.
    expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected.failureCode).toBe('REVERSAL_WOULD_OVERDRAW');
    expect(rejected.balance).toEqual({ amount: '50.00', currency: 'BRL' });

    const after = await readWallet(context, wallet.walletId);

    expect(after.balance).toBe(before.balance);
    expect(after.version).toBe(before.version);

    await expectNoLedgerEntry(context, wallet.walletId, rejected.transactionId);
    await expectWalletMatchesLedger(context, wallet.walletId);
  });
});
