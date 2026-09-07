import { Type } from '@mikro-orm/core';

/** Dígitos totais e escala da coluna monetária: `numeric(20, 2)`. */
export const MONEY_PRECISION = 20;
export const MONEY_SCALE = 2;
export const MONEY_COLUMN_TYPE = `numeric(${String(MONEY_PRECISION)},${String(MONEY_SCALE)})`;

const EXACT_AMOUNT_PATTERN = /^-?\d+\.\d{2}$/;

/**
 * Coluna monetária exata, transportada como string decimal em toda a
 * fronteira com o banco.
 *
 * `numeric` do PostgreSQL preserva a escala declarada na saída, então uma
 * coluna `numeric(20,2)` sempre devolve `"25.00"` — exatamente a forma
 * canônica que `Money.from` aceita, sem reformatação intermediária.
 *
 * O driver `pg` entrega `numeric` como string justamente para não perder
 * precisão. Se algum ajuste de parser passar a devolver `number`, esta
 * conversão falha alto em vez de arredondar dinheiro em silêncio: acima de
 * `Number.MAX_SAFE_INTEGER` o estrago aconteceria antes de qualquer validação
 * de domínio, sem deixar rastro.
 */
export class MoneyAmountType extends Type<string, string> {
  override convertToDatabaseValue(value: string): string {
    assertExactAmount(value, 'writing');
    return value;
  }

  override convertToJSValue(value: unknown): string {
    if (typeof value === 'number') {
      throw new TypeError(
        'Monetary column was read as a JavaScript number, which cannot represent it exactly.',
      );
    }

    if (typeof value !== 'string') {
      throw new TypeError(
        `Monetary column was read as ${typeof value}, expected a decimal string.`,
      );
    }

    assertExactAmount(value, 'reading');
    return value;
  }

  override getColumnType(): string {
    return MONEY_COLUMN_TYPE;
  }

  override compareAsType(): string {
    return 'string';
  }
}

function assertExactAmount(value: string, direction: string): void {
  if (typeof value !== 'string' || !EXACT_AMOUNT_PATTERN.test(value)) {
    throw new TypeError(
      `Monetary column expects a decimal string with ${String(MONEY_SCALE)} fraction digits while ${direction}.`,
    );
  }
}
