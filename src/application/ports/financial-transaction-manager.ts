import type { InboxRepository } from './inbox.repository.js';
import type { OutboxRepository } from './outbox.repository.js';
import type { WagerTransactionRepository } from './wager-transaction.repository.js';
import type { WalletLedgerRepository } from './wallet-ledger.repository.js';
import type { WalletRepository } from './wallet.repository.js';

/**
 * Repositories de uma única unidade transacional.
 *
 * Inbox e Outbox entram no mesmo escopo justamente para que registro da
 * mensagem, efeito financeiro, lançamento e evento sejam confirmados juntos ou
 * não sejam confirmados. Qualquer um deles fora daqui reabriria a janela de
 * perda ou duplicação que a Inbox e a Outbox existem para fechar.
 */
export interface FinancialTransactionScope {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: WalletLedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

/**
 * Nível de isolamento, nomeado pela aplicação para não vazar o ORM.
 *
 * `READ COMMITTED` é o padrão e basta para escrita, onde a serialização vem do
 * lock pessimista da wallet. `REPEATABLE READ` existe para leituras que
 * comparam mais de uma tabela e precisam do mesmo snapshot em todas as
 * consultas — é o caso da reconciliação.
 */
export type FinancialIsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ';

export interface FinancialTransactionOptions {
  readonly isolationLevel?: FinancialIsolationLevel;
}

/** Porta e token de DI. Cada execute abre uma transação independente. */
export abstract class FinancialTransactionManager {
  abstract execute<T>(
    work: (scope: FinancialTransactionScope) => Promise<T>,
    options?: FinancialTransactionOptions,
  ): Promise<T>;
}
