import { Logger } from '@nestjs/common';
import {
  ConsumeWagerMessageUseCase,
  wagerCorrelationId,
  type ConsumeOutcome,
  type WagerMessageEnvelope,
} from '../../../application/consume-wager-message.use-case.js';
import { noopMetrics, type MetricsPort } from '../../../application/ports/metrics.js';
import { FinancialPersistenceError } from '../../../application/ports/persistence-error.js';
import type { MessagingOptions } from '../messaging.config.js';
import type { ReceivedMessage, SqsClientAdapter } from './sqs-client.js';
import { parseWagerEnvelope } from './wager-envelope.js';

export interface ConsumerReport {
  readonly received: number;
  readonly acked: number;
  readonly retried: number;
}

/**
 * Adaptador de entrada do SQS.
 *
 * A ordem é deliberada: processar dentro de uma transação, commitar e só então
 * dar `ACK`. Se o processo morrer entre o commit e o `ACK`, a mensagem volta
 * pela visibilidade e a Inbox reconhece que ela já foi processada — nenhum
 * efeito financeiro se repete. O caminho inverso (`ACK` antes do commit)
 * perderia a operação silenciosamente.
 *
 * A política de retry é a do próprio SQS: não dar `ACK` devolve a mensagem
 * depois do visibility timeout, e o redrive policy a encaminha para a DLQ
 * depois de `maxReceiveCount` entregas. Não há laço de retry interno competindo
 * com esse mecanismo.
 */
export class WagerSqsConsumer {
  private readonly logger = new Logger(WagerSqsConsumer.name);

  constructor(
    private readonly sqs: SqsClientAdapter,
    private readonly consume: ConsumeWagerMessageUseCase,
    private readonly options: MessagingOptions,
    private readonly metrics: MetricsPort = noopMetrics,
  ) {}

  async pollOnce(maxMessages = 5, waitSeconds = 1): Promise<ConsumerReport> {
    const messages = await this.sqs.receive(this.options.wagerQueueUrl, maxMessages, waitSeconds);
    let acked = 0;
    let retried = 0;

    for (const message of messages) {
      const handled = await this.handle(message);

      if (handled) {
        await this.sqs.deleteMessage(this.options.wagerQueueUrl, message.receiptHandle);
        acked += 1;
      } else {
        retried += 1;
      }
    }

    return { received: messages.length, acked, retried };
  }

  /** `true` quando a mensagem pode receber `ACK`. */
  private async handle(message: ReceivedMessage): Promise<boolean> {
    const envelope = parseWagerEnvelope(message.body);

    if (envelope === undefined) {
      // Malformada: reentregar não conserta o corpo. Deixar sem `ACK` faz o
      // redrive policy levá-la à DLQ depois do limite, que é onde uma poison
      // message deve parar — sem nunca tocar em dinheiro.
      this.metrics.recordPermanentMessage('malformed');
      this.logger.warn({
        event: 'wager.message.malformed',
        messageId: message.messageId,
        receiveCount: message.receiveCount,
      });

      return false;
    }

    const startedAt = performance.now();

    try {
      const outcome = await this.consume.execute(envelope, message.body);

      this.record(envelope, outcome, (performance.now() - startedAt) / 1_000);

      // Conflito de payload é anomalia permanente do produtor: reprocessar não
      // resolve, então a mensagem segue para a DLQ pelo mesmo caminho.
      return outcome.kind !== 'payload-conflict';
    } catch (error) {
      // Sem `ACK`, o SQS reentrega — o que é, literalmente, uma retentativa.
      this.metrics.recordRetry('sqs_consumer');
      this.logger.error({
        event: 'wager.message.failed',
        messageId: envelope.messageId,
        correlationId: correlationOf(envelope),
        receiveCount: message.receiveCount,
        transient: error instanceof FinancialPersistenceError,
        reason: error instanceof Error ? error.name : 'unknown',
      });

      return false;
    }
  }

  /**
   * Métrica e log do desfecho.
   *
   * O log carrega identificadores e status, nunca o corpo da mensagem nem o
   * valor da operação: diagnóstico precisa saber *qual* transação, não *quanto*
   * ela movimentou.
   */
  private record(envelope: WagerMessageEnvelope, outcome: ConsumeOutcome, seconds: number): void {
    const base = {
      messageId: envelope.messageId,
      correlationId: correlationOf(envelope),
      providerId: envelope.data.providerId,
      walletId: envelope.data.walletId,
    };

    if (outcome.kind === 'processed') {
      this.metrics.recordWagerTransaction(outcome.result.status, 'sqs');
      this.metrics.observeWagerProcessing('sqs', seconds);

      if (outcome.result.idempotentReplay) {
        this.metrics.recordDuplicate('financial_idempotency');
      }

      this.logger.log({
        ...base,
        event: 'wager.processed',
        transactionId: outcome.result.transactionId,
        status: outcome.result.status,
        failureCode: outcome.result.failureCode,
        idempotentReplay: outcome.result.idempotentReplay,
      });

      return;
    }

    if (outcome.kind === 'duplicate') {
      this.metrics.recordDuplicate('inbox_redelivery');
      this.logger.warn({ ...base, event: 'inbox.duplicate' });

      return;
    }

    this.metrics.recordPermanentMessage('payload_conflict');
    this.logger.warn({ ...base, event: 'inbox.payload_conflict' });
  }
}

function correlationOf(envelope: WagerMessageEnvelope): string {
  return wagerCorrelationId(envelope.data.providerId, envelope.data.idempotencyKey);
}
