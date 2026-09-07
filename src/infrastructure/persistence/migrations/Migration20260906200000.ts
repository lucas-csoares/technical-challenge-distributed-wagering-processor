import { Migration } from '@mikro-orm/migrations';

/**
 * Schema financeiro: wallets, transações de wagering e ledger.
 *
 * As listas de `kind`, `status` e `failure_code` são literais nesta migration
 * em vez de derivadas dos enums do domínio. Uma migration é um registro
 * histórico do schema em um ponto no tempo: se ela lesse o enum atual, aplicar
 * a mesma versão em dois momentos produziria bancos diferentes. Ampliar
 * qualquer uma dessas listas exige uma nova migration — e um teste de
 * integração compara os enums com as constraints reais para que a divergência
 * apareça como falha, não como surpresa em produção.
 *
 * Os testes de `failure_code` são explícitos sobre `is not null` porque um
 * CHECK só rejeita `FALSE`: `null in (...)` avalia para `NULL` e passaria,
 * deixando entrar um `REJECTED` sem motivo registrado.
 */
export class Migration20260906200000 extends Migration {
  override up(): void {
    const schema = this.targetSchema();

    this.addSql(`
      create table ${schema}.wallets (
        id varchar(64) not null,
        player_id varchar(64) not null,
        currency char(3) not null,
        balance numeric(20,2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_pkey primary key (id),
        constraint wallets_currency_format_check check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_not_negative_check check (balance >= 0),
        constraint wallets_version_check check (version >= 1),
        constraint wallets_player_currency_unique unique (player_id, currency),
        constraint wallets_id_currency_unique unique (id, currency)
      )
    `);

    this.addSql(`
      create table ${schema}.wager_transactions (
        id varchar(64) not null,
        provider_id varchar(64),
        external_transaction_id varchar(128),
        idempotency_key varchar(255),
        payload_hash varchar(128),
        wallet_id varchar(64) not null,
        player_id varchar(64) not null,
        round_id varchar(128),
        game_id varchar(128),
        kind varchar(16) not null,
        status varchar(24) not null,
        currency char(3) not null,
        amount numeric(20,2) not null,
        reference_external_transaction_id varchar(128),
        reference_transaction_id varchar(64),
        failure_code varchar(48),
        created_at timestamptz not null,
        processed_at timestamptz,
        constraint wager_transactions_pkey primary key (id),
        constraint wager_transactions_id_wallet_unique unique (id, wallet_id),
        constraint wager_transactions_kind_check
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_transactions_status_check
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_currency_format_check check (currency ~ '^[A-Z]{3}$'),
        constraint wager_transactions_amount_check
          check (case when kind = 'LOSS' then amount >= 0 else amount > 0 end),
        constraint wager_transactions_internal_identity_check check (
          (kind = 'OPENING') = (provider_id is null)
          and (provider_id is null) = (external_transaction_id is null)
          and (provider_id is null) = (idempotency_key is null)
          and (provider_id is null) = (payload_hash is null)
          and (provider_id is null) = (round_id is null)
          and (provider_id is null) = (game_id is null)
        ),
        constraint wager_transactions_external_reference_check check (
          case
            when kind in ('REFUND', 'ROLLBACK') then reference_external_transaction_id is not null
            when kind in ('OPENING', 'BET', 'LOSS') then reference_external_transaction_id is null
            else true
          end
        ),
        constraint wager_transactions_pending_reference_check
          check (status <> 'PENDING_REFERENCE' or kind in ('REFUND', 'ROLLBACK')),
        constraint wager_transactions_processed_at_check
          check ((processed_at is not null) = (status = 'PROCESSED')),
        constraint wager_transactions_internal_reference_check check (
          (reference_transaction_id is not null)
          = (status = 'PROCESSED' and reference_external_transaction_id is not null)
        ),
        constraint wager_transactions_no_self_reference_check
          check (reference_transaction_id is null or reference_transaction_id <> id),
        constraint wager_transactions_failure_code_check check (
          case status
            when 'REJECTED' then failure_code is not null and failure_code in (
              'INSUFFICIENT_FUNDS',
              'REVERSAL_WOULD_OVERDRAW',
              'CURRENCY_MISMATCH',
              'INVALID_AMOUNT',
              'REFERENCE_REQUIRED',
              'REFERENCE_NOT_SUPPORTED',
              'REFERENCE_KIND_NOT_ELIGIBLE',
              'REFERENCE_NOT_PROCESSED',
              'REFERENCE_MISMATCH',
              'REFERENCE_AMOUNT_MISMATCH',
              'REFERENCE_ALREADY_REVERSED'
            )
            when 'FAILED' then failure_code is not null
              and failure_code in ('PERMANENT_INFRASTRUCTURE_FAILURE')
            else failure_code is null
          end
        ),
        constraint wager_transactions_wallet_fkey
          foreign key (wallet_id, currency) references ${schema}.wallets (id, currency)
          on update restrict on delete restrict,
        constraint wager_transactions_reference_fkey
          foreign key (reference_transaction_id) references ${schema}.wager_transactions (id)
          on update restrict on delete restrict
      )
    `);

    this.addSql(`
      create unique index wager_transactions_provider_external_unique
        on ${schema}.wager_transactions (provider_id, external_transaction_id)
    `);
    this.addSql(`
      create unique index wager_transactions_idempotency_key_unique
        on ${schema}.wager_transactions (provider_id, idempotency_key)
        where idempotency_key is not null
    `);
    this.addSql(`
      create unique index wager_transactions_opening_per_wallet_unique
        on ${schema}.wager_transactions (wallet_id) where kind = 'OPENING'
    `);
    this.addSql(`
      create index wager_transactions_wallet_created_idx
        on ${schema}.wager_transactions (wallet_id, created_at)
    `);
    this.addSql(`
      create index wager_transactions_reference_idx
        on ${schema}.wager_transactions (reference_transaction_id)
        where reference_transaction_id is not null
    `);
    this.addSql(`
      create index wager_transactions_pending_reference_idx
        on ${schema}.wager_transactions (created_at) where status = 'PENDING_REFERENCE'
    `);

    this.addSql(`
      create table ${schema}.wallet_ledger_entries (
        id varchar(64) not null,
        wallet_id varchar(64) not null,
        transaction_id varchar(64) not null,
        direction varchar(8) not null,
        currency char(3) not null,
        amount numeric(20,2) not null,
        balance_before numeric(20,2) not null,
        balance_after numeric(20,2) not null,
        created_at timestamptz not null,
        constraint wallet_ledger_entries_pkey primary key (id),
        constraint wallet_ledger_entries_direction_check check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_currency_format_check check (currency ~ '^[A-Z]{3}$'),
        constraint wallet_ledger_entries_amount_check check (amount > 0),
        constraint wallet_ledger_entries_balance_before_check check (balance_before >= 0),
        constraint wallet_ledger_entries_balance_after_check check (balance_after >= 0),
        constraint wallet_ledger_entries_arithmetic_check check (
          case direction
            when 'CREDIT' then balance_after = balance_before + amount
            when 'DEBIT' then balance_after = balance_before - amount
            else false
          end
        ),
        constraint wallet_ledger_entries_transaction_unique unique (transaction_id, wallet_id),
        constraint wallet_ledger_entries_wallet_fkey
          foreign key (wallet_id, currency) references ${schema}.wallets (id, currency)
          on update restrict on delete restrict,
        constraint wallet_ledger_entries_transaction_fkey
          foreign key (transaction_id, wallet_id)
          references ${schema}.wager_transactions (id, wallet_id)
          on update restrict on delete restrict
      )
    `);

    this.addSql(`
      create index wallet_ledger_entries_wallet_idx
        on ${schema}.wallet_ledger_entries (wallet_id, created_at, id)
    `);

    this.addSql(`
      create function ${schema}.wallet_ledger_entries_reject_mutation() returns trigger as $fn$
      begin
        raise exception 'wallet_ledger_entries is append-only: % is rejected', tg_op
          using errcode = '23514';
      end;
      $fn$ language plpgsql
    `);

    this.addSql(`
      create trigger wallet_ledger_entries_no_update before update
        on ${schema}.wallet_ledger_entries
        for each row execute function ${schema}.wallet_ledger_entries_reject_mutation()
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_delete before delete
        on ${schema}.wallet_ledger_entries
        for each row execute function ${schema}.wallet_ledger_entries_reject_mutation()
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate before truncate
        on ${schema}.wallet_ledger_entries
        for each statement execute function ${schema}.wallet_ledger_entries_reject_mutation()
    `);
  }

  override down(): void {
    const schema = this.targetSchema();

    // Derrubar a tabela remove seus triggers; a função é um objeto à parte.
    this.addSql(`drop table if exists ${schema}.wallet_ledger_entries`);
    this.addSql(`drop function if exists ${schema}.wallet_ledger_entries_reject_mutation()`);
    this.addSql(`drop table if exists ${schema}.wager_transactions`);
    this.addSql(`drop table if exists ${schema}.wallets`);
  }

  /** Os testes aplicam a migration em um schema isolado; a aplicação usa `public`. */
  private targetSchema(): string {
    const schema = this.config.get('schema') ?? 'public';
    return `"${schema}"`;
  }
}
