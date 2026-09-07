import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidInputError,
} from '../../src/domain/shared/domain-error.js';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction.js';
import {
  WalletLedgerEntry,
  type CreateLedgerEntryProps,
} from '../../src/domain/wallet/wallet-ledger-entry.js';
import { AT, brl, LATER, openWallet, usd } from './support.js';

function entryProps(overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps {
  return {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction: LedgerDirection.Debit,
    money: brl('25.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('75.00'),
    createdAt: AT,
    ...overrides,
  };
}

describe('criação a partir de uma movimentação da wallet', () => {
  test('o efeito produzido pela wallet gera um lançamento equilibrado', () => {
    const { wallet } = openWallet('100.00');
    const movement = wallet.debit(brl('25.00'), LATER);
    const entry = WalletLedgerEntry.create({
      ...movement,
      id: 'entry-1',
      transactionId: 'tx-1',
      createdAt: LATER,
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceAfter.toString()).toBe('75.00');
  });

  test('crédito soma em vez de subtrair', () => {
    const entry = WalletLedgerEntry.create(
      entryProps({
        direction: LedgerDirection.Credit,
        money: brl('25.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('125.00'),
      }),
    );

    expect(entry.isBalanced()).toBe(true);
  });
});

describe('aritmética validada na factory', () => {
  test.each([
    ['débito com saldo final maior', LedgerDirection.Debit, '125.00'],
    ['débito com diferença errada', LedgerDirection.Debit, '76.00'],
    ['débito fora por um centavo', LedgerDirection.Debit, '74.99'],
  ] as const)('rejeita %s', (_name, direction, balanceAfter) => {
    expect(() =>
      WalletLedgerEntry.create(entryProps({ direction, balanceAfter: brl(balanceAfter) })),
    ).toThrow(InvalidInputError);
  });

  test('rejeita crédito que não some exatamente o valor', () => {
    expect(() =>
      WalletLedgerEntry.create(
        entryProps({ direction: LedgerDirection.Credit, balanceAfter: brl('124.99') }),
      ),
    ).toThrow(InvalidInputError);
  });

  test.each(['0.00', '-25.00'])('rejeita o valor de movimentação %p', (amount) => {
    const money = amount.startsWith('-')
      ? brl('0.00').subtract(brl(amount.slice(1)))
      : brl(amount);

    expect(() =>
      WalletLedgerEntry.create(
        entryProps({ money, balanceBefore: brl('100.00'), balanceAfter: brl('100.00') }),
      ),
    ).toThrow(InvalidInputError);
  });

  test('rejeita saldos negativos', () => {
    expect(() =>
      WalletLedgerEntry.create(
        entryProps({
          money: brl('25.00'),
          balanceBefore: brl('10.00'),
          balanceAfter: brl('0.00').subtract(brl('15.00')),
        }),
      ),
    ).toThrow(InvalidInputError);
  });

  test('rejeita moeda inconsistente entre valor e saldos', () => {
    expect(() => WalletLedgerEntry.create(entryProps({ money: usd('25.00') }))).toThrow(
      CurrencyMismatchError,
    );
    expect(() => WalletLedgerEntry.create(entryProps({ balanceAfter: usd('75.00') }))).toThrow(
      CurrencyMismatchError,
    );
  });

  test.each([
    ['id', () => entryProps({ id: '' })],
    ['walletId', () => entryProps({ walletId: '' })],
    ['transactionId', () => entryProps({ transactionId: '' })],
  ] as const)('exige %s', (_field, props) => {
    expect(() => WalletLedgerEntry.create(props())).toThrow(InvalidInputError);
  });
});

describe('imutabilidade estrutural', () => {
  test('um lançamento criado não aceita sobrescrita', () => {
    const entry = WalletLedgerEntry.create(entryProps());

    expect(() => Object.assign(entry, { money: brl('1.00') })).toThrow(TypeError);
    expect(entry.money.toString()).toBe('25.00');
  });

  test('a instância é congelada em runtime', () => {
    expect(Object.isFrozen(WalletLedgerEntry.create(entryProps()))).toBe(true);
  });

  test('a data recebida e a data devolvida não alteram o lançamento', () => {
    const createdAt = new Date(AT.getTime());
    const entry = WalletLedgerEntry.create(entryProps({ createdAt }));

    createdAt.setFullYear(1999);
    entry.createdAt.setFullYear(1999);

    expect(entry.createdAt.toISOString()).toBe(AT.toISOString());
  });
});

describe('rehydrate', () => {
  test('reconstrói um lançamento persistido preservando os valores', () => {
    const entry = WalletLedgerEntry.rehydrate(entryProps());

    expect(entry.id).toBe('entry-1');
    expect(entry.money.toString()).toBe('25.00');
    expect(entry.createdAt.toISOString()).toBe(AT.toISOString());
    expect(entry.isBalanced()).toBe(true);
  });

  test('não revalida a aritmética, mas isBalanced continua auditando o histórico', () => {
    const inconsistent = WalletLedgerEntry.rehydrate(entryProps({ balanceAfter: brl('80.00') }));

    expect(inconsistent.isBalanced()).toBe(false);
  });
});
