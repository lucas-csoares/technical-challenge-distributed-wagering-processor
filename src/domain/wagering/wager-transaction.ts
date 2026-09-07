import {
  InvalidAmountError,
  InvalidInputError,
  InvalidReferenceError,
  InvalidTransactionStateError,
} from '../shared/domain-error.js';
import {
  FailureCode,
  type InfrastructureFailureCode,
  type PersistedFailureCode,
} from '../shared/failure-code.js';
import { assertIdentifier, cloneInstant, toInstant } from '../shared/guards.js';
import type { Money } from '../shared/money.js';
import { invertDirection, LedgerDirection } from '../wallet/ledger-direction.js';

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Nunca submetido por provedores. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

/** Tipos que um provedor pode submeter por HTTP ou fila. */
export type SubmittableWagerTransactionKind = Exclude<
  WagerTransactionKind,
  WagerTransactionKind.Opening
>;

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

const TERMINAL_STATUSES: readonly WagerTransactionStatus[] = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
];

/** Operações que nunca carregam referência. `WIN` a aceita, mas não a exige. */
const KINDS_WITHOUT_REFERENCE: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Opening,
  WagerTransactionKind.Bet,
  WagerTransactionKind.Loss,
];

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  /** Fornecido pela camada de idempotência; o domínio não calcula hashes. */
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: SubmittableWagerTransactionKind;
  readonly money: Money;
  /** Id no provedor, não o id interno. */
  readonly referenceExternalTransactionId?: string;
  readonly createdAt: Date;
}

/**
 * `OPENING` não tem identidade externa: não vem de provedor, não pertence a
 * rodada nem jogo e não carrega chave de idempotência de requisição. Só o que
 * a wallet precisa para o crédito de abertura é informado.
 */
export interface CreateOpeningTransactionProps {
  readonly id: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly money: Money;
  readonly createdAt: Date;
}

export interface WagerTransactionState {
  readonly id: string;
  readonly providerId: string | undefined;
  readonly externalTransactionId: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly payloadHash: string | undefined;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string | undefined;
  readonly gameId: string | undefined;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId: string | undefined;
  readonly failureCode: PersistedFailureCode | undefined;
  readonly processedAt: Date | undefined;
  readonly resultBalance?: Money | undefined;
  readonly referenceAttempts?: number;
  readonly nextReferenceAttemptAt?: Date | undefined;
}

/**
 * Operação de wagering e sua máquina de estados.
 *
 * Transições válidas:
 *
 * | de \ para         | PENDING_REFERENCE | PROCESSED | REJECTED | FAILED |
 * | ----------------- | ----------------- | --------- | -------- | ------ |
 * | PENDING           | sim               | sim       | sim      | sim    |
 * | PENDING_REFERENCE | não               | sim       | sim      | sim    |
 * | PROCESSED         | não               | não       | não      | não    |
 * | REJECTED          | não               | não       | não      | não    |
 * | FAILED            | não               | não       | não      | não    |
 *
 * `PENDING_REFERENCE` não se repete: uma tentativa do worker que não encontra
 * a referência deixa a linha como está, e o controle de tentativas pertence à
 * aplicação. Sair de um estado terminal é erro de programação, sinalizado por
 * `InvalidTransactionStateError`, não rejeição de negócio.
 */
