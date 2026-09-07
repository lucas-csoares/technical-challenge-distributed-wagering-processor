import { createHash } from 'node:crypto';
import type { EventContext } from './events/integration-event.js';
import { FinancialTransactionManager } from './ports/financial-transaction-manager.js';
import { isUniqueConstraint } from './ports/persistence-error.js';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionCommand,
  type ProcessWagerTransactionResult,
} from './process-wager-transaction.use-case.js';

export interface WagerMessageEnvelope {
  readonly messageId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly data: ProcessWagerTransactionCommand;
}

export type ConsumeOutcome =
  /** Processada agora: efeitos aplicados nesta execução. */
  | { readonly kind: 'processed'; readonly result: ProcessWagerTransactionResult }
  /** Já registrada na Inbox: redelivery segura, nenhum efeito novo. */
  | { readonly kind: 'duplicate' }
  /** Mesma identidade de transporte com corpo diferente: não é replay. */
  | { readonly kind: 'payload-conflict' };

/** Hash do corpo recebido — identidade de transporte, não de idempotência financeira. */
export function hashMessagePayload(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Correlação de uma operação vinda da fila.
 *
 * A própria identidade da operação serve como correlação: ela é estável entre
 * reentregas e entre canais, o que é exatamente o que um identificador de
 * correlação precisa ser — e evita inventar um contexto global compartilhado.
 */
export function wagerCorrelationId(providerId: string, idempotencyKey: string): string {
  return `${providerId}:${idempotencyKey}`;
}

/**
 * Consumo de uma mensagem de wagering.
 *
 * Registro na Inbox, efeito financeiro, lançamento e eventos da Outbox
 * acontecem na **mesma** transação SQL: o caso de uso financeiro é executado
 * dentro do escopo já aberto aqui, e não abre outro. É isso que fecha a janela
 * entre "processei" e "anotei que processei" — as duas coisas passam a ser a
 * mesma coisa, e o `ACK` só acontece depois do commit, no adaptador.
 *
 * A deduplicação é em dois níveis e eles não se confundem. A Inbox responde
 * por `(consumerName, messageId)`, uma identidade de transporte: a mesma
 * mensagem reentregue não é reprocessada. A idempotência financeira responde
 * por `(providerId, idempotencyKey)`: a mesma operação reenviada em uma
 * mensagem nova — `messageId` diferente — passa pela Inbox e é resolvida como
 * replay pelo núcleo financeiro, devolvendo o resultado original.
 */
export class ConsumeWagerMessageUseCase {
  constructor(
    private readonly transactions: FinancialTransactionManager,
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly consumerName: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(envelope: WagerMessageEnvelope, rawBody: string): Promise<ConsumeOutcome> {
    const payloadHash = hashMessagePayload(rawBody);
    const existing = await this.transactions.execute((scope) =>
      scope.inbox.find(this.consumerName, envelope.messageId),
    );

    if (existing !== undefined) {
      // Mesma identidade de transporte com corpo diferente é anomalia do
      // produtor, não replay: aceitar em silêncio aplicaria efeitos de um
      // payload sob a identidade de outro.
      if (existing.payloadHash !== payloadHash) {
        return { kind: 'payload-conflict' };
      }

      return { kind: 'duplicate' };
    }

    const context: EventContext = {
      correlationId: wagerCorrelationId(envelope.data.providerId, envelope.data.idempotencyKey),
      causationId: envelope.messageId,
    };

    try {
      const result = await this.transactions.execute(async (scope) => {
        await scope.inbox.register({
          consumerName: this.consumerName,
          messageId: envelope.messageId,
          payloadHash,
          processedAt: this.now(),
        });

        return this.processWager.executeInScope(scope, envelope.data, context);
      });

      return { kind: 'processed', result };
    } catch (error) {
      if (isUniqueConstraint(error, 'inbox_messages_pkey')) {
        return this.resolveInboxUniqueRace(envelope.messageId, payloadHash, error);
      }

      throw error;
    }
  }

  /**
   * Desempate depois de perder a corrida pela chave da Inbox.
   *
   * Perder a corrida garante que nada desta execução foi aplicado — a transação
   * inteira foi revertida —, mas não diz *qual* corpo venceu. Concluir
   * `duplicate` aqui aceitaria em silêncio um payload divergente sempre que a
   * verificação prévia e a inserção concorrente se cruzassem, que é exatamente
   * a janela que o conflito de payload existe para cobrir.
   *
   * A releitura precisa de uma transação nova: a anterior está abortada e não
   * responde mais consultas. É a mesma forma usada nas demais corridas de
   * idempotência do projeto — a constraint é a garantia final, e o vencedor
   * persistido é a única fonte de verdade sobre o desempate.
   */
  private async resolveInboxUniqueRace(
    messageId: string,
    payloadHash: string,
    violation: unknown,
  ): Promise<ConsumeOutcome> {
    const winner = await this.transactions.execute((scope) =>
      scope.inbox.find(this.consumerName, messageId),
    );

    if (winner === undefined) {
      // Sem vencedor para comparar não há decisão defensável: propagar mantém a
      // mensagem sem `ACK` e deixa a reentrega tentar de novo.
      throw violation;
    }

    return winner.payloadHash === payloadHash
      ? { kind: 'duplicate' }
      : { kind: 'payload-conflict' };
  }
}
