/** Envelope serializado, gravado no payload da Outbox e publicado como JSON. */
export interface IntegrationEventEnvelope<T> {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: string;
  readonly version: number;
  readonly data: T;
}

export interface IntegrationEventProps<T> {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: T;
}

/**
 * Evento de integração.
 *
 * `eventType` e `version` ficam no tipo concreto, não em uma string solta no
 * call site: um evento renomeado ou versionado por engano deixa de compilar em
 * vez de virar um payload que ninguém consegue interpretar do outro lado.
 *
 * `eventId` é estável e nasce junto do evento, dentro da transação financeira.
 * Ele é o que permite ao consumidor deduplicar quando a publicação repete —
 * ver *at-least-once* em ARCHITECTURE.md.
 *
 * Valores monetários entram em `data` já serializados (`MoneyProps`), nunca
 * como instância de `Money` ou `bigint`, para que o payload continue JSON
 * estável e versionável.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

/**
 * Origem lógica da operação, propagada explicitamente.
 *
 * `correlationId` amarra tudo o que pertence à mesma intenção do provedor;
 * `causationId` aponta para o que causou diretamente este efeito — no consumo
 * SQS, o `messageId` recebido. Nada disso vem de contexto global: quem chama o
 * caso de uso informa, e por isso HTTP e SQS produzem eventos igualmente
 * rastreáveis sem compartilhar estado.
 */
export interface EventContext {
  readonly correlationId: string;
  readonly causationId?: string;
}
