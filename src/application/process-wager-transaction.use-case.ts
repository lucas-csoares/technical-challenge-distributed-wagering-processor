import { createHash } from 'node:crypto';
import { CurrencyMismatchError, DomainRuleViolationError, InvalidReferenceError } from '../domain/shared/domain-error.js';
import { FailureCode } from '../domain/shared/failure-code.js';
import { Money, type MoneyProps } from '../domain/shared/money.js';
import { WalletLedgerEntry } from '../domain/wallet/wallet-ledger-entry.js';
import { LedgerDirection } from '../domain/wallet/ledger-direction.js';
import { assertReversalDoesNotOverdraw, assertReversalIsEligible, assertWinReferenceIsEligible } from '../domain/wagering/reference-rules.js';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus, type SubmittableWagerTransactionKind } from '../domain/wagering/wager-transaction.js';
import { ExternalTransactionConflictError, IdempotencyConflictError, WalletNotFoundError } from './financial-errors.js';
import { FinancialTransactionManager, type FinancialTransactionScope } from './ports/financial-transaction-manager.js';
import { isUniqueConstraint } from './ports/persistence-error.js';
import type { UseCaseRuntime } from './create-wallet.use-case.js';
import type { EventContext } from './events/integration-event.js';
import { WagerEventFactory } from './events/wager-event-factory.js';
import {
  defaultPendingReferenceSchedule,
  type PendingReferenceSchedule,
} from './pending-reference-schedule.js';

export interface ProcessWagerTransactionCommand { readonly providerId: string; readonly externalTransactionId: string; readonly idempotencyKey: string; readonly walletId: string; readonly playerId: string; readonly roundId: string; readonly gameId: string; readonly kind: SubmittableWagerTransactionKind; readonly money: MoneyProps; readonly referenceExternalTransactionId?: string; }
export interface ProcessWagerTransactionResult { readonly transactionId: string; readonly status: WagerTransactionStatus; readonly balance: MoneyProps; readonly failureCode?: string; readonly idempotentReplay: boolean; }

export class ProcessWagerTransactionUseCase {
  private readonly events: WagerEventFactory;

  constructor(
    private readonly transactions: FinancialTransactionManager,
    private readonly runtime: UseCaseRuntime = {},
    private readonly pendingReference: PendingReferenceSchedule = defaultPendingReferenceSchedule,
  ) {
    this.events = new WagerEventFactory(() => this.id(), () => this.now());
  }

  /**
   * `context` identifica a origem lógica da operação. Quando não é informado,
   * a própria operação vira sua correlação — suficiente para rastrear, e sem
   * inventar um contexto global compartilhado entre requisições.
   */
  async execute(
    command: ProcessWagerTransactionCommand,
    context?: EventContext,
  ): Promise<ProcessWagerTransactionResult> {
    const money = Money.from(command.money); const hash = hashWagerCommand(command);
    const eventContext: EventContext = context ?? {
      correlationId: `${command.providerId}:${command.idempotencyKey}`,
    };
    try {
      return await this.transactions.execute((scope) => this.process(scope, command, money, hash, eventContext));
    } catch (error) {
      if (isUniqueConstraint(error, 'wager_transactions_idempotency_key_unique')) {
        return this.transactions.execute(async scope => {
          const winner = await scope.transactions.findByProviderAndIdempotencyKey(command.providerId, command.idempotencyKey);
          if (winner === undefined) throw error;
          return this.replay(winner, hash);
        });
      }
      if (isUniqueConstraint(error, 'wager_transactions_provider_external_unique')) throw new ExternalTransactionConflictError();
      if (isUniqueConstraint(error, 'wager_transactions_processed_reversal_unique')) {
        return this.transactions.execute(scope => this.persistDuplicateReversal(scope, command, money, hash, eventContext));
      }
      throw error;
    }
  }
  /**
   * Executa dentro de uma transação já aberta por quem chama.
   *
   * É o que permite ao consumidor SQS gravar Inbox, efeito financeiro,
   * lançamento e Outbox na mesma transação. Aqui não há a recuperação de
   * corridas de unicidade que `execute` faz abrindo um novo escopo: dentro de
   * uma transação, uma violação de unicidade a invalida por inteiro. Quem
   * chama deve deixar o erro propagar, reverter tudo e reprocessar — no
   * consumidor, isso é simplesmente não dar `ACK` e aguardar a reentrega.
   */
  async executeInScope(
    scope: FinancialTransactionScope,
    command: ProcessWagerTransactionCommand,
    context: EventContext,
  ): Promise<ProcessWagerTransactionResult> {
    return this.process(scope, command, Money.from(command.money), hashWagerCommand(command), context);
  }

