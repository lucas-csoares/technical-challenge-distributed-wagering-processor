import type { MoneyProps } from '../../domain/shared/money.js';
import type { LedgerDirection } from '../../domain/wallet/ledger-direction.js';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry.js';
import type { Wallet } from '../../domain/wallet/wallet.js';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction.js';
import { encodeLedgerCursor, decodeLedgerCursor } from '../ledger-cursor.js';
import { FinancialTransactionManager } from '../ports/financial-transaction-manager.js';

/**
 * Consultas de leitura do núcleo financeiro.
 *
 * São application services simples, sem barramento nem CQRS: cada uma abre a
 * mesma fronteira transacional dos casos de uso e devolve *views* — objetos
 * planos com `MoneyProps`, nunca entidades de domínio nem records de
 * persistência. Isso mantém o transporte livre para serializar o resultado sem
 * conhecer o domínio, e o domínio livre do transporte.
 */

export interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LedgerEntryView {
  readonly id: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly createdAt: Date;
}

export interface LedgerPageView {
  readonly items: readonly LedgerEntryView[];
  /** `undefined` quando a página atual encerra o histórico. */
  readonly nextCursor: string | undefined;
}

export interface WagerTransactionView {
  readonly transactionId: string;
  readonly providerId: string | undefined;
  readonly externalTransactionId: string | undefined;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string | undefined;
  readonly gameId: string | undefined;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly status: string;
  readonly failureCode: string | undefined;
  readonly referenceExternalTransactionId: string | undefined;
  readonly referenceTransactionId: string | undefined;
  readonly createdAt: Date;
  readonly processedAt: Date | undefined;
}

export interface LedgerPageRequest {
  readonly walletId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

/** Página padrão do desafio; o teto evita varreduras longas sob um `limit` livre. */
export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 100;

export class GetWalletQuery {
  constructor(private readonly transactions: FinancialTransactionManager) {}

  async execute(walletId: string): Promise<WalletView | undefined> {
    return this.transactions.execute(async (scope) => {
      const wallet = await scope.wallets.findById(walletId);

      return wallet === undefined ? undefined : toWalletView(wallet);
    });
  }
}

export class GetWalletLedgerQuery {
  constructor(private readonly transactions: FinancialTransactionManager) {}

  /** `undefined` distingue wallet inexistente de wallet sem lançamentos. */
  async execute(request: LedgerPageRequest): Promise<LedgerPageView | undefined> {
    const limit = clampLimit(request.limit);
    const after = request.cursor === undefined ? undefined : decodeLedgerCursor(request.cursor);

    return this.transactions.execute(async (scope) => {
      const wallet = await scope.wallets.findById(request.walletId);

      if (wallet === undefined) {
        return undefined;
      }

      // Uma linha a mais responde se existe próxima página sem uma contagem.
      const entries = await scope.ledger.findPage({
        walletId: request.walletId,
        after,
        limit: limit + 1,
      });
      const page = entries.slice(0, limit);
      const last = page.at(-1);
      const hasMore = entries.length > limit;

      return {
        items: page.map(toLedgerEntryView),
        nextCursor:
          hasMore && last !== undefined
            ? encodeLedgerCursor({ createdAt: last.createdAt, id: last.id })
            : undefined,
      };
    });
  }
}

export class GetWagerTransactionQuery {
  constructor(private readonly transactions: FinancialTransactionManager) {}

  async execute(transactionId: string): Promise<WagerTransactionView | undefined> {
    return this.transactions.execute(async (scope) => {
      const transaction = await scope.transactions.findById(transactionId);

      return transaction === undefined ? undefined : toWagerTransactionView(transaction);
    });
  }

  /** A identidade externa é do par: dois providers podem repetir o mesmo id. */
  async executeByExternalIdentity(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView | undefined> {
    return this.transactions.execute(async (scope) => {
      const transaction = await scope.transactions.findByProviderAndExternalTransactionId(
        providerId,
        externalTransactionId,
      );

      return transaction === undefined ? undefined : toWagerTransactionView(transaction);
    });
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LEDGER_LIMIT;
  }

  return Math.min(Math.max(limit, 1), MAX_LEDGER_LIMIT);
}

function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

function toLedgerEntryView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt,
  };
}

/** `payloadHash` e `idempotencyKey` ficam de fora: são internos à idempotência. */
function toWagerTransactionView(transaction: WagerTransaction): WagerTransactionView {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    failureCode: transaction.failureCode,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    referenceTransactionId: transaction.referenceTransactionId,
    createdAt: transaction.createdAt,
    processedAt: transaction.processedAt,
  };
}
