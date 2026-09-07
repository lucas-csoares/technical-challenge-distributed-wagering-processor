import type { MoneyProps } from '../../domain/shared/money.js';
import type { LedgerDirection } from '../../domain/wallet/ledger-direction.js';
import { IntegrationEvent, type IntegrationEventProps } from './integration-event.js';

export interface WagerTransactionProcessedData {
  readonly transactionId: string;
  readonly providerId: string | undefined;
  readonly externalTransactionId: string | undefined;
  readonly walletId: string;
  readonly playerId: string;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly balance: MoneyProps;
  readonly referenceTransactionId: string | undefined;
}

/** Toda operação aplicada, inclusive `LOSS`, que não move saldo. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }
}

export interface WagerTransactionRejectedData {
  readonly transactionId: string;
  readonly providerId: string | undefined;
  readonly externalTransactionId: string | undefined;
  readonly walletId: string;
  readonly playerId: string;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly balance: MoneyProps;
  readonly failureCode: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }
}

export interface WagerTransactionPendingReferenceData {
  readonly transactionId: string;
  readonly providerId: string | undefined;
  readonly externalTransactionId: string | undefined;
  readonly walletId: string;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }
}

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
}

/**
 * Emitido somente quando o saldo muda de fato.
 *
 * `LOSS`, rejeições e pendências não produzem este evento: um consumidor que
 * reagisse a ele contabilizaria movimento onde não houve nenhum.
 */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }
}
