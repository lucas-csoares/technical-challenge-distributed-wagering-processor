import { Migration } from '@mikro-orm/migrations';

/** `result_balance` pode representar o saldo da wallet após rejeição por moeda. */
export class Migration20260906220000 extends Migration {
  override up(): void {
    const schema = `"${this.config.get('schema') ?? 'public'}"`;
    this.addSql(`alter table ${schema}.wager_transactions add column result_currency char(3)`);
    this.addSql(`update ${schema}.wager_transactions set result_currency = currency where result_balance is not null`);
    this.addSql(`alter table ${schema}.wager_transactions add constraint wager_transactions_result_currency_check check ((result_balance is null and result_currency is null) or (result_balance is not null and result_currency ~ '^[A-Z]{3}$'))`);
  }
  override down(): void {
    const schema = `"${this.config.get('schema') ?? 'public'}"`;
    this.addSql(`alter table ${schema}.wager_transactions drop constraint if exists wager_transactions_result_currency_check`);
    this.addSql(`alter table ${schema}.wager_transactions drop column if exists result_currency`);
  }
}
