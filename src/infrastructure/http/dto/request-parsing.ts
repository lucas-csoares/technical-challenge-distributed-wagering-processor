import type { MoneyProps } from '../../../domain/shared/money.js';

/** Contrato HTTP violado: o pedido nem chega à camada de aplicação. */
export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

type Body = Record<string, unknown>;

/**
 * Validação de contrato, não de regra de negócio.
 *
 * Aqui só se decide se o pedido tem a forma combinada: campos presentes, tipos
 * certos e nenhum campo desconhecido. Saldo insuficiente, referência
 * inelegível e conflito de idempotência continuam com o domínio e a aplicação,
 * que são quem sabe respondê-los com um `failureCode` estável.
 *
 * O projeto não usa `class-validator`: a superfície de entrada é pequena e
 * estável, e estas funções mantêm a mensagem de erro sob nosso controle sem
 * acrescentar duas dependências e metadados de decorator só para isso.
 */
export function asBody(value: unknown): Body {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidRequestError('The request body must be a JSON object.');
  }

  return value as Body;
}

/** Equivale a `whitelist` + `forbidNonWhitelisted`: campo extra é erro, não é ignorado. */
export function rejectUnknownFields(body: Body, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));

  if (unknown.length > 0) {
    throw new InvalidRequestError(`Unknown field(s): ${unknown.join(', ')}.`);
  }
}

export function requireString(body: Body, field: string): string {
  const value = body[field];

  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidRequestError(`${field} must be a non-empty string.`);
  }

  return value;
}

export function optionalString(body: Body, field: string): string | undefined {
  if (body[field] === undefined) {
    return undefined;
  }

  return requireString(body, field);
}

/**
 * `amount` permanece string do início ao fim: convertê-lo para `number` aqui
 * destruiria a exatidão antes que `Money` pudesse recusar o valor.
 */
export function requireMoney(body: Body, field: string): MoneyProps {
  const value = body[field];

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidRequestError(`${field} must be an object with amount and currency.`);
  }

  const money = value as Body;
  rejectUnknownFields(money, ['amount', 'currency']);

  return {
    amount: requireString(money, 'amount'),
    currency: requireString(money, 'currency'),
  };
}

export function requireEnum<T extends string>(
  body: Body,
  field: string,
  allowed: readonly T[],
): T {
  const value = requireString(body, field);

  if (!(allowed as readonly string[]).includes(value)) {
    throw new InvalidRequestError(`${field} must be one of: ${allowed.join(', ')}.`);
  }

  return value as T;
}

/** Query string opcional que precisa ser um inteiro positivo quando presente. */
export function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new InvalidRequestError(`${field} must be a positive integer.`);
  }

  return Number(value);
}
