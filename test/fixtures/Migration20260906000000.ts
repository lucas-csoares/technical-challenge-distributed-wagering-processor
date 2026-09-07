import { Migration } from '@mikro-orm/migrations';

export class Migration20260906000000 extends Migration {
  override up(): void {
    const schema = this.config.get('schema');
    this.addSql(`create table "${schema}".persistence_probe (id text primary key, value text not null)`);
  }

  override down(): void {
    const schema = this.config.get('schema');
    this.addSql(`drop table "${schema}".persistence_probe`);
  }
}
