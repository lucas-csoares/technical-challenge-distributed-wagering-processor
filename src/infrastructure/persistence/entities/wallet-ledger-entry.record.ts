import { EntitySchema } from '@mikro-orm/core';
import { MONEY_COLUMN_TYPE, MoneyAmountType } from '../money-amount.type.js';

/**
 * Linha de `wallet_ledger_entries`.
 *
 * A tabela é append-only: não há caminho de atualização ou exclusão nem aqui
 * nem no PostgreSQL, onde triggers rejeitam `UPDATE` e `DELETE`.
 */
export class WalletLedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  currency!: string;
  amount!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const walletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRecord>({
  class: WalletLedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'string', length: 64, primary: true, fieldName: 'id' },
    walletId: { type: 'string', length: 64, fieldName: 'wallet_id' },
    transactionId: { type: 'string', length: 64, fieldName: 'transaction_id' },
    direction: { type: 'string', length: 8, fieldName: 'direction' },
    currency: { type: 'string', columnType: 'char(3)', length: 3, fieldName: 'currency' },
    amount: { type: MoneyAmountType, columnType: MONEY_COLUMN_TYPE, fieldName: 'amount' },
    balanceBefore: {
      type: MoneyAmountType,
      columnType: MONEY_COLUMN_TYPE,
      fieldName: 'balance_before',
    },
    balanceAfter: {
      type: MoneyAmountType,
      columnType: MONEY_COLUMN_TYPE,
      fieldName: 'balance_after',
    },
    createdAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'created_at' },
  },
});
