import type { InboxRecord, InboxRepository } from '../../../application/ports/inbox.repository.js';
import { InboxMessageRecord } from '../entities/inbox-message.record.js';
import { toUndefined } from '../mappers/nullable.js';
import type { TransactionContext } from '../transaction-context.js';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly context: TransactionContext) {}

  async find(consumerName: string, messageId: string): Promise<InboxRecord | undefined> {
    const record = await this.context.entityManager.findOne(InboxMessageRecord, {
      consumerName,
      messageId,
    });

    if (record === null) {
      return undefined;
    }

    return {
      consumerName: record.consumerName,
      messageId: record.messageId,
      payloadHash: record.payloadHash,
      processedAt: toUndefined(record.processedAt),
    };
  }

  /**
   * `INSERT` explícito: a violação de unicidade é o sinal de que outra
   * instância venceu a corrida por esta mensagem, e ela precisa chegar até
   * quem chamou em vez de virar um `UPDATE` silencioso.
   */
  async register(record: InboxRecord): Promise<void> {
    await this.context.entityManager.insert(InboxMessageRecord, {
      consumerName: record.consumerName,
      messageId: record.messageId,
      payloadHash: record.payloadHash,
      receivedAt: new Date(),
      processedAt: record.processedAt ?? null,
    });
  }

  async markProcessed(consumerName: string, messageId: string, at: Date): Promise<void> {
    await this.context.entityManager.nativeUpdate(
      InboxMessageRecord,
      { consumerName, messageId },
      { processedAt: at },
    );
  }
}
