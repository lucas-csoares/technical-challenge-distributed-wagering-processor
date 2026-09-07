import type { Wallet } from '../../domain/wallet/wallet.js';

/** Disponível somente dentro do callback de FinancialTransactionManager. */
export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  /** Carrega estado atualizado e mantém o lock até o fim da transação. */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  /** Para alterar uma wallet existente, carregue-a primeiro com findByIdForUpdate. */
  save(wallet: Wallet): Promise<void>;
}
