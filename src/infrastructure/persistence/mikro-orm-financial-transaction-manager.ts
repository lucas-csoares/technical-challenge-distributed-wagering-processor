import { DriverException, IsolationLevel } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  FinancialTransactionManager,
  type FinancialTransactionOptions,
  type FinancialTransactionScope,
} from '../../application/ports/financial-transaction-manager.js';
import { noopMetrics, type MetricsPort } from '../../application/ports/metrics.js';
import { FinancialPersistenceError } from '../../application/ports/persistence-error.js';
import { MikroOrmInboxRepository } from './repositories/mikro-orm-inbox.repository.js';
import { MikroOrmOutboxRepository } from './repositories/mikro-orm-outbox.repository.js';
import { MikroOrmWagerTransactionRepository } from './repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmWalletLedgerRepository } from './repositories/mikro-orm-wallet-ledger.repository.js';
import { MikroOrmWalletRepository } from './repositories/mikro-orm-wallet.repository.js';
import { TransactionContext } from './transaction-context.js';

/** Erros de lock do PostgreSQL, os únicos que são conflito e não espera. */
const LOCK_CONFLICT_CODES: Readonly<Record<string, 'deadlock' | 'lock_timeout'>> = {
  '40P01': 'deadlock',
  '55P03': 'lock_timeout',
};

export class MikroOrmFinancialTransactionManager extends FinancialTransactionManager {
  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: MetricsPort = noopMetrics,
  ) { super(); }

  override async execute<T>(
    work: (scope: FinancialTransactionScope) => Promise<T>,
    options: FinancialTransactionOptions = {},
  ): Promise<T> {
    const isolationLevel =
      options.isolationLevel === 'REPEATABLE READ'
        ? IsolationLevel.REPEATABLE_READ
        : IsolationLevel.READ_COMMITTED;
    const em = this.orm.em.fork({ clear: true, useContext: false, disableContextResolution: true });

    try {
      return await em.transactional(async (transactionalEm) => {
        const context = new TransactionContext(transactionalEm);
        const scope: FinancialTransactionScope = {
          wallets: new MikroOrmWalletRepository(context, this.metrics),
          transactions: new MikroOrmWagerTransactionRepository(context),
          ledger: new MikroOrmWalletLedgerRepository(context),
          inbox: new MikroOrmInboxRepository(context),
          outbox: new MikroOrmOutboxRepository(context),
        };
        try {
          return await work(scope);
        } finally {
          context.close();
        }
      }, { isolationLevel, clear: true });
    } catch (error) {
      if (error instanceof DriverException) {
        this.recordLockConflict(error);
        throw new FinancialPersistenceError(error);
      }
      throw error;
    }
  }

  private recordLockConflict(error: DriverException): void {
    const code = (error as { code?: unknown }).code;
    const reason = typeof code === 'string' ? LOCK_CONFLICT_CODES[code] : undefined;

    if (reason !== undefined) {
      this.metrics.recordLockConflict(reason);
    }
  }
}
