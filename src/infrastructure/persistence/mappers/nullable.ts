/**
 * Ponte entre a ausência do SQL e a do TypeScript.
 *
 * O PostgreSQL devolve `null` em colunas vazias; o domínio modela ausência
 * como `undefined`. Sem a conversão explícita, um `null` atravessaria uma
 * propriedade declarada `string | undefined` e o tipo passaria a mentir.
 */
export function toUndefined<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

export function toNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}
