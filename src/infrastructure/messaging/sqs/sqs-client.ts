import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { MessagingOptions } from '../messaging.config.js';

export interface ReceivedMessage {
  readonly messageId: string;
  readonly receiptHandle: string;
  readonly body: string;
  readonly receiveCount: number;
}

export interface SendOptions {
  readonly queueUrl: string;
  readonly body: string;
  readonly groupId: string;
  readonly deduplicationId: string;
}

/**
 * Camada fina sobre o SDK.
 *
 * Concentra aqui o vocabulário da AWS — receipt handle, atributos, comandos —
 * para que consumidor e publisher trabalhem com um tipo próprio. Não há
 * política de retry nem regra de negócio nesta classe.
 */
export class SqsClientAdapter {
  private readonly client: SQSClient;

  constructor(private readonly options: MessagingOptions) {
    this.client = new SQSClient({
      region: options.region,
      endpoint: options.endpoint,
      credentials: options.credentials,
    });
  }

  async send(options: SendOptions): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: options.queueUrl,
        MessageBody: options.body,
        MessageGroupId: options.groupId,
        MessageDeduplicationId: options.deduplicationId,
      }),
    );
  }

  async receive(queueUrl: string, maxMessages = 5, waitSeconds = 1): Promise<ReceivedMessage[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: waitSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );

    return (response.Messages ?? []).flatMap((message) => {
      if (
        message.MessageId === undefined ||
        message.ReceiptHandle === undefined ||
        message.Body === undefined
      ) {
        return [];
      }

      return [
        {
          messageId: message.MessageId,
          receiptHandle: message.ReceiptHandle,
          body: message.Body,
          receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? '1'),
        },
      ];
    });
  }

  /** O ACK do SQS: a mensagem só some da fila depois disto. */
  async deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
    );
  }

  /**
   * Mensagens aguardando na DLQ, segundo o próprio broker.
   *
   * `undefined` quando o SQS não responde: é diferente de zero, e reportar zero
   * ali afirmaria que a DLQ está vazia sem ter olhado.
   */
  async dlqDepth(): Promise<number | undefined> {
    try {
      const response = await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.options.dlqUrl,
          AttributeNames: ['ApproximateNumberOfMessages'],
        }),
      );
      const approximate = response.Attributes?.ApproximateNumberOfMessages;

      return approximate === undefined ? undefined : Number.parseInt(approximate, 10);
    } catch {
      return undefined;
    }
  }

  /** Sonda de readiness: confirma que a fila responde. */
  async isReachable(): Promise<boolean> {
    try {
      await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.options.wagerQueueUrl,
          AttributeNames: ['QueueArn'],
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.client.destroy();
  }
}
