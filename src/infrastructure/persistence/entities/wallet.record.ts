import { EntitySchema } from '@mikro-orm/core';
import { MONEY_COLUMN_TYPE, MoneyAmountType } from '../money-amount.type.js';

/**
 * Linha de `wallets`.
 *
 * O record representa armazenamento, não regra de negócio: os campos são
 * escalares, `balance` trafega como string decimal e as chaves estrangeiras
 * são colunas simples. As invariantes ficam com o domínio e com as constraints
 * da migration — nenhuma delas é reimplementada aqui.
 */
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const walletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'string', length: 64, primary: true, fieldName: 'id' },
    playerId: { type: 'string', length: 64, fieldName: 'player_id' },
    currency: { type: 'string', columnType: 'char(3)', length: 3, fieldName: 'currency' },
    balance: { type: MoneyAmountType, columnType: MONEY_COLUMN_TYPE, fieldName: 'balance' },
    version: { type: 'integer', fieldName: 'version' },
    createdAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'created_at' },
    updatedAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'updated_at' },
  },
});
