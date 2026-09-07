export interface OutgoingMessage {
  /** Corpo já serializado; a aplicação não conhece o formato do broker. */
  readonly body: string;
  /** Ordena e serializa mensagens relacionadas em filas FIFO. */
  readonly groupId: string;
  /** Deduplicação do broker — otimização, nunca a garantia final. */
  readonly deduplicationId: string;
}

/**
 * Porta de publicação.
 *
 * Existe para que a camada de aplicação não importe o SDK da AWS: o publisher
 * da Outbox depende deste contrato, e trocar o broker não toca em nada acima
 * da infraestrutura.
 */
export abstract class MessagePublisher {
  abstract publish(message: OutgoingMessage): Promise<void>;
}
