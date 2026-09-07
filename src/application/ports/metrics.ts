import type { WagerTransactionStatus } from '../../domain/wagering/wager-transaction.js';

/** Origem lógica da operação. Conjunto fechado: vira label de métrica. */
export type WagerTransport = 'http' | 'sqs' | 'pending_reference_worker';

/**
 * Os dois níveis de deduplicação do sistema, mantidos distintos.
 *
 * `financial_idempotency` é a mesma operação reenviada e resolvida como replay;
 * `inbox_redelivery` é a mesma mensagem reentregue pelo transporte. Somá-las
 * esconderia justamente a diferença que importa em diagnóstico.
 */
export type DuplicateSource = 'financial_idempotency' | 'inbox_redelivery';

export type RetryComponent = 'sqs_consumer' | 'outbox' | 'pending_reference';

/** Anomalia que reprocessar não conserta — o que a política de DLQ recolhe. */
export type PermanentMessageReason = 'malformed' | 'payload_conflict';

/** Erros de lock que o PostgreSQL levanta, em vez de apenas esperar. */
export type LockConflictReason = 'deadlock' | 'lock_timeout';

/**
 * Porta de métricas operacionais.
 *
 * Os métodos são nomeados pelo fato observado, não por um `increment(nome)`
 * genérico: é o que mantém o vocabulário de negócio na aplicação e impede que
 * um identificador dinâmico vire label por descuido — todos os rótulos aqui são
 * uniões fechadas.
 *
 * Nenhuma implementação pode lançar. Métrica é efeito colateral operacional e
 * não participa da atomicidade financeira: uma falha de observabilidade jamais
 * pode impedir um commit, um `ACK` ou a publicação de um evento.
 */
export abstract class MetricsPort {
  /** Uma transação alcançou um estado, pelo transporte informado. */
  abstract recordWagerTransaction(status: WagerTransactionStatus, transport: WagerTransport): void;

  /** Latência de ponta a ponta do processamento de uma operação. */
  abstract observeWagerProcessing(transport: WagerTransport, seconds: number): void;

  abstract recordDuplicate(source: DuplicateSource): void;

  abstract recordPermanentMessage(reason: PermanentMessageReason): void;

  abstract recordRetry(component: RetryComponent): void;

  /** Tempo até adquirir o lock pessimista da wallet. */
  abstract observeWalletLockWait(seconds: number): void;

  abstract recordLockConflict(reason: LockConflictReason): void;

  /** Idade do evento no instante em que foi publicado. */
  abstract observeOutboxPublishLag(seconds: number): void;

  /** Idade do evento pendente mais antigo visto no último ciclo do publisher. */
  abstract setOutboxOldestPendingAge(seconds: number): void;

  abstract recordReconciliationDivergence(): void;
}

/** Implementação nula: o padrão de quem é construído sem observabilidade. */
export class NoopMetrics extends MetricsPort {
  override recordWagerTransaction(): void {}
  override observeWagerProcessing(): void {}
  override recordDuplicate(): void {}
  override recordPermanentMessage(): void {}
  override recordRetry(): void {}
  override observeWalletLockWait(): void {}
  override recordLockConflict(): void {}
  override observeOutboxPublishLag(): void {}
  override setOutboxOldestPendingAge(): void {}
  override recordReconciliationDivergence(): void {}
}

/** Sem estado, então uma instância compartilhada basta como padrão. */
export const noopMetrics: MetricsPort = new NoopMetrics();
