import { EntitySchema } from '@mikro-orm/core';
import { MONEY_COLUMN_TYPE, MoneyAmountType } from '../money-amount.type.js';

/**
 * Linha de `wager_transactions`.
 *
 * A identidade externa (`providerId`, `externalTransactionId`,
 * `idempotencyKey`, `payloadHash`, `roundId`, `gameId`) é nula em transações
 * `OPENING`, que são internas e não vêm de provedor algum. A coerência entre
 * `kind` e a presença desses campos é garantida por CHECK na migration.
 */
export class WagerTransactionRecord {
  id!: string;
  providerId!: string | null;
  externalTransactionId!: string | null;
  idempotencyKey!: string | null;
  payloadHash!: string | null;
  walletId!: string;
  playerId!: string;
  roundId!: string | null;
  gameId!: string | null;
  kind!: string;
  status!: string;
  currency!: string;
  amount!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  failureCode!: string | null;
  createdAt!: Date;
  processedAt!: Date | null;
}

export const wagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'string', length: 64, primary: true, fieldName: 'id' },
    providerId: { type: 'string', length: 64, nullable: true, fieldName: 'provider_id' },
    externalTransactionId: {
      type: 'string',
      length: 128,
      nullable: true,
      fieldName: 'external_transaction_id',
    },
    idempotencyKey: { type: 'string', length: 255, nullable: true, fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', length: 128, nullable: true, fieldName: 'payload_hash' },
    walletId: { type: 'string', length: 64, fieldName: 'wallet_id' },
    playerId: { type: 'string', length: 64, fieldName: 'player_id' },
    roundId: { type: 'string', length: 128, nullable: true, fieldName: 'round_id' },
    gameId: { type: 'string', length: 128, nullable: true, fieldName: 'game_id' },
    kind: { type: 'string', length: 16, fieldName: 'kind' },
    status: { type: 'string', length: 24, fieldName: 'status' },
    currency: { type: 'string', columnType: 'char(3)', length: 3, fieldName: 'currency' },
    amount: { type: MoneyAmountType, columnType: MONEY_COLUMN_TYPE, fieldName: 'amount' },
    referenceExternalTransactionId: {
      type: 'string',
      length: 128,
      nullable: true,
      fieldName: 'reference_external_transaction_id',
    },
    referenceTransactionId: {
      type: 'string',
      length: 64,
      nullable: true,
      fieldName: 'reference_transaction_id',
    },
    failureCode: { type: 'string', length: 48, nullable: true, fieldName: 'failure_code' },
    createdAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'created_at' },
    processedAt: {
      type: 'datetime',
      columnType: 'timestamptz',
      nullable: true,
      fieldName: 'processed_at',
    },
  },
});
