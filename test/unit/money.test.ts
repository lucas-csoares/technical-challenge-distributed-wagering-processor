import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from '../../src/domain/shared/domain-error.js';
import { FailureCode } from '../../src/domain/shared/failure-code.js';
import { Money } from '../../src/domain/shared/money.js';
import { brl, usd } from './support.js';

describe('formato e escala', () => {
  test('preserva a string decimal recebida', () => {
    expect(brl('25.00').toString()).toBe('25.00');
    expect(brl('0.07').toString()).toBe('0.07');
    expect(brl('-5.40').toString()).toBe('-5.40');
  });

  test('serializa como MoneyProps com escala fixa de duas casas', () => {
    expect(brl('1000.00').toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(Money.zero('BRL').toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  test.each([
    ['', 'string vazia'],
    ['25', 'sem casas decimais'],
    ['25.5', 'uma casa decimal'],
    ['25.000', 'três casas decimais'],
    ['2.5e1', 'notação científica'],
    ['1E2', 'notação científica maiúscula'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['1,00', 'separador decimal inválido'],
    [' 25.00', 'espaço à esquerda'],
    ['25.00 ', 'espaço à direita'],
    ['+25.00', 'sinal positivo explícito'],
    ['007.00', 'zeros à esquerda'],
    ['-0.00', 'zero negativo'],
    ['.00', 'sem parte inteira'],
    ['25.', 'sem parte fracionária'],
  ])('rejeita %p (%s)', (amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('não arredonda entradas com casas excedentes', () => {
    expect(() => Money.from({ amount: '25.005', currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '25.999', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('rejeita valores numéricos, não apenas strings malformadas', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.from({ amount: 25.5 as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  test.each(['brl', 'BR', 'BRLL', 'B2L', '', 'BRL '])('rejeita a moeda %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    expect(() => Money.zero(currency)).toThrow(InvalidMoneyError);
  });

  test('aceita qualquer código ISO-4217 bem formado, sem catálogo de moedas', () => {
    expect(usd('1.00').currency).toBe('USD');
    expect(Money.from({ amount: '1.00', currency: 'JPY' }).currency).toBe('JPY');
  });
});

describe('precisão', () => {
  test('mantém exatidão acima do limite de inteiros seguros de number', () => {
    const beyondSafeInteger = brl('92233720368547758.07');

    expect(beyondSafeInteger.add(brl('0.01')).toString()).toBe('92233720368547758.08');
    expect(beyondSafeInteger.toString()).toBe('92233720368547758.07');
  });

  test('distingue valores que colidiriam como ponto flutuante', () => {
    const a = brl('90071992547409.93');
    const b = brl('90071992547409.94');

    expect(a.equals(b)).toBe(false);
    expect(b.subtract(a).toString()).toBe('0.01');
  });

  test('o maior valor suportado é aceito e sobrevive ao round-trip', () => {
    const max = brl(Money.MAX_AMOUNT);

    expect(Money.MAX_AMOUNT).toBe('999999999999999999.99');
    expect(max.toString()).toBe(Money.MAX_AMOUNT);
    expect(brl(`-${Money.MAX_AMOUNT}`).toString()).toBe(`-${Money.MAX_AMOUNT}`);
  });

  test('um centavo além do limite é recusado na entrada', () => {
    expect(() => brl('1000000000000000000.00')).toThrow(InvalidMoneyError);
    expect(() => brl('-1000000000000000000.00')).toThrow(InvalidMoneyError);
  });

  test('estouro do limite falha na operação que o causa, não na persistência', () => {
    const max = brl(Money.MAX_AMOUNT);
    const min = brl(`-${Money.MAX_AMOUNT}`);

    expect(() => max.add(brl('0.01'))).toThrow(InvalidMoneyError);
    expect(() => min.subtract(brl('0.01'))).toThrow(InvalidMoneyError);
    expect(max.subtract(brl('0.01')).toString()).toBe('999999999999999999.98');
    expect(max.negate().toString()).toBe(`-${Money.MAX_AMOUNT}`);
  });

  test('soma repetida de centavos não acumula erro', () => {
    let total = Money.zero('BRL');

    for (let index = 0; index < 100; index += 1) {
      total = total.add(brl('0.10'));
    }

    expect(total.toString()).toBe('10.00');
  });
});

describe('imutabilidade', () => {
  test('operações retornam novas instâncias sem alterar a original', () => {
    const original = brl('10.00');
    const sum = original.add(brl('5.00'));

    expect(sum).not.toBe(original);
    expect(original.toString()).toBe('10.00');
    expect(sum.toString()).toBe('15.00');
    expect(original.subtract(brl('4.00')).toString()).toBe('6.00');
    expect(original.negate().toString()).toBe('-10.00');
    expect(original.toString()).toBe('10.00');
  });

  test('a instância é congelada em runtime', () => {
    expect(Object.isFrozen(brl('10.00'))).toBe(true);
  });
});

describe('aritmética e comparação', () => {
  test('subtração pode produzir um valor negativo legítimo', () => {
    const result = brl('10.00').subtract(brl('25.00'));

    expect(result.isNegative()).toBe(true);
    expect(result.toString()).toBe('-15.00');
  });

  test('negar zero continua sendo zero canônico', () => {
    const zero = Money.zero('BRL').negate();

    expect(zero.isZero()).toBe(true);
    expect(zero.toString()).toBe('0.00');
  });

  test('predicados de sinal', () => {
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('-0.01').isNegative()).toBe(true);
  });

  test('ordenação usa o valor exato', () => {
    expect(brl('99.99').isLessThan(brl('100.00'))).toBe(true);
    expect(brl('100.00').isLessThan(brl('100.00'))).toBe(false);
    expect(brl('-1.00').isLessThan(brl('0.00'))).toBe(true);
  });
});

describe('conflito de moeda', () => {
  test.each([
    ['add', (a: Money, b: Money) => a.add(b)],
    ['subtract', (a: Money, b: Money) => a.subtract(b)],
    ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
  ] as const)('%s entre moedas diferentes falha com CURRENCY_MISMATCH', (_name, operation) => {
    expect(() => operation(brl('10.00'), usd('10.00'))).toThrow(CurrencyMismatchError);

    try {
      operation(brl('10.00'), usd('10.00'));
      throw new Error('expected the operation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CurrencyMismatchError);
      expect((error as CurrencyMismatchError).failureCode).toBe(FailureCode.CurrencyMismatch);
    }
  });

  test('igualdade entre moedas diferentes é falsa, não um erro', () => {
    expect(brl('10.00').equals(usd('10.00'))).toBe(false);
    expect(brl('10.00').equals(brl('10.00'))).toBe(true);
  });
});
