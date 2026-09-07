import { LockMode } from '@mikro-orm/core';
import { noopMetrics, type MetricsPort } from '../../../application/ports/metrics.js';
import type { WalletRepository } from '../../../application/ports/wallet.repository.js';
import type { Wallet } from '../../../domain/wallet/wallet.js';
import { WalletRecord } from '../entities/wallet.record.js';
import { toWallet, toWalletRecord } from '../mappers/wallet.mapper.js';
import type { TransactionContext } from '../transaction-context.js';

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(
    private readonly context: TransactionContext,
    private readonly metrics: MetricsPort = noopMetrics,
  ) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.context.entityManager.findOne(WalletRecord, { id });
    return record === null ? undefined : toWallet(record);
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const record = await this.context.entityManager.findOne(WalletRecord, { playerId, currency });
    return record === null ? undefined : toWallet(record);
  }

  /**
   * O tempo medido aqui é a contenção pela wallet.
   *
   * Com lock pessimista, disputa não vira erro: vira espera. Registrar a
   * duração da aquisição é o que torna a hot wallet visível — a contagem de
   * "conflitos" só existe quando o PostgreSQL levanta deadlock ou lock
   * indisponível, e isso é medido na fronteira transacional.
   */
  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const startedAt = performance.now();

    try {
      const record = await this.context.entityManager.findOne(WalletRecord, { id }, {
        lockMode: LockMode.PESSIMISTIC_WRITE,
        // Uma leitura anterior sem lock não pode fornecer saldo obsoleto após a espera.
        refresh: true,
      });
      return record === null ? undefined : toWallet(record);
    } finally {
      this.metrics.observeWalletLockWait((performance.now() - startedAt) / 1_000);
    }
  }

  async save(wallet: Wallet): Promise<void> {
    const em = this.context.entityManager;
    const existing = await em.findOne(WalletRecord, { id: wallet.id });
    em.persist(toWalletRecord(wallet, existing ?? undefined));
    // Records escalares não permitem ao ORM deduzir a ordem das FKs.
    await em.flush();
  }
}
