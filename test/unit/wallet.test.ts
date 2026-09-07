import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidInputError,
} from '../../src/domain/shared/domain-error.js';
import { FailureCode } from '../../src/domain/shared/failure-code.js';
import { Money } from '../../src/domain/shared/money.js';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction.js';
import { Wallet } from '../../src/domain/wallet/wallet.js';
import { AT, brl, LATER, openWallet, usd } from './support.js';

describe('abertura', () => {
  test('wallet zerada nasce na version 1 e sem movimentação', () => {
    const { wallet, movement } = openWallet('0.00');

    expect(wallet.balance.toString()).toBe('0.00');
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    expect(movement).toBeUndefined();
  });

  test('saldo inicial positivo mantém a version 1 e descreve o crédito de abertura', () => {
    const { wallet, movement } = openWallet('1000.00');

    expect(wallet.balance.toString()).toBe('1000.00');
    expect(wallet.version).toBe(1);
    expect(movement).toEqual({
      walletId: 'wallet-1',
      direction: LedgerDirection.Credit,
      money: brl('1000.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('1000.00'),
    });
  });

  test('recusa saldo inicial negativo', () => {
    expect(() =>
      Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('0.00').subtract(brl('1.00')),
        openedAt: AT,
      }),
    ).toThrow(InvalidInputError);
  });

  test.each([
    ['', 'vazio'],
    [' wallet-1', 'com espaço'],
  ])('recusa o identificador %p (%s)', (id) => {
    expect(() =>
      Wallet.open({ id, playerId: 'player-1', initialBalance: brl('0.00'), openedAt: AT }),
    ).toThrow(InvalidInputError);
  });

  test('a data de abertura é copiada, não referenciada', () => {
    const openedAt = new Date(AT.getTime());
    const { wallet } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('0.00'),
      openedAt,
    });

    openedAt.setFullYear(1999);

    expect(wallet.createdAt.toISOString()).toBe(AT.toISOString());
  });
});

describe('movimentações', () => {
  test('débito reduz o saldo, incrementa a version e descreve o lançamento', () => {
    const { wallet } = openWallet('100.00');
    const movement = wallet.debit(brl('25.00'), LATER);

    expect(wallet.balance.toString()).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.toISOString()).toBe(LATER.toISOString());
    expect(movement).toEqual({
      walletId: 'wallet-1',
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('75.00'),
    });
  });

  test('crédito aumenta o saldo e incrementa a version', () => {
    const { wallet } = openWallet('100.00');
    const movement = wallet.credit(brl('40.00'), LATER);

    expect(wallet.balance.toString()).toBe('140.00');
    expect(wallet.version).toBe(2);
    expect(movement.direction).toBe(LedgerDirection.Credit);
  });

  test('débito do saldo integral é permitido e zera a wallet', () => {
    const { wallet } = openWallet('100.00');
    wallet.debit(brl('100.00'), LATER);

    expect(wallet.balance.toString()).toBe('0.00');
    expect(wallet.balance.isNegative()).toBe(false);
  });

  test('cada movimentação incrementa a version uma única vez', () => {
    const { wallet } = openWallet('100.00');

    wallet.debit(brl('10.00'), LATER);
    wallet.credit(brl('10.00'), LATER);

    expect(wallet.version).toBe(3);
    expect(wallet.balance.toString()).toBe('100.00');
  });
});

describe('recusas sem mutação parcial', () => {
  test('saldo insuficiente rejeita com INSUFFICIENT_FUNDS e preserva o estado', () => {
    const { wallet } = openWallet('100.00');

    expect(() => wallet.debit(brl('100.01'), LATER)).toThrow(InsufficientFundsError);

    try {
      wallet.debit(brl('100.01'), LATER);
    } catch (error) {
      expect((error as InsufficientFundsError).failureCode).toBe(FailureCode.InsufficientFunds);
    }

    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt.toISOString()).toBe(AT.toISOString());
  });

  test.each([
    ['debit', (wallet: Wallet, money: Money) => wallet.debit(money, LATER)],
    ['credit', (wallet: Wallet, money: Money) => wallet.credit(money, LATER)],
  ] as const)('%s em outra moeda falha e não altera a wallet', (_name, operation) => {
    const { wallet } = openWallet('100.00');

    expect(() => operation(wallet, usd('10.00'))).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test.each([
    ['debit', (wallet: Wallet, money: Money) => wallet.debit(money, LATER)],
    ['credit', (wallet: Wallet, money: Money) => wallet.credit(money, LATER)],
  ] as const)('%s de valor zero não é movimentação financeira', (_name, operation) => {
    const { wallet } = openWallet('100.00');

    expect(() => operation(wallet, brl('0.00'))).toThrow(InvalidInputError);
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('100.00');
  });

  test.each([
    ['debit', (wallet: Wallet, money: Money) => wallet.debit(money, LATER)],
    ['credit', (wallet: Wallet, money: Money) => wallet.credit(money, LATER)],
  ] as const)('%s de valor negativo é recusado', (_name, operation) => {
    const { wallet } = openWallet('100.00');
    const negative = brl('0.00').subtract(brl('10.00'));

    expect(() => operation(wallet, negative)).toThrow(InvalidInputError);
    expect(wallet.balance.toString()).toBe('100.00');
  });

  test('data inválida é recusada antes de qualquer alteração de saldo', () => {
    const { wallet } = openWallet('100.00');

    expect(() => wallet.debit(brl('10.00'), new Date('não é uma data'))).toThrow(InvalidInputError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });
});

describe('rehydrate', () => {
  test('reconstrói o estado persistido sem reaplicar movimentações', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: brl('975.00'),
      version: 7,
      createdAt: AT,
      updatedAt: LATER,
    });

    expect(wallet.balance.toString()).toBe('975.00');
    expect(wallet.version).toBe(7);
    expect(wallet.createdAt.toISOString()).toBe(AT.toISOString());
    expect(wallet.updatedAt.toISOString()).toBe(LATER.toISOString());
  });

  test('a wallet reidratada continua aplicando as regras nas próximas operações', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: brl('10.00'),
      version: 7,
      createdAt: AT,
      updatedAt: AT,
    });

    expect(() => wallet.debit(brl('10.01'), LATER)).toThrow(InsufficientFundsError);

    wallet.debit(brl('10.00'), LATER);

    expect(wallet.version).toBe(8);
    expect(wallet.balance.toString()).toBe('0.00');
  });

  test('não expõe as datas persistidas para mutação externa', () => {
    const createdAt = new Date(AT.getTime());
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: brl('10.00'),
      version: 2,
      createdAt,
      updatedAt: LATER,
    });

    createdAt.setFullYear(1999);
    wallet.updatedAt.setFullYear(1999);

    expect(wallet.createdAt.toISOString()).toBe(AT.toISOString());
    expect(wallet.updatedAt.toISOString()).toBe(LATER.toISOString());
  });
});
