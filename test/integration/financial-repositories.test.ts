import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { FinancialTransactionScope } from '../../src/application/ports/financial-transaction-manager.js';
import { FinancialPersistenceError, InactiveTransactionError } from '../../src/application/ports/persistence-error.js';
import { FailureCode, InfrastructureFailureCode } from '../../src/domain/shared/failure-code.js';
import { Money } from '../../src/domain/shared/money.js';
import { WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry.js';
import { Wallet } from '../../src/domain/wallet/wallet.js';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction.js';
import { MikroOrmFinancialTransactionManager } from '../../src/infrastructure/persistence/mikro-orm-financial-transaction-manager.js';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';
import { TransactionContext } from '../../src/infrastructure/persistence/transaction-context.js';
import { WalletRecord } from '../../src/infrastructure/persistence/entities/wallet.record.js';
import { transaction } from '../unit/support.js';
import { createFinancialSchema, type FinancialSchema } from './support.js';
import { assertLedgerBalance, AT, id, LATER, openingFixture, persistCredit, persistOpening, requireWallet } from './financial-repository-support.js';

let db: FinancialSchema;
let manager: MikroOrmFinancialTransactionManager;

beforeAll(async () => {
  db = await createFinancialSchema();
  manager = new MikroOrmFinancialTransactionManager(db.orm);
});
afterAll(async () => { await db.close(); });

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to reject.');
}

