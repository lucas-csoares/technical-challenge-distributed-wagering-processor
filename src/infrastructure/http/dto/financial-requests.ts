import type { CreateWalletCommand } from '../../../application/create-wallet.use-case.js';
import type { ProcessWagerTransactionCommand } from '../../../application/process-wager-transaction.use-case.js';
import {
  WagerTransactionKind,
  type SubmittableWagerTransactionKind,
} from '../../../domain/wagering/wager-transaction.js';
import {
  asBody,
  InvalidRequestError,
  optionalString,
  rejectUnknownFields,
  requireEnum,
  requireMoney,
  requireString,
} from './request-parsing.js';

/** `OPENING` é interna e nunca aceita pela API; ver ARCHITECTURE.md. */
const SUBMITTABLE_KINDS: readonly SubmittableWagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

const CREATE_WALLET_FIELDS = ['playerId', 'initialBalance'] as const;

const WAGER_FIELDS = [
  'providerId',
  'externalTransactionId',
  'playerId',
  'walletId',
  'roundId',
  'gameId',
  'kind',
  'money',
  'referenceExternalTransactionId',
] as const;

export function parseCreateWalletRequest(payload: unknown): CreateWalletCommand {
  const body = asBody(payload);
  rejectUnknownFields(body, CREATE_WALLET_FIELDS);

  return {
    playerId: requireString(body, 'playerId'),
    initialBalance: requireMoney(body, 'initialBalance'),
  };
}

/**
 * A chave de idempotência vem do header e é obrigatória: o serviço não a
 * deriva de outros campos, sob pena de assumir uma decisão de identidade que é
 * do provedor. Ver *Idempotência* em ARCHITECTURE.md.
 */
export function parseWagerTransactionRequest(
  payload: unknown,
  idempotencyKey: unknown,
): ProcessWagerTransactionCommand {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    throw new InvalidRequestError('The Idempotency-Key header is required.');
  }

  const body = asBody(payload);
  rejectUnknownFields(body, WAGER_FIELDS);

  return {
    providerId: requireString(body, 'providerId'),
    externalTransactionId: requireString(body, 'externalTransactionId'),
    idempotencyKey,
    playerId: requireString(body, 'playerId'),
    walletId: requireString(body, 'walletId'),
    roundId: requireString(body, 'roundId'),
    gameId: requireString(body, 'gameId'),
    kind: requireEnum(body, 'kind', SUBMITTABLE_KINDS),
    money: requireMoney(body, 'money'),
    referenceExternalTransactionId: optionalString(body, 'referenceExternalTransactionId'),
  };
}
