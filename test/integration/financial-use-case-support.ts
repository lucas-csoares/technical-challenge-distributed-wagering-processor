import { expect } from 'bun:test';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case.js';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionCommand,
} from '../../src/application/process-wager-transaction.use-case.js';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction.js';
import type { LedgerDirection } from '../../src/domain/wallet/ledger-direction.js';
import type { WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry.js';
import { MikroOrmFinancialTransactionManager } from '../../src/infrastructure/persistence/mikro-orm-financial-transaction-manager.js';
import { assertLedgerBalance, requireWallet } from './financial-repository-support.js';
import { createFinancialSchema, type FinancialSchema } from './support.js';

/** Use cases reais sobre um schema financeiro exclusivo do arquivo de teste. */
export interface FinancialContext {
  readonly db: FinancialSchema;
  readonly manager: MikroOrmFinancialTransactionManager;
  readonly createWallet: CreateWalletUseCase;
  readonly processWager: ProcessWagerTransactionUseCase;
}

export async function createFinancialContext(): Promise<FinancialContext> {
  const db = await createFinancialSchema();
  const manager = new MikroOrmFinancialTransactionManager(db.orm);

  return {
    db,
    manager,
    createWallet: new CreateWalletUseCase(manager),
    processWager: new ProcessWagerTransactionUseCase(manager),
  };
}

export interface OpenedWallet {
  readonly walletId: string;
  readonly playerId: string;
}

export async function openWallet(
  context: FinancialContext,
  amount = '100.00',
): Promise<OpenedWallet> {
  const playerId = crypto.randomUUID();
  const result = await context.createWallet.execute({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });

  return { playerId, walletId: result.walletId };
}

export function command(
  wallet: OpenedWallet,
  overrides: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  return {
    providerId: 'provider-a',
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    walletId: wallet.walletId,
    playerId: wallet.playerId,
    roundId: 'round-a',
    gameId: 'game-a',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

/** Resolve para o erro em vez de rejeitar, para inspecionar corridas. */
export async function outcome<T>(promise: Promise<T>): Promise<T | Error> {
  try {
    return await promise;
  } catch (error) {
    return error as Error;
  }
}

export interface WalletSnapshot {
  readonly balance: string;
  readonly version: number;
}

export async function readWallet(
  context: FinancialContext,
  walletId: string,
): Promise<WalletSnapshot> {
  return context.manager.execute(async (scope) => {
    const wallet = requireWallet(await scope.wallets.findById(walletId));

    return { balance: wallet.balance.toString(), version: wallet.version };
  });
}

/** Lançamento produzido por uma transação específica, se houver algum. */
export async function ledgerEntryOf(
  context: FinancialContext,
  walletId: string,
  transactionId: string,
): Promise<WalletLedgerEntry | undefined> {
  const entries = await context.manager.execute((scope) => scope.ledger.findByWalletId(walletId));

  return entries.find((entry) => entry.transactionId === transactionId);
}

/**
 * Prova que uma operação não moveu dinheiro: comparar pelo `transactionId` é
 * mais forte do que contar lançamentos, porque não depende de quantas outras
 * operações a wallet já acumulou.
 */
export async function expectNoLedgerEntry(
  context: FinancialContext,
  walletId: string,
  transactionId: string,
): Promise<void> {
  expect(await ledgerEntryOf(context, walletId, transactionId)).toBeUndefined();
}

export interface ExpectedLedgerEntry {
  readonly direction: LedgerDirection;
  readonly amount: string;
  readonly balanceBefore: string;
  readonly balanceAfter: string;
}

export async function expectLedgerEntry(
  context: FinancialContext,
  walletId: string,
  transactionId: string,
  expected: ExpectedLedgerEntry,
): Promise<void> {
  const entry = await ledgerEntryOf(context, walletId, transactionId);

  if (entry === undefined) {
    throw new Error(`Expected a ledger entry for transaction ${transactionId}.`);
  }

  expect(entry.direction).toBe(expected.direction);
  expect(entry.money.toString()).toBe(expected.amount);
  expect(entry.balanceBefore.toString()).toBe(expected.balanceBefore);
  expect(entry.balanceAfter.toString()).toBe(expected.balanceAfter);
  expect(entry.isBalanced()).toBe(true);
}

/** `wallet.balance == saldo reconstruído pelo ledger`. */
export async function expectWalletMatchesLedger(
  context: FinancialContext,
  walletId: string,
): Promise<void> {
  await context.manager.execute((scope) => assertLedgerBalance(scope, walletId));
}

export async function findTransaction(context: FinancialContext, transactionId: string) {
  return context.manager.execute(async (scope) => {
    const transaction = await scope.transactions.findById(transactionId);

    if (transaction === undefined) {
      throw new Error(`Expected transaction ${transactionId} to be persisted.`);
    }

    return transaction;
  });
}
