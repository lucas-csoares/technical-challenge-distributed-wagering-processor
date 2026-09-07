import { Migration } from '@mikro-orm/migrations';

/**
 * Guarda o saldo observado pela resposta original e fecha duas lacunas de
 * concorrência: WIN com referência ainda ausente e reversão duplicada.
 */
export class Migration20260906210000 extends Migration {
  override up(): void {
    const schema = this.targetSchema();
    this.addSql(`alter table ${schema}.wager_transactions add column result_balance numeric(20,2)`);
    // A transação rejeitada preserva a moeda recebida para auditoria; o ledger
    // continua ligado à wallet também pela moeda, pois só ele move saldo.
    this.addSql(`alter table ${schema}.wager_transactions drop constraint wager_transactions_wallet_fkey`);
    this.addSql(`alter table ${schema}.wager_transactions add constraint wager_transactions_wallet_fkey foreign key (wallet_id) references ${schema}.wallets (id) on update restrict on delete restrict`);
    this.addSql(`alter table ${schema}.wager_transactions add constraint wager_transactions_result_balance_check check (result_balance is null or result_balance >= 0)`);
    this.addSql(`alter table ${schema}.wager_transactions drop constraint wager_transactions_pending_reference_check`);
    this.addSql(`alter table ${schema}.wager_transactions add constraint wager_transactions_pending_reference_check check (status <> 'PENDING_REFERENCE' or kind in ('WIN', 'REFUND', 'ROLLBACK'))`);
    this.addSql(`create unique index wager_transactions_processed_reversal_unique on ${schema}.wager_transactions (reference_transaction_id, kind) where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK') and reference_transaction_id is not null`);
  }

  override down(): void {
    const schema = this.targetSchema();
    this.addSql(`drop index if exists ${schema}.wager_transactions_processed_reversal_unique`);
    this.addSql(`alter table ${schema}.wager_transactions drop constraint if exists wager_transactions_pending_reference_check`);
    this.addSql(`alter table ${schema}.wager_transactions add constraint wager_transactions_pending_reference_check check (status <> 'PENDING_REFERENCE' or kind in ('REFUND', 'ROLLBACK'))`);
    this.addSql(`alter table ${schema}.wager_transactions drop constraint if exists wager_transactions_result_balance_check`);
    this.addSql(`alter table ${schema}.wager_transactions drop column if exists result_balance`);
    this.addSql(`alter table ${schema}.wager_transactions drop constraint if exists wager_transactions_wallet_fkey`);
    this.addSql(`alter table ${schema}.wager_transactions add constraint wager_transactions_wallet_fkey foreign key (wallet_id, currency) references ${schema}.wallets (id, currency) on update restrict on delete restrict`);
  }

  private targetSchema(): string { return `"${this.config.get('schema') ?? 'public'}"`; }
}