describe('repositories financeiros', () => {
  test('commit grava os três agregados e devolve o resultado somente após confirmar', async () => {
    const fixture = openingFixture('90071992547409.93');
    const result = await manager.execute(async scope => {
      await persistOpening(scope, fixture);
      expect(await scope.transactions.findById(fixture.transaction.id)).toEqual(fixture.transaction);
      expect(await scope.ledger.findByWalletId(fixture.wallet.id)).toEqual([fixture.entry]);
      // Outro contexto não vê as escritas já enviadas ao banco antes do commit.
      expect(await db.orm.em.fork().count(WalletRecord, { id: fixture.wallet.id })).toBe(0);
      return fixture.wallet.id;
    });
    expect(result).toBe(fixture.wallet.id);
    await manager.execute(async scope => {
      expect(await scope.wallets.findById(result)).toEqual(fixture.wallet);
      expect(await scope.wallets.findByPlayerAndCurrency(fixture.wallet.playerId, 'BRL')).toEqual(fixture.wallet);
      expect(await scope.transactions.findById(fixture.transaction.id)).toEqual(fixture.transaction);
      expect(await scope.ledger.findByWalletId(result)).toEqual([fixture.entry]);
      return assertLedgerBalance(scope, result);
    });
  });

  test('leituras ausentes têm retorno definido e não misturam moedas', async () => {
    const fixture = openingFixture();
    await manager.execute(async scope => { await persistOpening(scope, fixture); });
    await manager.execute(async scope => {
      expect(await scope.wallets.findById(id())).toBeUndefined();
      expect(await scope.wallets.findByIdForUpdate(id())).toBeUndefined();
      expect(await scope.wallets.findByPlayerAndCurrency(fixture.wallet.playerId, 'USD')).toBeUndefined();
      expect(await scope.transactions.findById(id())).toBeUndefined();
      expect(await scope.transactions.findByProviderAndExternalTransactionId('absent', 'absent')).toBeUndefined();
      expect(await scope.transactions.findByProviderAndIdempotencyKey('absent', 'absent')).toBeUndefined();
      expect(await scope.ledger.findByWalletId(id())).toEqual([]);
      return assertLedgerBalance(scope, fixture.wallet.id);
    });
  });

  test('wallet zerada não gera transação ou ledger automaticamente', async () => {
    const { wallet } = Wallet.open({ id: id(), playerId: id(), initialBalance: Money.zero('BRL'), openedAt: AT });
    const { wallet: dollars } = Wallet.open({ id: id(), playerId: wallet.playerId, initialBalance: Money.zero('USD'), openedAt: AT });
    await manager.execute(async scope => {
      await scope.wallets.save(wallet);
      await scope.wallets.save(dollars);
    });
    await manager.execute(async scope => {
      expect(await scope.wallets.findById(wallet.id)).toEqual(wallet);
      expect(await scope.ledger.findByWalletId(wallet.id)).toEqual([]);
      expect(await scope.wallets.findByPlayerAndCurrency(wallet.playerId, 'BRL')).toEqual(wallet);
      expect(await scope.wallets.findByPlayerAndCurrency(wallet.playerId, 'USD')).toEqual(dollars);
      await assertLedgerBalance(scope, wallet.id);
      return assertLedgerBalance(scope, dollars.id);
    });
  });

  test('save preserva alteração do domínio, version, timestamps e centavos exatos', async () => {
    const fixture = openingFixture('90071992547409.93');
    await manager.execute(async scope => { await persistOpening(scope, fixture); });
    await manager.execute(async scope => {
      const wallet = requireWallet(await scope.wallets.findByIdForUpdate(fixture.wallet.id));
      await persistCredit(scope, wallet);
      await scope.wallets.save(wallet); // salvar sem nova movimentação não incrementa version
    });
    await manager.execute(async scope => {
      const wallet = requireWallet(await scope.wallets.findById(fixture.wallet.id));
      expect(wallet.balance.toString()).toBe('90071992547409.94');
      expect(wallet.version).toBe(2);
      expect(wallet.createdAt).toEqual(AT);
      expect(wallet.updatedAt.toISOString()).toBe('2026-09-06T12:05:00.000Z');
      return assertLedgerBalance(scope, wallet.id);
    });
  });

  test('consultas externas e idempotentes respeitam provider e distinguem as identidades', async () => {
    const fixture = openingFixture();
    const external = id();
    const key = id();
    const transactions = ['provider-a', 'provider-b'].map(providerId => transaction({
      id: id(), providerId, externalTransactionId: external, idempotencyKey: key,
      walletId: fixture.wallet.id, playerId: fixture.wallet.playerId,
    }));
    await manager.execute(async scope => {
      await persistOpening(scope, fixture);
      for (const tx of transactions) await scope.transactions.save(tx);
    });
    await manager.execute(async scope => {
      for (const tx of transactions) {
        expect(await scope.transactions.findById(tx.id)).toEqual(tx);
        expect(await scope.transactions.findByProviderAndExternalTransactionId(tx.providerId!, external)).toEqual(tx);
        expect(await scope.transactions.findByProviderAndIdempotencyKey(tx.providerId!, key)).toEqual(tx);
        expect(await scope.transactions.findByProviderAndExternalTransactionId(tx.providerId!, key)).toBeUndefined();
      }
      expect(await scope.transactions.findByProviderAndIdempotencyKey('provider-c', key)).toBeUndefined();
      return assertLedgerBalance(scope, fixture.wallet.id);
    });
  });

  test.each(['REJECTED', 'FAILED'] as const)('save atualiza estado %s sem alterar identidade ou hash', async status => {
    const fixture = openingFixture();
    const tx = transaction({ id: id(), externalTransactionId: id(), idempotencyKey: id(), walletId: fixture.wallet.id });
    await manager.execute(async scope => {
      await persistOpening(scope, fixture);
      await scope.transactions.save(tx);
    });
    await manager.execute(async scope => {
      await scope.wallets.findByIdForUpdate(fixture.wallet.id);
      const loaded = await scope.transactions.findById(tx.id);
      if (loaded === undefined) throw new Error('Expected transaction.');
      if (status === 'REJECTED') loaded.reject(FailureCode.InsufficientFunds);
      else loaded.fail(InfrastructureFailureCode.PermanentInfrastructureFailure);
      await scope.transactions.save(loaded);
    });
    await manager.execute(async scope => {
      const loaded = await scope.transactions.findById(tx.id);
      expect(loaded).toMatchObject({ id: tx.id, providerId: tx.providerId, idempotencyKey: tx.idempotencyKey, payloadHash: tx.payloadHash });
      expect(loaded?.status).toBe(
        status === 'REJECTED' ? WagerTransactionStatus.Rejected : WagerTransactionStatus.Failed,
      );
      expect(loaded?.failureCode).toBe(status === 'REJECTED' ? FailureCode.InsufficientFunds : InfrastructureFailureCode.PermanentInfrastructureFailure);
      expect(loaded?.createdAt).toEqual(tx.createdAt);
      expect(loaded?.processedAt).toBeUndefined();
      return assertLedgerBalance(scope, fixture.wallet.id);
    });
  });

  test('consulta de referência devolve também transação pendente, sem decidir elegibilidade', async () => {
    const fixture = openingFixture();
    const reference = transaction({ id: id(), externalTransactionId: id(), idempotencyKey: id(), walletId: fixture.wallet.id });
    const win = transaction({ id: id(), externalTransactionId: id(), idempotencyKey: id(), walletId: fixture.wallet.id,
      kind: WagerTransactionKind.Win, referenceExternalTransactionId: reference.externalTransactionId });
    await manager.execute(async scope => {
      await persistOpening(scope, fixture);
      await scope.transactions.save(reference);
      await scope.transactions.save(win);
    });
    await manager.execute(async scope => {
      const resolved = await scope.transactions.findByProviderAndExternalTransactionId('provider-a', reference.externalTransactionId!);
      expect(resolved?.id).toBe(reference.id);
      expect(resolved?.status).toBe(WagerTransactionStatus.Pending);
      expect(await scope.transactions.findById(win.id)).toEqual(win);
      return assertLedgerBalance(scope, fixture.wallet.id);
    });
  });

  test('append repetido falha por unicidade e não sobrescreve o lançamento', async () => {
    const fixture = openingFixture();
    await manager.execute(async scope => { await persistOpening(scope, fixture); });
    const failure = manager.execute(async scope => { await scope.ledger.append(fixture.entry); });
    const error = await rejectionOf(failure);
    expect(error).toBeInstanceOf(FinancialPersistenceError);
    expect(error).toMatchObject({ cause: { code: '23505' } });
    await manager.execute(async scope => {
      expect(await scope.ledger.findByWalletId(fixture.wallet.id)).toEqual([fixture.entry]);
      expect('save' in scope.ledger).toBe(false);
      expect('update' in scope.ledger).toBe(false);
      expect('delete' in scope.ledger).toBe(false);
      return assertLedgerBalance(scope, fixture.wallet.id);
    });
  });

  test('save preserva referências externa e interna e processedAt após atualização', async () => {
    const fixture = openingFixture();
    const reference = transaction({ id: id(), externalTransactionId: id(), idempotencyKey: id(),
      walletId: fixture.wallet.id, playerId: fixture.wallet.playerId });
    const win = transaction({ id: id(), externalTransactionId: id(), idempotencyKey: id(),
      walletId: fixture.wallet.id, playerId: fixture.wallet.playerId,
      kind: WagerTransactionKind.Win, referenceExternalTransactionId: reference.externalTransactionId });
    await manager.execute(async scope => {
      await persistOpening(scope, fixture);
      await scope.transactions.save(reference);
      await scope.transactions.save(win);
    });
    await manager.execute(async scope => {
      const wallet = requireWallet(await scope.wallets.findByIdForUpdate(fixture.wallet.id));
      // Fixture de estados válidos para conferir persistência, não um use case de BET/WIN.
      const debit = wallet.debit(reference.money, LATER);
      reference.markProcessed(undefined, LATER);
      await scope.wallets.save(wallet);
      await scope.transactions.save(reference);
      await scope.ledger.append(WalletLedgerEntry.create({ ...debit, id: id(), transactionId: reference.id, createdAt: LATER }));
      const credit = wallet.credit(win.money, LATER);
      win.markProcessed(reference.id, LATER);
      await scope.wallets.save(wallet);
      await scope.transactions.save(win);
      await scope.ledger.append(WalletLedgerEntry.create({ ...credit, id: id(), transactionId: win.id, createdAt: LATER }));
    });
    await manager.execute(async scope => {
      const loaded = await scope.transactions.findById(win.id);
      expect(loaded).toEqual(win);
      expect(loaded?.referenceExternalTransactionId).toBe(reference.externalTransactionId);
      expect(loaded?.referenceTransactionId).toBe(reference.id);
      expect(loaded?.processedAt).toEqual(LATER);
      return assertLedgerBalance(scope, fixture.wallet.id);
    });
  });

  test('ledger filtra por wallet e desempata timestamps iguais por id', async () => {
    const first = openingFixture();
    const other = openingFixture();
    const credits = await manager.execute(async scope => {
      await persistOpening(scope, first);
      await persistOpening(scope, other);
      const wallet = requireWallet(await scope.wallets.findByIdForUpdate(first.wallet.id));
      const a = await persistCredit(scope, wallet);
      const b = await persistCredit(scope, wallet);
      return [a.entry, b.entry].sort((a, b) => a.id.localeCompare(b.id));
    });
    await manager.execute(async scope => {
      expect(await scope.ledger.findByWalletId(first.wallet.id)).toEqual([first.entry, ...credits]);
      expect(await scope.ledger.findByWalletId(other.wallet.id)).toEqual([other.entry]);
      await assertLedgerBalance(scope, first.wallet.id);
      return assertLedgerBalance(scope, other.wallet.id);
    });
  });
});

