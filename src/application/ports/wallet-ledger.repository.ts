import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry.js';
import type { LedgerCursorPosition } from '../ledger-cursor.js';

export interface LedgerPageQuery {
  readonly walletId: string;
  /** Exclusivo: a página começa no lançamento seguinte a esta posição. */
  readonly after?: LedgerCursorPosition;
  readonly limit: number;
}

export interface WalletLedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Leitura integral, ordenada por `(createdAt, id)`; usada na reconciliação. */
  findByWalletId(walletId: string): Promise<readonly WalletLedgerEntry[]>;
  /** Página por keyset na mesma ordenação, para a consulta paginada do ledger. */
  findPage(query: LedgerPageQuery): Promise<readonly WalletLedgerEntry[]>;
}
