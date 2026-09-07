/**
 * Códigos estáveis e legíveis por máquina para rejeições de negócio.
 *
 * O valor textual é o contrato: ele é persistido, publicado em eventos e
 * exposto aos provedores. Nomes de membros podem mudar, valores não.
 * Somente códigos exercitados por regras já implementadas estão listados.
 */
export enum FailureCode {
  /** `BET` sem saldo disponível na wallet. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** Reversão (`ROLLBACK` de `WIN`/`REFUND`) que deixaria o saldo negativo. */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  /** Moeda da operação diferente da moeda da wallet ou da referência. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** Valor monetário incompatível com o tipo de operação. */
  InvalidAmount = 'INVALID_AMOUNT',
  /** `REFUND`/`ROLLBACK` submetido sem `referenceExternalTransactionId`. */
  ReferenceRequired = 'REFERENCE_REQUIRED',
  /** Operação que não aceita referência recebeu uma. */
  ReferenceNotSupported = 'REFERENCE_NOT_SUPPORTED',
  /** Referência existe, mas seu `kind` não pode ser revertido/associado. */
  ReferenceKindNotEligible = 'REFERENCE_KIND_NOT_ELIGIBLE',
  /** Referência existe, mas não está `PROCESSED`. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Referência pertence a outro provider, player, wallet ou rodada. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Reversão parcial: valor diferente do valor da referência. */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** Referência já revertida por uma operação do mesmo tipo. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
}

/**
 * Códigos de falha permanente de infraestrutura, que levam a `FAILED`.
 *
 * Espaço de códigos deliberadamente separado de `FailureCode`: uma aposta sem
 * saldo é decisão de negócio e termina em `REJECTED`; um erro técnico que não
 * se resolve com nova tentativa termina em `FAILED`. Manter os dois no mesmo
 * enum permitiria escrever `fail(INSUFFICIENT_FUNDS)`, que é um estado
 * semanticamente incoerente.
 *
 * A taxonomia é mínima de propósito. Ela cresce junto da política de
 * retry/DLQ do consumidor SQS, quando houver como distinguir causas concretas.
 */
export enum InfrastructureFailureCode {
  /** Erro técnico permanente: novas tentativas não mudariam o resultado. */
  PermanentInfrastructureFailure = 'PERMANENT_INFRASTRUCTURE_FAILURE',
}

/** Valor gravado na coluna de falha, qualquer que seja a origem. */
export type PersistedFailureCode = FailureCode | InfrastructureFailureCode;

export const BUSINESS_FAILURE_CODES: readonly FailureCode[] = Object.values(FailureCode);

export const INFRASTRUCTURE_FAILURE_CODES: readonly InfrastructureFailureCode[] =
  Object.values(InfrastructureFailureCode);