describe('fronteira transacional', () => {
  test('erro após três escritas desfaz tudo e preserva a exceção do callback', async () => {
    const fixture = openingFixture();
    const failure = new Error('Intentional callback rollback');
    expect(await rejectionOf(manager.execute(async scope => {
      await persistOpening(scope, fixture);
      expect(await scope.wallets.findById(fixture.wallet.id)).toBeDefined();
      throw failure;
    }))).toBe(failure);
    await manager.execute(async scope => {
      expect(await scope.wallets.findById(fixture.wallet.id)).toBeUndefined();
      expect(await scope.transactions.findById(fixture.transaction.id)).toBeUndefined();
      expect(await scope.ledger.findByWalletId(fixture.wallet.id)).toEqual([]);
    });
  });

  test('rollback desfaz UPDATE de saldo/version e novos registros financeiros', async () => {
    const fixture = openingFixture();
    await manager.execute(async scope => { await persistOpening(scope, fixture); });
    let newTransactionId: string | undefined;
    const failure = new Error('Rollback update');
    expect(await rejectionOf(manager.execute(async scope => {
      const wallet = requireWallet(await scope.wallets.findByIdForUpdate(fixture.wallet.id));
      const credit = await persistCredit(scope, wallet);
      newTransactionId = credit.transaction.id;
      throw failure;
    }))).toBe(failure);
    await manager.execute(async scope => {
      expect(await scope.wallets.findById(fixture.wallet.id)).toEqual(fixture.wallet);
      expect(await scope.transactions.findById(newTransactionId!)).toBeUndefined();
      expect(await scope.ledger.findByWalletId(fixture.wallet.id)).toEqual([fixture.entry]);
      return assertLedgerBalance(scope, fixture.wallet.id);
    });
  });

  test('erro PostgreSQL causa rollback e é traduzido sem expor SQL na mensagem pública', async () => {
    const fixture = openingFixture();
    const result = manager.execute(async scope => {
      await persistOpening(scope, fixture);
      await scope.ledger.append(fixture.entry);
    });
    expect(await rejectionOf(result)).toMatchObject({
      name: 'FinancialPersistenceError', message: 'Financial persistence failed.',
      cause: { code: '23505' },
    });
    await manager.execute(async scope => {
      expect(await scope.wallets.findById(fixture.wallet.id)).toBeUndefined();
      expect(await scope.transactions.findById(fixture.transaction.id)).toBeUndefined();
      expect(await scope.ledger.findByWalletId(fixture.wallet.id)).toEqual([]);
    });
  });

  test('repositories capturados não funcionam depois do commit', async () => {
    const scope = await manager.execute(async scope => Promise.resolve(scope));
    expect(await rejectionOf(scope.wallets.findByIdForUpdate(id()))).toBeInstanceOf(InactiveTransactionError);
    expect(await rejectionOf(scope.transactions.findById(id()))).toBeInstanceOf(InactiveTransactionError);
    expect(await rejectionOf(scope.ledger.findByWalletId(id()))).toBeInstanceOf(InactiveTransactionError);
    expect(await rejectionOf(scope.wallets.save(openingFixture().wallet))).toBeInstanceOf(InactiveTransactionError);
  });

  test('repositories capturados não funcionam depois do rollback', async () => {
    let captured: FinancialTransactionScope | undefined;
    const failure = new Error('Close scope');
    expect(await rejectionOf(manager.execute(async scope => {
      captured = scope;
      await scope.wallets.findById(id());
      throw failure;
    }))).toBe(failure);
    if (captured === undefined) throw new Error('Expected callback scope.');
    expect(await rejectionOf(captured.wallets.findByIdForUpdate(id()))).toBeInstanceOf(InactiveTransactionError);
  });

  test('adapter recusa lock sem transação PostgreSQL ativa', async () => {
    const repository = new MikroOrmWalletRepository(new TransactionContext(db.orm.em.fork()));
    expect(await rejectionOf(repository.findByIdForUpdate(id()))).toBeInstanceOf(InactiveTransactionError);
  });
});
