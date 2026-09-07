import {
  MessagePublisher,
  type OutgoingMessage,
} from '../../../application/ports/message-publisher.js';
import type { MessagingOptions } from '../messaging.config.js';
import type { SqsClientAdapter } from './sqs-client.js';

/**
 * Publica eventos de integração na fila de eventos.
 *
 * `MessageGroupId` e `MessageDeduplicationId` são otimizações do broker:
 * ajudam na ordem e evitam algumas duplicatas, mas a garantia de que um efeito
 * financeiro não se repete continua sendo do PostgreSQL. O consumidor deve
 * deduplicar pelo `eventId` do envelope.
 */
export class SqsMessagePublisher extends MessagePublisher {
  constructor(
    private readonly sqs: SqsClientAdapter,
    private readonly options: MessagingOptions,
  ) {
    super();
  }

  override async publish(message: OutgoingMessage): Promise<void> {
    await this.sqs.send({
      queueUrl: this.options.eventsQueueUrl,
      body: message.body,
      groupId: message.groupId,
      deduplicationId: message.deduplicationId,
    });
  }
}
