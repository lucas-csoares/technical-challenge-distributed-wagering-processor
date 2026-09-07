import { Migration } from '@mikro-orm/migrations';

/**
 * Inbox, Outbox e o estado de reprocessamento de `PENDING_REFERENCE`.
 *
 * As três tabelas existem para que garantias distribuídas não dependam de
 * memória: deduplicação de mensagem, publicação de evento e agendamento de
 * nova tentativa sobrevivem a reinício e são compartilhados entre instâncias.
 */
export class Migration20260907000000 extends Migration {
  override up(): void {
    const schema = this.targetSchema();

    this.addSql(`
      create table ${schema}.inbox_messages (
        consumer_name varchar(64) not null,
        message_id varchar(128) not null,
        payload_hash varchar(128) not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        constraint inbox_messages_pkey primary key (consumer_name, message_id)
      )
    `);

    this.addSql(`
      create table ${schema}.outbox_messages (
        id varchar(64) not null,
        aggregate_id varchar(64) not null,
        event_type varchar(64) not null,
        event_version integer not null,
        correlation_id varchar(128) not null,
        causation_id varchar(128),
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz not null,
        published_at timestamptz,
        constraint outbox_messages_pkey primary key (id),
        constraint outbox_messages_attempts_check check (attempts >= 0),
        constraint outbox_messages_version_check check (event_version >= 1)
      )
    `);

    // Índice parcial do polling: só as pendentes interessam, e elas somem do
    // índice assim que são publicadas, o que mantém a varredura barata mesmo
    // com a Outbox guardando todo o histórico publicado.
    this.addSql(`
      create index outbox_messages_pending_idx
        on ${schema}.outbox_messages (next_attempt_at, id)
        where published_at is null
    `);

    this.addSql(`
      alter table ${schema}.wager_transactions
        add column reference_attempts integer not null default 0,
        add column next_reference_attempt_at timestamptz
    `);

    this.addSql(`
      alter table ${schema}.wager_transactions
        add constraint wager_transactions_reference_attempts_check
        check (reference_attempts >= 0)
    `);

    // Espelha o índice da Outbox: o worker procura apenas pendências vencidas.
    this.addSql(`
      create index wager_transactions_pending_due_idx
        on ${schema}.wager_transactions (next_reference_attempt_at, id)
        where status = 'PENDING_REFERENCE'
    `);

    // `REFERENCE_NOT_FOUND` passa a existir com o worker: é o desfecho de uma
    // pendência cuja referência nunca chegou dentro da janela de tentativas.
    this.addSql(`
      alter table ${schema}.wager_transactions
        drop constraint wager_transactions_failure_code_check
    `);
    this.addSql(`
      alter table ${schema}.wager_transactions
        add constraint wager_transactions_failure_code_check check (
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
              'REFERENCE_ALREADY_REVERSED',
              'REFERENCE_NOT_FOUND'
            )
            when 'FAILED' then failure_code is not null
              and failure_code in ('PERMANENT_INFRASTRUCTURE_FAILURE')
            else failure_code is null
          end
        )
    `);
  }

  override down(): void {
    const schema = this.targetSchema();

    this.addSql(`
      alter table ${schema}.wager_transactions
        drop constraint if exists wager_transactions_failure_code_check
    `);
    this.addSql(`
      alter table ${schema}.wager_transactions
        add constraint wager_transactions_failure_code_check check (
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
        )
    `);
    this.addSql(`drop index if exists ${schema}.wager_transactions_pending_due_idx`);
    this.addSql(`
      alter table ${schema}.wager_transactions
        drop constraint if exists wager_transactions_reference_attempts_check
    `);
    this.addSql(`
      alter table ${schema}.wager_transactions
        drop column if exists next_reference_attempt_at,
        drop column if exists reference_attempts
    `);
    this.addSql(`drop table if exists ${schema}.outbox_messages`);
    this.addSql(`drop table if exists ${schema}.inbox_messages`);
  }

  private targetSchema(): string {
    return `"${this.config.get('schema') ?? 'public'}"`;
  }
}