export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string | undefined,
    readonly externalTransactionId: string | undefined,
    readonly idempotencyKey: string | undefined,
    readonly payloadHash: string | undefined,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string | undefined,
    readonly gameId: string | undefined,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    readonly referenceExternalTransactionId: string | undefined,
    private readonly _createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: PersistedFailureCode | undefined,
    private _processedAt: Date | undefined,
    private _resultBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceAttemptAt: Date | undefined,
  ) {}

  /** Nasce em `PENDING`. Recusa `OPENING` e valida a exigência de referência. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    assertSubmittableKind(props.kind);
    assertIdentifier(props.roundId, 'roundId');
    assertIdentifier(props.gameId, 'gameId');

    const reference = props.referenceExternalTransactionId;

    if (requiresReferenceFor(props.kind)) {
      if (reference === undefined) {
        throw new InvalidReferenceError(
          `${props.kind} requires referenceExternalTransactionId.`,
          FailureCode.ReferenceRequired,
        );
      }
    } else if (reference !== undefined && KINDS_WITHOUT_REFERENCE.includes(props.kind)) {
      throw new InvalidReferenceError(
        `${props.kind} does not accept referenceExternalTransactionId.`,
        FailureCode.ReferenceNotSupported,
      );
    }

    if (reference !== undefined) {
      assertIdentifier(reference, 'referenceExternalTransactionId');
    }

    assertIdentifier(props.id, 'id');
    assertIdentifier(props.providerId, 'providerId');
    assertIdentifier(props.externalTransactionId, 'externalTransactionId');
    assertIdentifier(props.idempotencyKey, 'idempotencyKey');
    assertIdentifier(props.payloadHash, 'payloadHash');
    assertIdentifier(props.walletId, 'walletId');
    assertIdentifier(props.playerId, 'playerId');
    assertSubmittedAmount(props.kind, props.money);

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      reference,
      toInstant(props.createdAt, 'createdAt'),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  /**
   * Único caminho para `OPENING`, reservado ao caso de uso de criação de
   * wallet.
   *
   * A abertura é interna: não tem provedor, id externo, chave de idempotência,
   * payload hash, rodada nem jogo. Esses campos ficam vazios em vez de receber
   * valores fictícios, e é essa ausência — não uma convenção de nome — que
   * impede uma `OPENING` de ser confundida com algo submetido por um provedor.
   */
  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    assertIdentifier(props.id, 'id');
    assertIdentifier(props.walletId, 'walletId');
    assertIdentifier(props.playerId, 'playerId');
    assertSubmittedAmount(WagerTransactionKind.Opening, props.money);

    return new WagerTransaction(
      props.id,
      undefined,
      undefined,
      undefined,
      undefined,
      props.walletId,
      props.playerId,
      undefined,
      undefined,
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      toInstant(props.createdAt, 'createdAt'),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  /** Reconstrói estado persistido: não revalida criação nem transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      cloneInstant(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt === undefined ? undefined : cloneInstant(state.processedAt),
      state.resultBalance,
      state.referenceAttempts ?? 0,
      state.nextReferenceAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): PersistedFailureCode | undefined {
    return this._failureCode;
  }

  get createdAt(): Date {
    return cloneInstant(this._createdAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt === undefined ? undefined : cloneInstant(this._processedAt);
  }

  /** Saldo devolvido ao provedor no instante em que este comando foi decidido. */
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt === undefined
      ? undefined
      : cloneInstant(this._nextReferenceAttemptAt);
  }

  /**
   * Agenda a próxima reavaliação de uma pendência.
   *
   * O contador vive na linha, não em memória do worker: uma instância que caia
   * não zera as tentativas já gastas nem faz outra recomeçar do início.
   */
  scheduleReferenceRetry(attempts: number, nextAttemptAt: Date | undefined): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidInputError('Only a PENDING_REFERENCE transaction schedules a retry.');
    }

    if (attempts < 0) {
      throw new InvalidInputError('referenceAttempts must not be negative.');
    }

    this._referenceAttempts = attempts;
    this._nextReferenceAttemptAt =
      nextAttemptAt === undefined ? undefined : toInstant(nextAttemptAt, 'nextAttemptAt');
  }

  isPendingReference(): boolean {
    return this._status === WagerTransactionStatus.PendingReference;
  }

  /** Zera o agendamento quando a pendência chega a um estado terminal. */
  clearReferenceRetry(): void {
    this._nextReferenceAttemptAt = undefined;
  }

  recordResultBalance(balance: Money): void {
    if (balance.isNegative()) {
      throw new InvalidInputError('resultBalance must be non-negative.');
    }
    this._resultBalance = balance;
  }

  /**
   * `referenceTransactionId` é o id interno da transação referenciada, e é
   * exigido exatamente quando a operação foi submetida com
   * `referenceExternalTransactionId`.
   *
   * Isso vale para `REFUND` e `ROLLBACK`, que sempre carregam a referência
   * externa, e também para o `WIN` que optou por referenciar sua `BET`: se o
   * provedor apontou para uma transação, o registro processado precisa dizer
   * qual registro interno foi de fato resolvido. Um `WIN` sem referência
   * externa é processado sem vínculo interno, e nenhuma operação ganha um
   * vínculo que o provedor não pediu.
   */
  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);

    if (this.referenceExternalTransactionId === undefined) {
      if (referenceTransactionId !== undefined) {
        throw new InvalidInputError(
          `${this.kind} was submitted without a reference and cannot be linked to one.`,
        );
      }
    } else {
      if (referenceTransactionId === undefined) {
        throw new InvalidInputError(`${this.kind} cannot be processed without its reference.`);
      }

      assertIdentifier(referenceTransactionId, 'referenceTransactionId');
    }

    const processedAt = toInstant(at, 'at');

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = processedAt;
  }

  markPendingReference(): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(
        `Cannot transition from ${this._status} to ${WagerTransactionStatus.PendingReference}.`,
      );
    }

    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidInputError(`${this.kind} was submitted without a reference.`);
    }

    this._status = WagerTransactionStatus.PendingReference;
  }

  /** Rejeição por regra de negócio: terminal, sem efeito financeiro. */
  reject(code: FailureCode): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);

    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  /**
   * Falha permanente de infraestrutura: terminal e auditável.
   *
   * Aceita apenas `InfrastructureFailureCode`. Uma violação de regra de
   * negócio pertence a `reject`, e o sistema de tipos impede a troca.
   */
  fail(code: InfrastructureFailureCode): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);

    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return requiresReferenceFor(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Sentido do lançamento produzido por esta operação. `ROLLBACK` inverte o
   * sentido da referência, por isso exige que ela seja fornecida.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        throw new InvalidInputError('LOSS does not produce a ledger entry.');
      case WagerTransactionKind.Rollback:
        if (reference === undefined) {
          throw new InvalidInputError('ROLLBACK needs its reference to determine the direction.');
        }

        return invertDirection(reference.ledgerDirectionFor());
    }
  }

  private assertNotTerminal(target: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot transition from ${this._status} to ${target}.`,
      );
    }
  }
}

/**
 * `OPENING` só existe pelo caminho interno `createOpening`. A verificação de
 * pertinência ao enum protege contra valores vindos de JSON externo, que o
 * sistema de tipos sozinho não impede de chegar aqui.
 */
function assertSubmittableKind(kind: WagerTransactionKind): void {
  if (kind === WagerTransactionKind.Opening) {
    throw new InvalidInputError('OPENING transactions are internal and cannot be submitted.');
  }

  if (!Object.values(WagerTransactionKind).includes(kind)) {
    throw new InvalidInputError('kind is not a known wager transaction kind.');
  }
}

function requiresReferenceFor(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
}

/**
 * Valores submetidos nunca são negativos. Operações que movem saldo exigem
 * valor estritamente positivo, porque um lançamento de zero quebraria a
 * correspondência entre alteração de saldo e ledger. `LOSS` aceita zero por
 * apenas registrar o resultado da rodada.
 */
function assertSubmittedAmount(kind: WagerTransactionKind, money: Money): void {
  if (money.isNegative()) {
    throw new InvalidAmountError('money must not be negative.');
  }

  if (kind !== WagerTransactionKind.Loss && money.isZero()) {
    throw new InvalidAmountError(`${kind} requires a positive amount.`);
  }
}
