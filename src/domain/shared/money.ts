import { CurrencyMismatchError, InvalidMoneyError } from './domain-error.js';

/** Representação de transporte e persistência de um valor monetário. */
export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

/**
 * Escala fixa de 2 casas decimais, conforme o contrato do desafio.
 *
 * Moedas com expoente diferente (JPY, KWD) não estão no escopo; adotá-las
 * exigiria escala por moeda, e essa decisão é registrada em ARCHITECTURE.md
 * em vez de embutida silenciosamente aqui.
 */
const FRACTION_DIGITS = 2;
const MINOR_UNITS_PER_UNIT = 100n;

/**
 * Forma canônica aceita: sinal opcional, parte inteira sem zeros à esquerda e
 * exatamente duas casas decimais. Notação científica, `NaN`, `Infinity`,
 * string vazia, `"25"`, `"25.5"` e `"25.000"` não casam com o padrão.
 */
const AMOUNT_PATTERN = /^-?(?:0|[1-9]\d*)\.\d{2}$/;

/** ISO-4217 alfabético. Não há catálogo de moedas: apenas o formato é validado. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Maior módulo representável: 18 dígitos inteiros mais 2 decimais, ou seja
 * `999999999999999999.99`.
 *
 * O `bigint` do JavaScript é ilimitado, mas a coluna do PostgreSQL não é. O
 * limite é o mesmo do tipo persistido (`numeric(20, 2)`) para que exceder a
 * capacidade seja um erro de domínio explícito e testável, e não um overflow
 * surgido no meio de um `INSERT`. Ele fica três ordens de grandeza acima de
 * `Number.MAX_SAFE_INTEGER`, longe de qualquer saldo plausível.
 */
const MAX_MINOR_UNITS = 99_999_999_999_999_999_999n;

/**
 * Valor monetário exato e imutável.
 *
 * A representação interna é um `bigint` de unidades menores (centavos). Não há
 * conversão intermediária para `number` em nenhum caminho: entrada, aritmética
 * e serialização operam sobre strings e `bigint`. Soma, subtração, negação e
 * comparação são fechadas sobre inteiros, então nenhuma biblioteca decimal
 * seria exercitada — divisão e multiplicação não fazem parte do domínio
 * (reversão parcial está fora de escopo).
 *
 * `Money` admite valores negativos, que aparecem legitimamente em `negate()` e
 * `subtract()`. A proibição de valores negativos pertence aos contratos de
 * criação e movimentação (`Wallet.open`, `Wallet.debit`, `Wallet.credit`,
 * `WagerTransaction.create`, `WalletLedgerEntry.create`), não ao value object.
 *
 * O intervalo representável é finito e casado com a coluna do PostgreSQL: ver
 * `MAX_AMOUNT`. Toda instância nasce dentro dele, inclusive as produzidas por
 * `add` e `subtract`, de modo que um estouro apareça na operação que o causou.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    readonly currency: string,
  ) {
    if (minorUnits > MAX_MINOR_UNITS || minorUnits < -MAX_MINOR_UNITS) {
      throw new InvalidMoneyError(
        `Monetary amount is outside the supported range of ±${Money.MAX_AMOUNT}.`,
      );
    }

    Object.freeze(this);
  }

  /** Maior valor absoluto que o sistema representa e persiste. */
  static readonly MAX_AMOUNT = '999999999999999999.99';

  static from(props: MoneyProps): Money {
    const currency = assertCurrencyCode(props.currency);
    const amount = props.amount;

    if (typeof amount !== 'string') {
      throw new InvalidMoneyError(
        `amount must be a decimal string with ${String(FRACTION_DIGITS)} fraction digits.`,
      );
    }

    // `-0.00` é rejeitado para que a forma canônica do zero seja única.
    if (!AMOUNT_PATTERN.test(amount) || amount === '-0.00') {
      throw new InvalidMoneyError(`Invalid monetary amount: ${JSON.stringify(amount)}.`);
    }

    const negative = amount.startsWith('-');
    const digits = (negative ? amount.slice(1) : amount).replace('.', '');
    const minorUnits = BigInt(digits);

    return new Money(negative ? -minorUnits : minorUnits, currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, assertCurrencyCode(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  /**
   * Igualdade total: valores em moedas diferentes simplesmente não são iguais.
   * Ordenação entre moedas distintas, essa sim, é um erro — ver `isLessThan`.
   */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    const negative = this.minorUnits < 0n;
    const absolute = negative ? -this.minorUnits : this.minorUnits;
    const units = absolute / MINOR_UNITS_PER_UNIT;
    const fraction = absolute % MINOR_UNITS_PER_UNIT;

    return `${negative ? '-' : ''}${units.toString()}.${fraction.toString().padStart(FRACTION_DIGITS, '0')}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

function assertCurrencyCode(currency: string): string {
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    throw new InvalidMoneyError(
      'currency must be an ISO-4217 alphabetic code with three uppercase letters.',
    );
  }

  return currency;
}
