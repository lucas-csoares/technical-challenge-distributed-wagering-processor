import { FailureCode } from '../domain/shared/failure-code.js';
import { InvalidReferenceError } from '../domain/shared/domain-error.js';
import { WalletLedgerEntry } from '../domain/wallet/wallet-ledger-entry.js';
import { LedgerDirection } from '../domain/wallet/ledger-direction.js';
import {
  assertReversalDoesNotOverdraw,
  assertReversalIsEligible,
  assertWinReferenceIsEligible,
} from '../domain/wagering/reference-rules.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransaction,
} from '../domain/wagering/wager-transaction.js';
import { DomainRuleViolationError } from '../domain/shared/domain-error.js';
import { WagerEventFactory } from './events/wager-event-factory.js';
import type { EventContext } from './events/integration-event.js';
import {
  defaultPendingReferenceSchedule,
  type PendingReferenceSchedule,
} from './pending-reference-schedule.js';
import {
  FinancialTransactionManager,
  type FinancialTransactionScope,
} from './ports/financial-transaction-manager.js';
import { noopMetrics, type MetricsPort } from './ports/metrics.js';
import type { UseCaseRuntime } from './create-wallet.use-case.js';

export interface PendingReferenceReport {
  readonly examined: number;
  readonly resolved: number;
  readonly rejected: number;
  readonly rescheduled: number;
}

/**
 * Reavalia transações em `PENDING_REFERENCE`.
 *
 * A seleção usa `SKIP LOCKED` e cada pendência é reavaliada em sua própria
 * transação, com a wallet sob lock pessimista. Duas instâncias do worker
 * podem rodar ao mesmo tempo: elas pegam pendências disjuntas, e mesmo que
 * disputassem a mesma linha a segunda encontraria um estado já terminal e não
 * aplicaria nada. A garantia final continua no PostgreSQL, não em coordenação
 * entre workers.
 *
 * As regras de elegibilidade são as mesmas do processamento normal — as
 * funções de `reference-rules` são reutilizadas, não reescritas.
 */
export class ResolvePendingReferencesUseCase {
  private readonly events: WagerEventFactory;

  constructor(
    private readonly transactions: FinancialTransactionManager,
    private readonly runtime: UseCaseRuntime = {},
    private readonly schedule: PendingReferenceSchedule = defaultPendingReferenceSchedule,
    private readonly metrics: MetricsPort = noopMetrics,
  ) {
    this.events = new WagerEventFactory(() => this.id(), () => this.now());
  }

  async execute(batchSize = 20): Promise<PendingReferenceReport> {
    const due = await this.transactions.execute((scope) =>
      scope.transactions.claimDuePendingReferences(batchSize, this.now()),
    );

    let resolved = 0;
    let rejected = 0;
    let rescheduled = 0;

    for (const pendingId of due) {
      const outcome = await this.transactions.execute((scope) => this.resolveOne(scope, pendingId));

      if (outcome === 'resolved') {
        resolved += 1;
        this.metrics.recordWagerTransaction(
          WagerTransactionStatus.Processed,
          'pending_reference_worker',
        );
      }

      if (outcome === 'rejected') {
        rejected += 1;
        this.metrics.recordWagerTransaction(
          WagerTransactionStatus.Rejected,
          'pending_reference_worker',
        );
      }

      if (outcome === 'rescheduled') {
        rescheduled += 1;
        this.metrics.recordRetry('pending_reference');
      }
    }

    return { examined: due.length, resolved, rejected, rescheduled };
  }

  private async resolveOne(
    scope: FinancialTransactionScope,
    transactionId: string,
  ): Promise<'resolved' | 'rejected' | 'rescheduled' | 'skipped'> {
    // Releitura sob lock: a reserva do lote é só uma dica, porque o lock dela
    // acabou junto da transação que a fez. Se outro worker já resolveu esta
    // pendência, o status relido não é mais `PENDING_REFERENCE` e nada é
    // aplicado duas vezes.
    const transaction = await scope.transactions.findByIdForUpdate(transactionId);

    if (transaction === undefined || !transaction.isPendingReference()) {
      return 'skipped';
    }

    const providerId = transaction.providerId;
    const externalReference = transaction.referenceExternalTransactionId;

    if (providerId === undefined || externalReference === undefined) {
      return 'skipped';
    }

    const context: EventContext = {
      correlationId: `${providerId}:${transaction.idempotencyKey ?? transaction.id}`,
      causationId: transaction.id,
    };
    const reference = await scope.transactions.findByProviderAndExternalTransactionId(
      providerId,
      externalReference,
    );

    if (reference === undefined) {
      return this.scheduleOrExpire(scope, transaction, context);
    }

    return this.applyResolved(scope, transaction, reference, context);
  }

