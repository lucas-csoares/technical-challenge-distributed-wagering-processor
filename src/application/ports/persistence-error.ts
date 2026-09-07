/** Erro de uso: repositories não podem sobreviver ao callback transacional. */
export class InactiveTransactionError extends Error {
  constructor() {
    super('Financial repositories require an active transaction scope.');
    this.name = 'InactiveTransactionError';
  }
}

/** Não implica rejeição de negócio nem decide se a operação deve ser repetida. */
export class FinancialPersistenceError extends Error {
  constructor(cause: unknown) {
    super('Financial persistence failed.', { cause });
    this.name = 'FinancialPersistenceError';
  }
}

/** Detecta uma constraint PostgreSQL sem transformar qualquer 23505 em replay. */
export function isUniqueConstraint(error: unknown, constraint: string): boolean {
  const cause = error instanceof FinancialPersistenceError ? error.cause : error;
  if (typeof cause !== 'object' || cause === null) return false;
  const value = cause as { code?: unknown; constraint?: unknown; cause?: unknown };
  return value.code === '23505' && value.constraint === constraint;
}
