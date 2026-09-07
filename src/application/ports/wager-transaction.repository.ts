import type { WagerTransaction } from '../../domain/wagering/wager-transaction.js';

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  findByProviderAndIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined>;
  hasProcessedReversalForReference(referenceTransactionId: string, kind: 'REFUND' | 'ROLLBACK'): Promise<boolean>;
  /**
   * Ids de pendências vencidas, reservadas com `SKIP LOCKED`.
   *
   * Workers concorrentes recebem conjuntos disjuntos em vez de disputarem as
   * mesmas linhas; devolve apenas ids porque cada pendência é reavaliada em
   * sua própria transação.
   */
  claimDuePendingReferences(limit: number, now: Date): Promise<readonly string[]>;
  /**
   * Recarrega sob lock de linha, para reavaliar uma pendência com segurança.
   *
   * A reserva de `claimDuePendingReferences` é apenas uma dica: o lock dela
   * termina junto da transação que a fez. A garantia de que dois workers não
   * apliquem a mesma pendência é este lock, somado à releitura do status.
   */
  findByIdForUpdate(id: string): Promise<WagerTransaction | undefined>;
  save(transaction: WagerTransaction): Promise<void>;
}
