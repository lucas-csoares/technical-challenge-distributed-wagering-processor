import type { PersistedFailureCode } from '../../../domain/shared/failure-code.js';
import { Money } from '../../../domain/shared/money.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wagering/wager-transaction.js';
import { WagerTransactionRecord } from '../entities/wager-transaction.record.js';
import { toNull, toUndefined } from './nullable.js';

export function toWagerTransactionRecord(
  transaction: WagerTransaction,
  record = new WagerTransactionRecord(),
): WagerTransactionRecord {
  record.id = transaction.id;
  record.providerId = toNull(transaction.providerId);
  record.externalTransactionId = toNull(transaction.externalTransactionId);
  record.idempotencyKey = toNull(transaction.idempotencyKey);
  record.payloadHash = toNull(transaction.payloadHash);
  record.walletId = transaction.walletId;
  record.playerId = transaction.playerId;
  record.roundId = toNull(transaction.roundId);
  record.gameId = toNull(transaction.gameId);
  record.kind = transaction.kind;
  record.status = transaction.status;
  record.currency = transaction.money.currency;
  record.amount = transaction.money.toString();
  record.referenceExternalTransactionId = toNull(transaction.referenceExternalTransactionId);
  record.referenceTransactionId = toNull(transaction.referenceTransactionId);
  record.failureCode = toNull(transaction.failureCode);
  record.createdAt = transaction.createdAt;
  record.processedAt = toNull(transaction.processedAt);
  record.resultBalance = transaction.resultBalance === undefined ? null : transaction.resultBalance.toString();
  record.resultCurrency = transaction.resultBalance === undefined ? null : transaction.resultBalance.currency;
  record.referenceAttempts = transaction.referenceAttempts;
  record.nextReferenceAttemptAt = toNull(transaction.nextReferenceAttemptAt);

  return record;
}

/** Reconstrói a transação sem revalidar criação nem repetir transições. */
export function toWagerTransaction(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: toUndefined(record.providerId),
    externalTransactionId: toUndefined(record.externalTransactionId),
    idempotencyKey: toUndefined(record.idempotencyKey),
    payloadHash: toUndefined(record.payloadHash),
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: toUndefined(record.roundId),
    gameId: toUndefined(record.gameId),
    kind: record.kind as WagerTransactionKind,
    money: Money.from({ amount: record.amount, currency: record.currency }),
    referenceExternalTransactionId: toUndefined(record.referenceExternalTransactionId),
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: toUndefined(record.referenceTransactionId),
    failureCode: toUndefined(record.failureCode) as PersistedFailureCode | undefined,
    processedAt: toUndefined(record.processedAt),
    resultBalance: record.resultBalance === null ? undefined : Money.from({ amount: record.resultBalance, currency: record.resultCurrency ?? record.currency }),
    referenceAttempts: record.referenceAttempts,
    nextReferenceAttemptAt: toUndefined(record.nextReferenceAttemptAt),
  });
}
