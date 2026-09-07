import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  BUSINESS_FAILURE_CODES,
  INFRASTRUCTURE_FAILURE_CODES,
} from '../../src/domain/shared/failure-code.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wagering/wager-transaction.js';
import {
  createFinancialSchema,
  expectRejection,
  LEDGER_COLUMNS,
  ledgerValues,
  placeholders,
  TRANSACTION_COLUMNS,
  transactionValues,
  type FinancialSchema,
  type LedgerRow,
  type TransactionRow,
  WALLET_COLUMNS,
  walletValues,
  type WalletRow,
} from './support.js';

let db: FinancialSchema;
let sequence = 0;

function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${String(sequence)}`;
}

function table(name: string): string {
  return `"${db.schema}".${name}`;
}

async function insertWallet(row: WalletRow): Promise<string> {
  await db.orm.em
    .fork()
    .execute(
      `insert into ${table('wallets')} (${WALLET_COLUMNS}) values (${placeholders(7)})`,
      walletValues(row),
    );

  return row.id;
}

async function insertTransaction(row: TransactionRow): Promise<string> {
  await db.orm.em
    .fork()
    .execute(
      `insert into ${table('wager_transactions')} (${TRANSACTION_COLUMNS}) values (${placeholders(18)})`,
      transactionValues(row),
    );

  return row.id;
}

async function insertLedger(row: LedgerRow): Promise<string> {
  await db.orm.em
    .fork()
    .execute(
      `insert into ${table('wallet_ledger_entries')} (${LEDGER_COLUMNS}) values (${placeholders(9)})`,
      ledgerValues(row),
    );

  return row.id;
}

function rejectWallet(row: WalletRow): Promise<string> {
  return expectRejection(
    db,
    `insert into ${table('wallets')} (${WALLET_COLUMNS}) values (${placeholders(7)})`,
    walletValues(row),
  );
}

function rejectTransaction(row: TransactionRow): Promise<string> {
  return expectRejection(
    db,
    `insert into ${table('wager_transactions')} (${TRANSACTION_COLUMNS}) values (${placeholders(18)})`,
    transactionValues(row),
  );
}

function rejectLedger(row: LedgerRow): Promise<string> {
  return expectRejection(
    db,
    `insert into ${table('wallet_ledger_entries')} (${LEDGER_COLUMNS}) values (${placeholders(9)})`,
    ledgerValues(row),
  );
}

/** Wallet nova, isolada das demais pelo par (playerId, currency). */
async function freshWallet(balance = '100.00', currency = 'BRL'): Promise<string> {
  const id = unique('wallet');
  return insertWallet({ id, playerId: unique('player'), balance, currency });
}

beforeAll(async () => {
  db = await createFinancialSchema();
});

afterAll(async () => {
  await db.close();
});

describe('wallets', () => {
  test('aceita uma wallet válida e devolve o saldo exatamente como gravado', async () => {
    const id = await freshWallet('1000.00');
    const rows = await db.orm.em
      .fork()
      .execute<{ balance: string; version: number }[]>(
        `select balance, version from ${table('wallets')} where id = ?`,
        [id],
      );

    expect(rows[0]?.balance).toBe('1000.00');
    expect(typeof rows[0]?.balance).toBe('string');
    expect(rows[0]?.version).toBe(1);
  });

  test('recusa uma segunda wallet do mesmo player e moeda', async () => {
    const playerId = unique('player');
    await insertWallet({ id: unique('wallet'), playerId, currency: 'BRL' });

    const rejection = await rejectWallet({ id: unique('wallet'), playerId, currency: 'BRL' });
    expect(rejection).toContain('wallets_player_currency_unique');
  });

  test('permite o mesmo player em moedas diferentes', async () => {
    const playerId = unique('player');
    await insertWallet({ id: unique('wallet'), playerId, currency: 'BRL' });

    const second = await insertWallet({ id: unique('wallet'), playerId, currency: 'USD' });
    expect(second).toBeDefined();
  });

  test('recusa saldo negativo', async () => {
    const rejection = await rejectWallet({
      id: unique('wallet'),
      playerId: unique('player'),
      balance: '-0.01',
    });

    expect(rejection).toContain('wallets_balance_not_negative_check');
  });

  test.each([0, -1])('recusa version %i', async (version) => {
    const rejection = await rejectWallet({
      id: unique('wallet'),
      playerId: unique('player'),
      version,
    });

    expect(rejection).toContain('wallets_version_check');
  });

  test.each(['brl', 'BR1', 'B R'])('recusa a moeda %p', async (currency) => {
    const rejection = await rejectWallet({
      id: unique('wallet'),
      playerId: unique('player'),
      currency,
    });

    expect(rejection).toContain('wallets_currency_format_check');
  });

  test('persiste o extremo do range monetário sem perder um centavo', async () => {
    const id = await freshWallet('999999999999999999.99');
    const rows = await db.orm.em
      .fork()
      .execute<{ balance: string }[]>(`select balance from ${table('wallets')} where id = ?`, [id]);

    expect(rows[0]?.balance).toBe('999999999999999999.99');
  });

  test('recusa um valor acima da precisão declarada da coluna', async () => {
    const rejection = await rejectWallet({
      id: unique('wallet'),
      playerId: unique('player'),
      balance: '1000000000000000000.00',
    });

    expect(rejection).toMatch(/numeric field overflow|out of range/i);
  });
});

describe('wager transactions', () => {
  test('aceita cada tipo de operação com sua forma válida', async () => {
    const walletId = await freshWallet();

    await insertTransaction({ id: unique('tx'), walletId, kind: WagerTransactionKind.Bet });
    await insertTransaction({ id: unique('tx'), walletId, kind: WagerTransactionKind.Win });
    await insertTransaction({
      id: unique('tx'),
      walletId,
      kind: WagerTransactionKind.Loss,
      amount: '0.00',
    });
    await insertTransaction({
      id: unique('tx'),
      walletId,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-bet',
    });
    await insertTransaction({
      id: unique('tx'),
      walletId,
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'ext-bet',
    });

    const opening = await insertTransaction({
      id: unique('tx'),
      walletId,
      kind: WagerTransactionKind.Opening,
      amount: '100.00',
    });

    expect(opening).toBeDefined();
  });

  test('recusa o mesmo external id dentro do mesmo provider', async () => {
    const walletId = await freshWallet();
    await insertTransaction({
      id: unique('tx'),
      walletId,
      providerId: 'provider-a',
      externalTransactionId: 'shared-external',
    });

    const rejection = await rejectTransaction({
      id: unique('tx'),
      walletId,
      providerId: 'provider-a',
      externalTransactionId: 'shared-external',
      idempotencyKey: unique('key'),
    });

    expect(rejection).toContain('wager_transactions_provider_external_unique');
  });

  test('aceita o mesmo external id em providers diferentes', async () => {
    const walletId = await freshWallet();
    await insertTransaction({
      id: unique('tx'),
      walletId,
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
    });

    const accepted = await insertTransaction({
      id: unique('tx'),
      walletId,
      providerId: 'provider-b',
      externalTransactionId: 'transaction-123',
    });

    expect(accepted).toBeDefined();
  });

  test('recusa a mesma idempotency key do mesmo provider, mesmo com external id diferente', async () => {
    const walletId = await freshWallet();
    const idempotencyKey = unique('key');

    await insertTransaction({ id: unique('tx'), walletId, providerId: 'provider-a', idempotencyKey });

    const rejection = await rejectTransaction({
      id: unique('tx'),
      walletId,
      providerId: 'provider-a',
      idempotencyKey,
    });

    expect(rejection).toContain('wager_transactions_idempotency_key_unique');
  });

  test('a mesma idempotency key em providers diferentes não colide', async () => {
    const walletId = await freshWallet();
    const idempotencyKey = unique('key');

    await insertTransaction({ id: unique('tx'), walletId, providerId: 'provider-a', idempotencyKey });

    // A identidade de idempotência tem escopo de provider: um provedor não
    // consegue derrubar a requisição legítima de outro escolhendo a mesma key.
    const accepted = await insertTransaction({
      id: unique('tx'),
      walletId,
      providerId: 'provider-b',
      idempotencyKey,
    });

    expect(accepted).toBeDefined();
  });

  test('recusa uma segunda OPENING para a mesma wallet', async () => {
    const walletId = await freshWallet();
    await insertTransaction({ id: unique('tx'), walletId, kind: WagerTransactionKind.Opening });

    const rejection = await rejectTransaction({
      id: unique('tx'),
      walletId,
      kind: WagerTransactionKind.Opening,
    });

    expect(rejection).toContain('wager_transactions_opening_per_wallet_unique');
  });

  test('permite OPENING em wallets diferentes apesar da identidade externa nula', async () => {
    const first = await freshWallet();
    const second = await freshWallet();

    await insertTransaction({ id: unique('tx'), walletId: first, kind: WagerTransactionKind.Opening });

    const accepted = await insertTransaction({
      id: unique('tx'),
      walletId: second,
      kind: WagerTransactionKind.Opening,
    });

    expect(accepted).toBeDefined();
  });

  test('recusa OPENING com identidade externa inventada', async () => {
    const walletId = await freshWallet();
    const rejection = await rejectTransaction({
      id: unique('tx'),
      walletId,
      kind: WagerTransactionKind.Opening,
      providerId: 'internal',
      externalTransactionId: 'opening',
      idempotencyKey: 'internal:opening',
      payloadHash: 'hash',
      roundId: 'round-1',
      gameId: 'fortune-chimp',
    });

    expect(rejection).toContain('wager_transactions_internal_identity_check');
  });

  test('recusa uma operação de provedor sem identidade externa completa', async () => {
    const walletId = await freshWallet();

    const incomplete: readonly Partial<TransactionRow>[] = [
      { providerId: null },
      { externalTransactionId: null },
      { idempotencyKey: null },
      { payloadHash: null },
      { roundId: null },
      { gameId: null },
    ];

    for (const missing of incomplete) {
      const rejection = await rejectTransaction({ id: unique('tx'), walletId, ...missing });

      expect(rejection).toContain('wager_transactions_internal_identity_check');
    }
  });

  test('recusa wallet inexistente', async () => {
    const rejection = await rejectTransaction({ id: unique('tx'), walletId: 'missing-wallet' });
    expect(rejection).toContain('wager_transactions_wallet_fkey');
  });

  test('preserva moeda divergente para rejei��o audit�vel na aplica��o', async () => {
    const walletId = await freshWallet('100.00', 'BRL');
    await insertTransaction({ id: unique('tx'), walletId, currency: 'USD', status: WagerTransactionStatus.Rejected, failureCode: 'CURRENCY_MISMATCH' });
  });

  test('recusa referência interna inexistente', async () => {
    const walletId = await freshWallet();
    const rejection = await rejectTransaction({
      id: unique('tx'),
      walletId,
      kind: WagerTransactionKind.Refund,
      status: WagerTransactionStatus.Processed,
      processedAt: new Date(),
      referenceExternalTransactionId: 'ext-bet',
      referenceTransactionId: 'missing-transaction',
    });

    expect(rejection).toContain('wager_transactions_reference_fkey');
  });

  test('liga a referência interna a uma transação existente', async () => {
    const walletId = await freshWallet();
    const bet = await insertTransaction({
      id: unique('tx'),
      walletId,
      status: WagerTransactionStatus.Processed,
      processedAt: new Date(),
    });

    const accepted = await insertTransaction({
      id: unique('tx'),
      walletId,
      kind: WagerTransactionKind.Refund,
      status: WagerTransactionStatus.Processed,
      processedAt: new Date(),
      referenceExternalTransactionId: 'ext-bet',
      referenceTransactionId: bet,
    });

    expect(accepted).toBeDefined();
  });

  test.each([
    [WagerTransactionKind.Bet, '0.00'],
    [WagerTransactionKind.Win, '0.00'],
    [WagerTransactionKind.Refund, '0.00'],
  ] as const)('recusa %s de valor zero', async (kind, amount) => {
    const walletId = await freshWallet();
    const rejection = await rejectTransaction({
      id: unique('tx'),
      walletId,
      kind,
      amount,
      referenceExternalTransactionId: kind === WagerTransactionKind.Refund ? 'ext-bet' : null,
    });

    expect(rejection).toContain('wager_transactions_amount_check');
  });

  test('recusa valor negativo', async () => {
    const walletId = await freshWallet();
    const rejection = await rejectTransaction({ id: unique('tx'), walletId, amount: '-1.00' });

    expect(rejection).toContain('wager_transactions_amount_check');
  });

  test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback] as const)(
    'recusa %s sem referência externa',
    async (kind) => {
      const walletId = await freshWallet();
      const rejection = await rejectTransaction({ id: unique('tx'), walletId, kind });

      expect(rejection).toContain('wager_transactions_external_reference_check');
    },
  );

  test.each([WagerTransactionKind.Bet, WagerTransactionKind.Loss] as const)(
    'recusa %s com referência externa',
    async (kind) => {
      const walletId = await freshWallet();
      const rejection = await rejectTransaction({
        id: unique('tx'),
        walletId,
        kind,
        referenceExternalTransactionId: 'ext-bet',
      });

      expect(rejection).toContain('wager_transactions_external_reference_check');
    },
  );

  test('recusa PENDING_REFERENCE em operação que não depende de referência', async () => {
    const walletId = await freshWallet();
    const rejection = await rejectTransaction({
      id: unique('tx'),
      walletId,
      status: WagerTransactionStatus.PendingReference,
    });

    expect(rejection).toContain('wager_transactions_pending_reference_check');
  });

  test('exige processedAt exatamente em PROCESSED', async () => {
    const walletId = await freshWallet();

    const withoutTimestamp = await rejectTransaction({
      id: unique('tx'),
      walletId,
      status: WagerTransactionStatus.Processed,
    });
    expect(withoutTimestamp).toContain('wager_transactions_processed_at_check');

    const timestampWhilePending = await rejectTransaction({
      id: unique('tx'),
      walletId,
      processedAt: new Date(),
    });
    expect(timestampWhilePending).toContain('wager_transactions_processed_at_check');
  });

  test('exige a referência interna quando um PROCESSED cita referência externa', async () => {
    const walletId = await freshWallet();
    const rejection = await rejectTransaction({
      id: unique('tx'),
      walletId,
      kind: WagerTransactionKind.Win,
      status: WagerTransactionStatus.Processed,
      processedAt: new Date(),
      referenceExternalTransactionId: 'ext-bet',
    });

    expect(rejection).toContain('wager_transactions_internal_reference_check');
  });

  test('recusa referência interna sem referência externa correspondente', async () => {
    const walletId = await freshWallet();
    const bet = await insertTransaction({ id: unique('tx'), walletId });
    const rejection = await rejectTransaction({
      id: unique('tx'),
      walletId,
      kind: WagerTransactionKind.Win,
      status: WagerTransactionStatus.Processed,
      processedAt: new Date(),
      referenceTransactionId: bet,
    });

    expect(rejection).toContain('wager_transactions_internal_reference_check');
  });

  test('recusa uma transação que referencia a si mesma', async () => {
    const walletId = await freshWallet();
    const id = unique('tx');
    const rejection = await rejectTransaction({
      id,
      walletId,
      kind: WagerTransactionKind.Refund,
      status: WagerTransactionStatus.Processed,
      processedAt: new Date(),
      referenceExternalTransactionId: 'ext-bet',
      referenceTransactionId: id,
    });

    expect(rejection).toContain('wager_transactions_no_self_reference_check');
  });

  test('REJECTED exige um código de negócio', async () => {
    const walletId = await freshWallet();

    const accepted = await insertTransaction({
      id: unique('tx'),
      walletId,
      status: WagerTransactionStatus.Rejected,
      failureCode: 'INSUFFICIENT_FUNDS',
    });
    expect(accepted).toBeDefined();

    // `null in (...)` avalia para NULL, e um CHECK só rejeita FALSE: sem o
    // `is not null` explícito uma rejeição entraria sem motivo registrado.
    const withoutCode = await rejectTransaction({
      id: unique('tx'),
      walletId,
      status: WagerTransactionStatus.Rejected,
      failureCode: null,
    });
    expect(withoutCode).toContain('wager_transactions_failure_code_check');

    const withTechnicalCode = await rejectTransaction({
      id: unique('tx'),
      walletId,
      status: WagerTransactionStatus.Rejected,
      failureCode: 'PERMANENT_INFRASTRUCTURE_FAILURE',
    });
    expect(withTechnicalCode).toContain('wager_transactions_failure_code_check');
  });

  test('FAILED exige um código de infraestrutura', async () => {
    const walletId = await freshWallet();

    const accepted = await insertTransaction({
      id: unique('tx'),
      walletId,
      status: WagerTransactionStatus.Failed,
      failureCode: 'PERMANENT_INFRASTRUCTURE_FAILURE',
    });
    expect(accepted).toBeDefined();

    const withoutCode = await rejectTransaction({
      id: unique('tx'),
      walletId,
      status: WagerTransactionStatus.Failed,
      failureCode: null,
    });
    expect(withoutCode).toContain('wager_transactions_failure_code_check');

    const withBusinessCode = await rejectTransaction({
      id: unique('tx'),
      walletId,
      status: WagerTransactionStatus.Failed,
      failureCode: 'INSUFFICIENT_FUNDS',
    });
    expect(withBusinessCode).toContain('wager_transactions_failure_code_check');
  });

  test.each([
    WagerTransactionStatus.Pending,
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Processed,
  ] as const)('%s não carrega failure code', async (status) => {
    const walletId = await freshWallet();
    const reversal = status === WagerTransactionStatus.PendingReference;

    const rejection = await rejectTransaction({
      id: unique('tx'),
      walletId,
      kind: reversal ? WagerTransactionKind.Refund : WagerTransactionKind.Bet,
      referenceExternalTransactionId: reversal ? 'ext-bet' : null,
      status,
      processedAt: status === WagerTransactionStatus.Processed ? new Date() : null,
      failureCode: 'INSUFFICIENT_FUNDS',
    });

    expect(rejection).toContain('wager_transactions_failure_code_check');
  });

  test('recusa um failure code desconhecido', async () => {
    const walletId = await freshWallet();
    const rejection = await rejectTransaction({
      id: unique('tx'),
      walletId,
      status: WagerTransactionStatus.Rejected,
      failureCode: 'SOMETHING_ELSE',
    });

    expect(rejection).toContain('wager_transactions_failure_code_check');
  });

  test('aceita cada código de negócio em REJECTED e cada técnico em FAILED', async () => {
    const walletId = await freshWallet();

    for (const code of BUSINESS_FAILURE_CODES) {
      await insertTransaction({
        id: unique('tx'),
        walletId,
        status: WagerTransactionStatus.Rejected,
        failureCode: code,
      });
    }

    for (const code of INFRASTRUCTURE_FAILURE_CODES) {
      await insertTransaction({
        id: unique('tx'),
        walletId,
        status: WagerTransactionStatus.Failed,
        failureCode: code,
      });
    }

    expect(BUSINESS_FAILURE_CODES.length).toBeGreaterThan(0);
    expect(INFRASTRUCTURE_FAILURE_CODES.length).toBeGreaterThan(0);
  });

  test('as constraints incluem os kinds e status do domínio', async () => {
    const rows = await db.orm.em.fork().execute<{ name: string; definition: string }[]>(
      `select conname as name, pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conrelid = ?::regclass`,
      [`"${db.schema}".wager_transactions`],
    );

    const definition = (name: string): string =>
      rows.find((row) => row.name === name)?.definition ?? '';

    for (const kind of Object.values(WagerTransactionKind)) {
      expect(definition('wager_transactions_kind_check')).toContain(`'${kind}'`);
    }

    for (const status of Object.values(WagerTransactionStatus)) {
      expect(definition('wager_transactions_status_check')).toContain(`'${status}'`);
    }
  });
});

describe('wallet ledger entries', () => {
  async function walletWithTransaction(): Promise<{ walletId: string; transactionId: string }> {
    const walletId = await freshWallet();
    const transactionId = await insertTransaction({ id: unique('tx'), walletId });

    return { walletId, transactionId };
  }

  test('aceita um lançamento equilibrado', async () => {
    const { walletId, transactionId } = await walletWithTransaction();
    const id = await insertLedger({ id: unique('entry'), walletId, transactionId });

    const rows = await db.orm.em
      .fork()
      .execute<
        { amount: string; balance_before: string; balance_after: string }[]
      >(`select amount, balance_before, balance_after from ${table('wallet_ledger_entries')} where id = ?`, [id]);

    expect(rows[0]).toEqual({
      amount: '25.00',
      balance_before: '100.00',
      balance_after: '75.00',
    });
  });

  test('recusa um segundo lançamento para a mesma transação e wallet', async () => {
    const { walletId, transactionId } = await walletWithTransaction();
    await insertLedger({ id: unique('entry'), walletId, transactionId });

    const rejection = await rejectLedger({ id: unique('entry'), walletId, transactionId });
    expect(rejection).toContain('wallet_ledger_entries_transaction_unique');
  });

  test.each(['0.00', '-25.00'])('recusa o valor de movimentação %p', async (amount) => {
    const { walletId, transactionId } = await walletWithTransaction();
    const rejection = await rejectLedger({
      id: unique('entry'),
      walletId,
      transactionId,
      amount,
      balanceBefore: '100.00',
      balanceAfter: '100.00',
    });

    expect(rejection).toContain('wallet_ledger_entries_amount_check');
  });

  test('recusa saldo anterior negativo', async () => {
    const { walletId, transactionId } = await walletWithTransaction();
    const rejection = await rejectLedger({
      id: unique('entry'),
      walletId,
      transactionId,
      direction: 'CREDIT',
      amount: '25.00',
      balanceBefore: '-1.00',
      balanceAfter: '24.00',
    });

    expect(rejection).toContain('wallet_ledger_entries_balance_before_check');
  });

  test('recusa saldo posterior negativo', async () => {
    const { walletId, transactionId } = await walletWithTransaction();
    const rejection = await rejectLedger({
      id: unique('entry'),
      walletId,
      transactionId,
      amount: '25.00',
      balanceBefore: '10.00',
      balanceAfter: '-15.00',
    });

    expect(rejection).toContain('wallet_ledger_entries_balance_after_check');
  });

  test('recusa aritmética inválida de CREDIT', async () => {
    const { walletId, transactionId } = await walletWithTransaction();
    const rejection = await rejectLedger({
      id: unique('entry'),
      walletId,
      transactionId,
      direction: 'CREDIT',
      amount: '25.00',
      balanceBefore: '100.00',
      balanceAfter: '124.99',
    });

    expect(rejection).toContain('wallet_ledger_entries_arithmetic_check');
  });

  test('recusa aritmética inválida de DEBIT', async () => {
    const { walletId, transactionId } = await walletWithTransaction();
    const rejection = await rejectLedger({
      id: unique('entry'),
      walletId,
      transactionId,
      direction: 'DEBIT',
      amount: '25.00',
      balanceBefore: '100.00',
      balanceAfter: '125.00',
    });

    expect(rejection).toContain('wallet_ledger_entries_arithmetic_check');
  });

  test('recusa uma direção desconhecida', async () => {
    const { walletId, transactionId } = await walletWithTransaction();
    const rejection = await rejectLedger({
      id: unique('entry'),
      walletId,
      transactionId,
      direction: 'REVERSAL',
    });

    // A aritmética também não fecha para uma direção desconhecida, então
    // qualquer um dos dois CHECKs pode ser o primeiro a barrar a linha.
    expect(rejection).toMatch(
      /wallet_ledger_entries_(direction|arithmetic)_check/,
    );
  });

  test('recusa transação inexistente', async () => {
    const walletId = await freshWallet();
    const rejection = await rejectLedger({
      id: unique('entry'),
      walletId,
      transactionId: 'missing-transaction',
    });

    expect(rejection).toContain('wallet_ledger_entries_transaction_fkey');
  });

  test('recusa um lançamento na wallet errada da transação', async () => {
    const { transactionId } = await walletWithTransaction();
    const otherWallet = await freshWallet();

    const rejection = await rejectLedger({
      id: unique('entry'),
      walletId: otherWallet,
      transactionId,
    });

    expect(rejection).toContain('wallet_ledger_entries_transaction_fkey');
  });

  test('recusa moeda diferente da wallet', async () => {
    const { walletId, transactionId } = await walletWithTransaction();
    const rejection = await rejectLedger({
      id: unique('entry'),
      walletId,
      transactionId,
      currency: 'USD',
    });

    expect(rejection).toContain('wallet_ledger_entries_wallet_fkey');
  });
});

describe('imutabilidade do ledger', () => {
  test('PostgreSQL rejeita UPDATE em um lançamento', async () => {
    const walletId = await freshWallet();
    const transactionId = await insertTransaction({ id: unique('tx'), walletId });
    const id = await insertLedger({ id: unique('entry'), walletId, transactionId });

    const rejection = await expectRejection(
      db,
      `update ${table('wallet_ledger_entries')} set amount = ? where id = ?`,
      ['1.00', id],
    );

    expect(rejection).toContain('append-only');

    const rows = await db.orm.em
      .fork()
      .execute<
        { amount: string }[]
      >(`select amount from ${table('wallet_ledger_entries')} where id = ?`, [id]);
    expect(rows[0]?.amount).toBe('25.00');
  });

  test('PostgreSQL rejeita DELETE de um lançamento', async () => {
    const walletId = await freshWallet();
    const transactionId = await insertTransaction({ id: unique('tx'), walletId });
    const id = await insertLedger({ id: unique('entry'), walletId, transactionId });

    const rejection = await expectRejection(
      db,
      `delete from ${table('wallet_ledger_entries')} where id = ?`,
      [id],
    );

    expect(rejection).toContain('append-only');

    const rows = await db.orm.em
      .fork()
      .execute<{ total: string }[]>(
        `select count(*)::text as total from ${table('wallet_ledger_entries')} where id = ?`,
        [id],
      );
    expect(rows[0]?.total).toBe('1');
  });

  test('PostgreSQL rejeita TRUNCATE da tabela do ledger', async () => {
    const rejection = await expectRejection(db, `truncate ${table('wallet_ledger_entries')}`);
    expect(rejection).toContain('append-only');
  });

  test('exclusões financeiras não caem em cascata a partir da wallet', async () => {
    const walletId = await freshWallet();
    const transactionId = await insertTransaction({ id: unique('tx'), walletId });
    await insertLedger({ id: unique('entry'), walletId, transactionId });

    const rejection = await expectRejection(db, `delete from ${table('wallets')} where id = ?`, [
      walletId,
    ]);

    expect(rejection).toContain('violates RESTRICT setting of foreign key constraint');
    expect(rejection).toContain('wallet_ledger_entries_wallet_fkey');
  });

  test('uma transação com lançamento não pode ser removida', async () => {
    const walletId = await freshWallet();
    const transactionId = await insertTransaction({ id: unique('tx'), walletId });
    await insertLedger({ id: unique('entry'), walletId, transactionId });

    const rejection = await expectRejection(
      db,
      `delete from ${table('wager_transactions')} where id = ?`,
      [transactionId],
    );

    expect(rejection).toContain('violates RESTRICT setting of foreign key constraint');
    expect(rejection).toContain('wallet_ledger_entries_transaction_fkey');
  });
});
