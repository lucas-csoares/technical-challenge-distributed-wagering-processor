import { InvalidInputError } from './domain-error.js';

/**
 * Identificadores são opacos para o domínio: qualquer string não vazia serve,
 * desde que já esteja normalizada. Espaços nas bordas são rejeitados em vez de
 * removidos, porque `"provider-a "` e `"provider-a"` seriam identidades
 * distintas no banco e produziriam `payloadHash` distintos.
 */
export function assertIdentifier(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new InvalidInputError(`${field} must be a non-empty identifier without surrounding whitespace.`);
  }
}

/**
 * Valida e copia um instante recebido de fora do domínio.
 *
 * A cópia impede que quem chamou continue mutando a `Date` já incorporada ao
 * estado de uma entidade — `Date` é mutável e seria uma porta aberta para
 * alterar um lançamento supostamente imutável.
 */
export function toInstant(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidInputError(`${field} must be a valid Date.`);
  }

  return new Date(value.getTime());
}

/** Cópia sem validação, para reconstrução de estado já persistido. */
export function cloneInstant(value: Date): Date {
  return new Date(value.getTime());
}