  private async persistDuplicateReversal(scope: FinancialTransactionScope, command: ProcessWagerTransactionCommand, money: Money, hash: string, context: EventContext): Promise<ProcessWagerTransactionResult> {
    const wallet = await scope.wallets.findByIdForUpdate(command.walletId);
    if (wallet === undefined) throw new WalletNotFoundError();
    const transaction = WagerTransaction.create({ id: this.id(), ...command, money, payloadHash: hash, createdAt: this.now() });
    return this.reject(scope, transaction, wallet.balance, new InvalidReferenceError('The reference was already reversed.', FailureCode.ReferenceAlreadyReversed), context);
  }
  private async process(scope: FinancialTransactionScope, command: ProcessWagerTransactionCommand, money: Money, hash: string, context: EventContext): Promise<ProcessWagerTransactionResult> {
    const replay = await scope.transactions.findByProviderAndIdempotencyKey(command.providerId, command.idempotencyKey);
    if (replay) return this.replay(replay, hash);
    const external = await scope.transactions.findByProviderAndExternalTransactionId(command.providerId, command.externalTransactionId);
    if (external) {
      const idempotent = await scope.transactions.findByProviderAndIdempotencyKey(command.providerId, command.idempotencyKey);
      if (idempotent) return this.replay(idempotent, hash);
      throw new ExternalTransactionConflictError();
    }
    const wallet = await scope.wallets.findByIdForUpdate(command.walletId);
    if (!wallet) throw new WalletNotFoundError();
    const afterLock = await scope.transactions.findByProviderAndIdempotencyKey(command.providerId, command.idempotencyKey);
    if (afterLock) return this.replay(afterLock, hash);
    const transaction = WagerTransaction.create({ id: this.id(), ...command, money, payloadHash: hash, createdAt: this.now() });
    if (wallet.playerId !== command.playerId) return this.reject(scope, transaction, wallet.balance, new InvalidReferenceError('Wallet belongs to another player.', FailureCode.ReferenceMismatch), context);
    if (wallet.currency !== money.currency) return this.reject(scope, transaction, wallet.balance, new CurrencyMismatchError(wallet.currency, money.currency), context);
    try {
      let reference: WagerTransaction | undefined;
      if (command.referenceExternalTransactionId) {
        reference = await scope.transactions.findByProviderAndExternalTransactionId(command.providerId, command.referenceExternalTransactionId);
        if (!reference) {
          transaction.markPendingReference();
          transaction.recordResultBalance(wallet.balance);
          transaction.scheduleReferenceRetry(0, this.pendingReference.firstAttemptAt(this.now()));
          await scope.transactions.save(transaction);
          await scope.outbox.append(this.events.pendingReference(transaction, context));
          return this.result(transaction, false);
        }
        if (transaction.kind === WagerTransactionKind.Win) assertWinReferenceIsEligible(transaction, reference);
        if (transaction.kind === WagerTransactionKind.Refund || transaction.kind === WagerTransactionKind.Rollback) {
          assertReversalIsEligible(transaction, reference, { referenceAlreadyReversedBySameKind: await scope.transactions.hasProcessedReversalForReference(reference.id, transaction.kind) });
        }
      }
      // `LOSS` registra o resultado da rodada sem mover saldo: gera o evento de
      // processamento, mas nenhum WalletBalanceChanged e nenhum lançamento.
      if (transaction.kind === WagerTransactionKind.Loss) {
        transaction.markProcessed(undefined, this.now());
        transaction.recordResultBalance(wallet.balance);
        await scope.transactions.save(transaction);
        await scope.outbox.append(
          this.events.processed(transaction, wallet.balance.toString(), wallet.currency, context),
        );
        return this.result(transaction, false);
      }

      const direction = transaction.ledgerDirectionFor(reference);
      if (transaction.kind === WagerTransactionKind.Rollback && direction === LedgerDirection.Debit) assertReversalDoesNotOverdraw(wallet, money);
      const movement = direction === LedgerDirection.Debit ? wallet.debit(money, this.now()) : wallet.credit(money, this.now());
      transaction.markProcessed(reference?.id, this.now()); transaction.recordResultBalance(wallet.balance);
      await scope.transactions.save(transaction); await scope.wallets.save(wallet);
      await scope.ledger.append(WalletLedgerEntry.create({ id: this.id(), transactionId: transaction.id, createdAt: this.now(), ...movement }));
      await scope.outbox.append(
        this.events.processed(transaction, wallet.balance.toString(), wallet.currency, context),
      );
      await scope.outbox.append(this.events.balanceChanged(wallet, transaction, movement, context));
      return this.result(transaction, false);
    } catch (error) {
      if (error instanceof DomainRuleViolationError) return this.reject(scope, transaction, wallet.balance, error, context);
      throw error;
    }
  }
  private async reject(
    scope: FinancialTransactionScope,
    tx: WagerTransaction,
    balance: Money,
    error: DomainRuleViolationError,
    context: EventContext,
  ): Promise<ProcessWagerTransactionResult> {
    tx.reject(error.failureCode);
    tx.recordResultBalance(balance);
    await scope.transactions.save(tx);
    await scope.outbox.append(this.events.rejected(tx, balance.toString(), balance.currency, context));

    return this.result(tx, false);
  }
  private replay(tx: WagerTransaction, hash: string): ProcessWagerTransactionResult { if (!tx.matchesPayload(hash)) throw new IdempotencyConflictError(); return this.result(tx, true); }
  private result(tx: WagerTransaction, idempotentReplay: boolean): ProcessWagerTransactionResult { if (!tx.resultBalance) throw new Error('Persisted transaction lacks result balance.'); return { transactionId: tx.id, status: tx.status, balance: tx.resultBalance.toJSON(), failureCode: tx.failureCode, idempotentReplay }; }
  private now = (): Date => (this.runtime.now ?? (() => new Date()))();
  private id = (): string => (this.runtime.newId ?? (() => crypto.randomUUID()))();
}

export function canonicalizeWagerCommand(c: ProcessWagerTransactionCommand): string {
  return JSON.stringify({ externalTransactionId: c.externalTransactionId, gameId: c.gameId, kind: c.kind, money: { amount: c.money.amount, currency: c.money.currency }, playerId: c.playerId, providerId: c.providerId, referenceExternalTransactionId: c.referenceExternalTransactionId ?? null, roundId: c.roundId, walletId: c.walletId });
}

export function hashWagerCommand(c: ProcessWagerTransactionCommand): string {
  const json = canonicalizeWagerCommand(c);
  return createHash('sha256').update(json).digest('hex');
}
