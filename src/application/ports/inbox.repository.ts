export interface InboxRecord {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly processedAt: Date | undefined;
}

/**
 * Deduplicação de transporte, persistida.
 *
 * A identidade é `(consumerName, messageId)` e vale por consumidor: dois
 * consumidores diferentes devem poder processar a mesma mensagem. Isso é
 * deliberadamente distinto da idempotência financeira, que usa
 * `(providerId, idempotencyKey)` — ver *Idempotência em dois níveis* em
 * ARCHITECTURE.md.
 */
export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxRecord | undefined>;
  /** Falha com violação de unicidade quando a mensagem já foi registrada. */
  register(record: InboxRecord): Promise<void>;
  markProcessed(consumerName: string, messageId: string, at: Date): Promise<void>;
}
