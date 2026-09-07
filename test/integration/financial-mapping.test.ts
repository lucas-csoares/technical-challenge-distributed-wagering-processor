import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/domain/shared/failure-code.js';
import { Money } from '../../src/domain/shared/money.js';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction.js';
import { WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry.js';
import { Wallet } from '../../src/domain/wallet/wallet.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wagering/wager-transaction.js';
import { WagerTransactionRecord } from '../../src/infrastructure/persistence/entities/wager-transaction.record.js';
import { WalletLedgerEntryRecord } from '../../src/infrastructure/persistence/entities/wallet-ledger-entry.record.js';
import { WalletRecord } from '../../src/infrastructure/persistence/entities/wallet.record.js';
import {
  toWagerTransaction,
  toWagerTransactionRecord,
} from '../../src/infrastructure/persistence/mappers/wager-transaction.mapper.js';
import {
  toWalletLedgerEntry,
  toWalletLedgerEntryRecord,
} from '../../src/infrastructure/persistence/mappers/wallet-ledger-entry.mapper.js';
import {
  toWallet,
  toWalletRecord,
} from '../../src/infrastructure/persistence/mappers/wallet.mapper.js';
import { MoneyAmountType } from '../../src/infrastructure/persistence/money-amount.type.js';
import { createFinancialSchema, type FinancialSchema } from './support.js';

let db: FinancialSchema;
let sequence = 0;

function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${String(sequence)}`;
}

const AT = new Date('2026-09-06T12:00:00.000Z');
const LATER = new Date('2026-09-06T12:05:00.000Z');

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

/** Grava pelo ORM; a leitura usa um contexto novo, sem identity map quente. */
async function save(record: object): Promise<void> {
  const em = db.orm.em.fork();
  em.persist(record);
  await em.flush();
}

function loadWallet(id: string): Promise<WalletRecord> {
  return db.orm.em.fork().findOneOrFail(WalletRecord, { id });
}

function loadTransaction(id: string): Promise<WagerTransactionRecord> {
  return db.orm.em.fork().findOneOrFail(WagerTransactionRecord, { id });
}

beforeAll(async () => {
  db = await createFinancialSchema();
});

afterAll(async () => {
  await db.close();
});

describe('round-trip de Wallet', () => {
  test('preserva saldo, version e timestamps sem reaplicar regras', async () => {
    const id = unique('wallet');
    const { wallet, movement } = Wallet.open({
      id,
      playerId: unique('player'),
      initialBalance: brl('1000.00'),
      openedAt: AT,
    });
    wallet.debit(brl('25.00'), LATER);

    expect(movement).toBeDefined();
    expect(wallet.version).toBe(2);

    await save(toWalletRecord(wallet));
    const loaded = await loadWallet(id);
    const restored = toWallet(loaded);

    expect(restored.id).toBe(wallet.id);
    expect(restored.playerId).toBe(wallet.playerId);
    expect(restored.currency).toBe('BRL');
    expect(restored.balance.equals(wallet.balance)).toBe(true);
    expect(restored.balance.toString()).toBe('975.00');
    expect(restored.version).toBe(2);
    expect(restored.createdAt.toISOString()).toBe(AT.toISOString());
    expect(restored.updatedAt.toISOString()).toBe(LATER.toISOString());
  });

  test('a reidratação não incrementa version nem gera movimentação', async () => {
    const id = unique('wallet');
    const { wallet } = Wallet.open({
      id,
      playerId: unique('player'),
      initialBalance: brl('50.00'),
      openedAt: AT,
    });

    await save(toWalletRecord(wallet));
    const loaded = await loadWallet(id);
    const restored = toWallet(loaded);

    expect(restored.version).toBe(1);
    expect(restored.balance.toString()).toBe('50.00');

    // Só uma movimentação posterior muda o estado da wallet reidratada.
    restored.debit(brl('50.00'), LATER);
    expect(restored.version).toBe(2);
    expect(restored.balance.toString()).toBe('0.00');
  });

  test('o extremo do range monetário sobrevive ao round-trip', async () => {
    const id = unique('wallet');
    const { wallet } = Wallet.open({
      id,
      playerId: unique('player'),
      initialBalance: brl(Money.MAX_AMOUNT),
      openedAt: AT,
    });

    await save(toWalletRecord(wallet));
    const loaded = await loadWallet(id);

    expect(loaded.balance).toBe(Money.MAX_AMOUNT);
    expect(toWallet(loaded).balance.toString()).toBe(Money.MAX_AMOUNT);
  });
});

describe('round-trip de WagerTransaction', () => {
  async function persistedWallet(currency = 'BRL'): Promise<Wallet> {
    const { wallet } = Wallet.open({
      id: unique('wallet'),
      playerId: unique('player'),
      initialBalance: Money.from({ amount: '1000.00', currency }),
      openedAt: AT,
    });

    const em = db.orm.em.fork();
    em.persist(toWalletRecord(wallet));
    await em.flush();

    return wallet;
  }

  test('preserva uma BET processada', async () => {
    const wallet = await persistedWallet();
    const id = unique('tx');
    const bet = WagerTransaction.create({
      id,
      providerId: 'provider-a',
      externalTransactionId: unique('ext'),
      idempotencyKey: unique('key'),
      payloadHash: 'a'.repeat(64),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: brl('25.00'),
      createdAt: AT,
    });
    bet.markProcessed(undefined, LATER);

    await save(toWagerTransactionRecord(bet));
    const loaded = await loadTransaction(id);
    const restored = toWagerTransaction(loaded);

    expect(restored.kind).toBe(WagerTransactionKind.Bet);
    expect(restored.status).toBe(WagerTransactionStatus.Processed);
    expect(restored.money.equals(bet.money)).toBe(true);
    expect(restored.money.toString()).toBe('25.00');
    expect(restored.payloadHash).toBe(bet.payloadHash);
    expect(restored.matchesPayload('a'.repeat(64))).toBe(true);
    expect(restored.processedAt?.toISOString()).toBe(LATER.toISOString());
    expect(restored.isTerminal()).toBe(true);
  });

  test('preserva a identidade interna vazia de uma OPENING', async () => {
    const wallet = await persistedWallet();
    const id = unique('tx');
    const opening = WagerTransaction.createOpening({
      id,
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: brl('1000.00'),
      createdAt: AT,
    });
    opening.markProcessed(undefined, AT);

    await save(toWagerTransactionRecord(opening));
    const loaded = await loadTransaction(id);
    const restored = toWagerTransaction(loaded);

    expect(loaded.providerId).toBeNull();
    expect(loaded.externalTransactionId).toBeNull();
    expect(loaded.idempotencyKey).toBeNull();
    expect(loaded.payloadHash).toBeNull();
    expect(loaded.roundId).toBeNull();
    expect(loaded.gameId).toBeNull();

    expect(restored.kind).toBe(WagerTransactionKind.Opening);
    expect(restored.providerId).toBeUndefined();
    expect(restored.externalTransactionId).toBeUndefined();
    expect(restored.idempotencyKey).toBeUndefined();
    expect(restored.payloadHash).toBeUndefined();
    expect(restored.money.toString()).toBe('1000.00');
  });

  test('preserva a referência externa e a interna de um REFUND', async () => {
    const wallet = await persistedWallet();
    const betId = unique('tx');
    const externalBet = unique('ext');

    const bet = WagerTransaction.create({
      id: betId,
      providerId: 'provider-a',
      externalTransactionId: externalBet,
      idempotencyKey: unique('key'),
      payloadHash: 'b'.repeat(64),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: brl('25.00'),
      createdAt: AT,
    });
    bet.markProcessed(undefined, AT);

    const refundId = unique('tx');
    const refund = WagerTransaction.create({
      id: refundId,
      providerId: 'provider-a',
      externalTransactionId: unique('ext'),
      idempotencyKey: unique('key'),
      payloadHash: 'c'.repeat(64),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: brl('25.00'),
      referenceExternalTransactionId: externalBet,
      createdAt: AT,
    });
    refund.markProcessed(betId, LATER);

    const em = db.orm.em.fork();
    em.persist(toWagerTransactionRecord(bet));
    await em.flush();
    em.persist(toWagerTransactionRecord(refund));
    await em.flush();

    const loaded = await db.orm.em
      .fork()
      .findOneOrFail(WagerTransactionRecord, { id: refundId });
    const restored = toWagerTransaction(loaded);

    // O que o provedor enviou e o registro que foi resolvido continuam distintos.
    expect(restored.referenceExternalTransactionId).toBe(externalBet);
    expect(restored.referenceTransactionId).toBe(betId);
  });

  test('preserva uma rejeição de negócio com seu failureCode', async () => {
    const wallet = await persistedWallet();
    const id = unique('tx');
    const bet = WagerTransaction.create({
      id,
      providerId: 'provider-a',
      externalTransactionId: unique('ext'),
      idempotencyKey: unique('key'),
      payloadHash: 'd'.repeat(64),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: brl('25.00'),
      createdAt: AT,
    });
    bet.reject(FailureCode.InsufficientFunds);

    await save(toWagerTransactionRecord(bet));
    const loaded = await loadTransaction(id);
    const restored = toWagerTransaction(loaded);

    expect(restored.status).toBe(WagerTransactionStatus.Rejected);
    expect(restored.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(restored.processedAt).toBeUndefined();
  });
});

describe('round-trip de WalletLedgerEntry', () => {
  test('preserva direção, valor e saldos', async () => {
    const { wallet } = Wallet.open({
      id: unique('wallet'),
      playerId: unique('player'),
      initialBalance: brl('100.00'),
      openedAt: AT,
    });
    const transactionId = unique('tx');
    const bet = WagerTransaction.create({
      id: transactionId,
      providerId: 'provider-a',
      externalTransactionId: unique('ext'),
      idempotencyKey: unique('key'),
      payloadHash: 'e'.repeat(64),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: brl('25.00'),
      createdAt: AT,
    });

    const movement = wallet.debit(brl('25.00'), LATER);
    bet.markProcessed(undefined, LATER);

    const entryId = unique('entry');
    const entry = WalletLedgerEntry.create({
      ...movement,
      id: entryId,
      transactionId,
      createdAt: LATER,
    });

    // Sem relações declaradas o ORM não deduz a ordem de inserção; quem
    // orquestra respeita a dependência wallet → transação → lançamento.
    const em = db.orm.em.fork();
    em.persist(toWalletRecord(wallet));
    await em.flush();
    em.persist(toWagerTransactionRecord(bet));
    await em.flush();
    em.persist(toWalletLedgerEntryRecord(entry));
    await em.flush();

    const loaded = await db.orm.em.fork().findOneOrFail(WalletLedgerEntryRecord, { id: entryId });
    const restored = toWalletLedgerEntry(loaded);

    expect(restored.direction).toBe(LedgerDirection.Debit);
    expect(restored.money.toString()).toBe('25.00');
    expect(restored.balanceBefore.toString()).toBe('100.00');
    expect(restored.balanceAfter.toString()).toBe('75.00');
    expect(restored.isBalanced()).toBe(true);
    expect(restored.createdAt.toISOString()).toBe(LATER.toISOString());
  });
});

describe('nenhum caminho monetário passa por number', () => {
  test('o tipo monetário recusa number na escrita e na leitura', () => {
    const type = new MoneyAmountType();

    expect(() => type.convertToDatabaseValue(25.12 as unknown as string)).toThrow(TypeError);
    expect(() => type.convertToJSValue(25.12)).toThrow(TypeError);
  });

  test('as colunas monetárias chegam ao JavaScript como string', async () => {
    const { wallet } = Wallet.open({
      id: unique('wallet'),
      playerId: unique('player'),
      initialBalance: brl('12345678901234.56'),
      openedAt: AT,
    });

    const em = db.orm.em.fork();
    em.persist(toWalletRecord(wallet));
    await em.flush();

    const record = await db.orm.em.fork().findOneOrFail(WalletRecord, { id: wallet.id });
    expect(typeof record.balance).toBe('string');
    expect(record.balance).toBe('12345678901234.56');

    const raw = await db.orm.em
      .fork()
      .execute<
        { balance: string }[]
      >(`select balance from "${db.schema}".wallets where id = ?`, [wallet.id]);
    expect(typeof raw[0]?.balance).toBe('string');
  });

  test('um valor que não caberia em number volta exato', async () => {
    const exact = '90071992547409.93';
    const { wallet } = Wallet.open({
      id: unique('wallet'),
      playerId: unique('player'),
      initialBalance: brl(exact),
      openedAt: AT,
    });

    const em = db.orm.em.fork();
    em.persist(toWalletRecord(wallet));
    await em.flush();

    const record = await db.orm.em.fork().findOneOrFail(WalletRecord, { id: wallet.id });

    expect(record.balance).toBe(exact);
    expect(Number(record.balance).toString()).not.toBe(exact);
    expect(toWallet(record).balance.toString()).toBe(exact);
  });
});