  /** Referência ainda ausente: adia, ou desiste com código estável. */
  private async scheduleOrExpire(
    scope: FinancialTransactionScope,
    transaction: WagerTransaction,
    context: EventContext,
  ): Promise<'rejected' | 'rescheduled'> {
    const attempts = transaction.referenceAttempts + 1;
    const nextAttemptAt = this.schedule.nextAttemptAt(attempts, this.now());

    if (nextAttemptAt === undefined) {
      return this.rejectPending(
        scope,
        transaction,
        new InvalidReferenceError(
          'The referenced transaction never arrived.',
          FailureCode.ReferenceNotFound,
        ),
        context,
      );
    }

    transaction.scheduleReferenceRetry(attempts, nextAttemptAt);
    await scope.transactions.save(transaction);

    return 'rescheduled';
  }

  private async applyResolved(
    scope: FinancialTransactionScope,
    transaction: WagerTransaction,
    reference: WagerTransaction,
    context: EventContext,
  ): Promise<'resolved' | 'rejected'> {
    const wallet = await scope.wallets.findByIdForUpdate(transaction.walletId);

    if (wallet === undefined) {
      return 'rejected';
    }

    try {
      if (transaction.kind === WagerTransactionKind.Win) {
        assertWinReferenceIsEligible(transaction, reference);
      }

      if (
        transaction.kind === WagerTransactionKind.Refund ||
        transaction.kind === WagerTransactionKind.Rollback
      ) {
        assertReversalIsEligible(transaction, reference, {
          referenceAlreadyReversedBySameKind:
            await scope.transactions.hasProcessedReversalForReference(
              reference.id,
              transaction.kind,
            ),
        });
      }

      const direction = transaction.ledgerDirectionFor(reference);

      if (transaction.kind === WagerTransactionKind.Rollback && direction === LedgerDirection.Debit) {
        assertReversalDoesNotOverdraw(wallet, transaction.money);
      }

      const movement =
        direction === LedgerDirection.Debit
          ? wallet.debit(transaction.money, this.now())
          : wallet.credit(transaction.money, this.now());

      transaction.markProcessed(reference.id, this.now());
      transaction.recordResultBalance(wallet.balance);
      transaction.clearReferenceRetry();

      await scope.transactions.save(transaction);
      await scope.wallets.save(wallet);
      await scope.ledger.append(
        WalletLedgerEntry.create({
          ...movement,
          id: this.id(),
          transactionId: transaction.id,
          createdAt: this.now(),
        }),
      );
      await scope.outbox.append(
        this.events.processed(transaction, wallet.balance.toString(), wallet.currency, context),
      );
      await scope.outbox.append(
        this.events.balanceChanged(wallet, transaction, movement, context),
      );

      return 'resolved';
    } catch (error) {
      if (error instanceof DomainRuleViolationError) {
        return this.rejectPending(scope, transaction, error, context);
      }

      throw error;
    }
  }

  private async rejectPending(
    scope: FinancialTransactionScope,
    transaction: WagerTransaction,
    error: DomainRuleViolationError,
    context: EventContext,
  ): Promise<'rejected'> {
    const balance = transaction.resultBalance;

    transaction.reject(error.failureCode);
    transaction.clearReferenceRetry();
    await scope.transactions.save(transaction);
    await scope.outbox.append(
      this.events.rejected(
        transaction,
        balance?.toString() ?? '0.00',
        balance?.currency ?? transaction.money.currency,
        context,
      ),
    );

    return 'rejected';
  }

  private now = (): Date => (this.runtime.now ?? (() => new Date()))();
  private id = (): string => (this.runtime.newId ?? (() => crypto.randomUUID()))();
}
