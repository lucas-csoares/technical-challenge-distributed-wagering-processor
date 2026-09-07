import { FailureCode } from './failure-code.js';

/**
 * Raiz das exceções do domínio financeiro.
 *
 * A hierarquia separa três situações que a aplicação trata de formas
 * diferentes e que não devem ser colapsadas em uma única categoria:
 *
 * - `InvalidInputError`: dado malformado ou uso indevido de uma API do
 *   domínio. Não é rejeição de negócio e não possui `failureCode`.
 * - `DomainRuleViolationError`: rejeição financeira, com `failureCode`
 *   estável destinado ao provedor.
 * - `InvalidTransactionStateError`: erro de programação — tentativa de
 *   transicionar uma transação já terminal.
 */
export abstract class DomainError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Entrada malformada ou chamada indevida de uma operação do domínio. */
export class InvalidInputError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

/** Valor monetário fora do formato aceito pelo domínio. */
export class InvalidMoneyError extends InvalidInputError {}

/** Rejeição de negócio, sempre acompanhada de um `failureCode` estável. */
export abstract class DomainRuleViolationError extends DomainError {
  protected constructor(
    message: string,
    readonly failureCode: FailureCode,
  ) {
    super(message);
  }
}

/** `BET` (ou qualquer débito comum) sem saldo suficiente. */
export class InsufficientFundsError extends DomainRuleViolationError {
  constructor(message = 'Wallet balance is insufficient for this debit.') {
    super(message, FailureCode.InsufficientFunds);
  }
}

/**
 * Reversão que deixaria o saldo negativo.
 *
 * Distinta de `InsufficientFundsError`: uma aposta sem saldo é um erro do
 * jogador, uma reversão sem saldo é uma inconsistência operacional entre
 * provedor e plataforma, e o provedor precisa distinguir as duas.
 */
export class ReversalWouldOverdrawError extends DomainRuleViolationError {
  constructor(message = 'Reversal would leave the wallet balance negative.') {
    super(message, FailureCode.ReversalWouldOverdraw);
  }
}

/** Operação entre moedas diferentes. */
export class CurrencyMismatchError extends DomainRuleViolationError {
  constructor(expected: string, received: string) {
    super(`Expected currency ${expected}, received ${received}.`, FailureCode.CurrencyMismatch);
  }
}

/** Valor monetário incompatível com o tipo de operação submetida. */
export class InvalidAmountError extends DomainRuleViolationError {
  constructor(message: string) {
    super(message, FailureCode.InvalidAmount);
  }
}

/**
 * Referência ausente, incompatível ou inelegível.
 *
 * A categoria é uma só; o `failureCode` diferencia o motivo concreto.
 */
export class InvalidReferenceError extends DomainRuleViolationError {
  constructor(message: string, failureCode: FailureCode) {
    super(message, failureCode);
  }
}

/**
 * Transição a partir de um estado terminal.
 *
 * `PROCESSED`, `REJECTED` e `FAILED` não mudam mais de estado; alcançá-los
 * novamente indica defeito de orquestração, não caminho de negócio.
 */
export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}
