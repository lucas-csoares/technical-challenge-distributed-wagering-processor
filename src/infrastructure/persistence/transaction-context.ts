import type { EntityManager } from '@mikro-orm/postgresql';
import { InactiveTransactionError } from '../../application/ports/persistence-error.js';

/** Ciclo de vida local; quem mantém os locks é a transação PostgreSQL. */
export class TransactionContext {
  private active = true;

  constructor(private readonly em: EntityManager) {}

  get entityManager(): EntityManager {
    if (!this.active || !this.em.isInTransaction()) {
      throw new InactiveTransactionError();
    }
    return this.em;
  }

  close(): void {
    this.active = false;
  }
}
