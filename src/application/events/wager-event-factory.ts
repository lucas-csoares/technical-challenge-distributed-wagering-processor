import type { WalletMovement } from '../../domain/wallet/wallet.js';
import type { Wallet } from '../../domain/wallet/wallet.js';
import { WagerTransaction } from '../../domain/wagering/wager-transaction.js';
import type { EventContext, IntegrationEvent } from './integration-event.js';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from './wagering-events.js';

/**
 * Constrói os eventos de uma operação a partir do estado já decidido.
 *
 * Os eventos nascem aqui, na camada de aplicação, e não em cada transporte:
 * HTTP e SQS produzem exatamente a mesma Outbox porque nenhum dos dois escolhe
 * o que emitir. `newId` é injetado para que o `eventId` seja determinístico em
 * teste sem deixar de ser estável em produção.
 */
export class WagerEventFactory {
  constructor(
    private readonly newId: () => string,
    private readonly now: () => Date,
  ) {}

  processed(
    transaction: WagerTransaction,
    balance: string,
    currency: string,
    context: EventContext,
  ): IntegrationEvent<unknown> {
    return new WagerTransactionProcessed({
      ...this.envelope(transaction.id, context),
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        balance: { amount: balance, currency },
        referenceTransactionId: transaction.referenceTransactionId,
      },
    });
  }

  rejected(
    transaction: WagerTransaction,
    balance: string,
    currency: string,
    context: EventContext,
  ): IntegrationEvent<unknown> {
    return new WagerTransactionRejected({
      ...this.envelope(transaction.id, context),
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        balance: { amount: balance, currency },
        failureCode: transaction.failureCode ?? 'UNKNOWN',
      },
    });
  }

  pendingReference(
    transaction: WagerTransaction,
    context: EventContext,
  ): IntegrationEvent<unknown> {
    return new WagerTransactionPendingReference({
      ...this.envelope(transaction.id, context),
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? '',
      },
    });
  }

  /** Só existe quando houve movimentação: `LOSS` e rejeições não passam por aqui. */
  balanceChanged(
    wallet: Wallet,
    transaction: WagerTransaction,
    movement: WalletMovement,
    context: EventContext,
  ): IntegrationEvent<unknown> {
    return new WalletBalanceChanged({
      ...this.envelope(wallet.id, context),
      data: {
        walletId: wallet.id,
        transactionId: transaction.id,
        direction: movement.direction,
        money: movement.money.toJSON(),
        balanceBefore: movement.balanceBefore.toJSON(),
        balanceAfter: movement.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }

  private envelope(aggregateId: string, context: EventContext) {
    return {
      eventId: this.newId(),
      aggregateId,
      correlationId: context.correlationId,
      ...(context.causationId === undefined ? {} : { causationId: context.causationId }),
      occurredAt: this.now(),
    };
  }
}
