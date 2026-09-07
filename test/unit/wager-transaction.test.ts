import { describe, expect, test } from 'bun:test';
import {
  InvalidAmountError,
  InvalidInputError,
  InvalidReferenceError,
  InvalidTransactionStateError,
} from '../../src/domain/shared/domain-error.js';
import {
  FailureCode,
  InfrastructureFailureCode,
} from '../../src/domain/shared/failure-code.js';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wagering/wager-transaction.js';
import { AT, brl, LATER, processedTransaction, transaction } from './support.js';

describe('criação', () => {
  test('uma operação submetida nasce em PENDING', () => {
    const bet = transaction();

    expect(bet.status).toBe(WagerTransactionStatus.Pending);
    expect(bet.isTerminal()).toBe(false);
    expect(bet.processedAt).toBeUndefined();
    expect(bet.failureCode).toBeUndefined();
    expect(bet.referenceTransactionId).toBeUndefined();
  });

  test('OPENING não pode ser submetido pelo caminho externo', () => {
    expect(() =>
      transaction({ kind: WagerTransactionKind.Opening as never }),
    ).toThrow(InvalidInputError);
  });

  test('um kind desconhecido é recusado mesmo vindo de JSON', () => {
    expect(() => transaction({ kind: 'CASHOUT' as never })).toThrow(InvalidInputError);
  });

  test('OPENING é criado apenas pelo caminho interno, sem identidade externa', () => {
    const opening = WagerTransaction.createOpening({
      id: 'tx-opening',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl('1000.00'),
      createdAt: AT,
    });

    expect(opening.kind).toBe(WagerTransactionKind.Opening);
    expect(opening.status).toBe(WagerTransactionStatus.Pending);
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);

    // Nenhum valor fictício preenche a identidade externa de uma abertura.
    expect(opening.providerId).toBeUndefined();
    expect(opening.externalTransactionId).toBeUndefined();
    expect(opening.idempotencyKey).toBeUndefined();
    expect(opening.payloadHash).toBeUndefined();
    expect(opening.roundId).toBeUndefined();
    expect(opening.gameId).toBeUndefined();
    expect(opening.referenceExternalTransactionId).toBeUndefined();
  });

  test('OPENING exige valor positivo e identificadores internos válidos', () => {
    const base = {
      id: 'tx-opening',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl('1000.00'),
      createdAt: AT,
    };

    expect(() => WagerTransaction.createOpening({ ...base, money: brl('0.00') })).toThrow(
      InvalidAmountError,
    );
    expect(() => WagerTransaction.createOpening({ ...base, walletId: '' })).toThrow(
      InvalidInputError,
    );
  });
});

describe('exigência de referência', () => {
  test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback] as const)(
    '%s sem referência falha com REFERENCE_REQUIRED',
    (kind) => {
      try {
        transaction({ kind, money: brl('25.00') });
        throw new Error('expected the creation to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidReferenceError);
        expect((error as InvalidReferenceError).failureCode).toBe(FailureCode.ReferenceRequired);
      }
    },
  );

  test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback] as const)(
    '%s com referência é aceito',
    (kind) => {
      const reversal = transaction({ kind, referenceExternalTransactionId: 'ext-bet' });

      expect(reversal.requiresReference()).toBe(true);
      expect(reversal.referenceExternalTransactionId).toBe('ext-bet');
    },
  );

  test.each([WagerTransactionKind.Bet, WagerTransactionKind.Loss] as const)(
    '%s recusa uma referência com REFERENCE_NOT_SUPPORTED',
    (kind) => {
      try {
        transaction({ kind, referenceExternalTransactionId: 'ext-bet' });
        throw new Error('expected the creation to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidReferenceError);
        expect((error as InvalidReferenceError).failureCode).toBe(
          FailureCode.ReferenceNotSupported,
        );
      }
    },
  );

  test('WIN aceita referência sem exigi-la', () => {
    const withReference = transaction({
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: 'ext-bet',
    });
    const without = transaction({ kind: WagerTransactionKind.Win });

    expect(withReference.requiresReference()).toBe(false);
    expect(without.referenceExternalTransactionId).toBeUndefined();
  });
});

describe('valores monetários submetidos', () => {
  test.each([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
  ] as const)('%s de valor zero é rejeitado com INVALID_AMOUNT', (kind) => {
    try {
      transaction({ kind, money: brl('0.00') });
      throw new Error('expected the creation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidAmountError);
      expect((error as InvalidAmountError).failureCode).toBe(FailureCode.InvalidAmount);
    }
  });

  test('LOSS aceita valor zero por não mover saldo', () => {
    const loss = transaction({ kind: WagerTransactionKind.Loss, money: brl('0.00') });

    expect(loss.affectsBalance()).toBe(false);
    expect(loss.money.isZero()).toBe(true);
  });

  test('valor negativo nunca é aceito na criação', () => {
    const negative = brl('0.00').subtract(brl('25.00'));

    expect(() => transaction({ money: negative })).toThrow(InvalidAmountError);
    expect(() => transaction({ kind: WagerTransactionKind.Loss, money: negative })).toThrow(
      InvalidAmountError,
    );
  });
});

describe('transições', () => {
  test('PENDING avança para PROCESSED registrando o instante', () => {
    const bet = transaction();
    bet.markProcessed(undefined, LATER);

    expect(bet.status).toBe(WagerTransactionStatus.Processed);
    expect(bet.processedAt?.toISOString()).toBe(LATER.toISOString());
    expect(bet.isTerminal()).toBe(true);
  });

  test('PENDING avança para PENDING_REFERENCE e depois para PROCESSED', () => {
    const refund = transaction({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-bet',
    });

    refund.markPendingReference();
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refund.isTerminal()).toBe(false);

    refund.markProcessed('tx-bet', LATER);
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.referenceTransactionId).toBe('tx-bet');
  });

  test('PENDING_REFERENCE não se repete', () => {
    const refund = transaction({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-bet',
    });

    refund.markPendingReference();

    expect(() => refund.markPendingReference()).toThrow(InvalidTransactionStateError);
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
  });

  test('operações que não dependem de referência nunca ficam PENDING_REFERENCE', () => {
    expect(() => transaction().markPendingReference()).toThrow(InvalidInputError);
    expect(() =>
      transaction({ kind: WagerTransactionKind.Win }).markPendingReference(),
    ).toThrow(InvalidInputError);
  });

  test('reject registra uma rejeição de negócio e encerra a transação', () => {
    const rejected = transaction();
    rejected.reject(FailureCode.InsufficientFunds);

    expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(rejected.isTerminal()).toBe(true);
  });

  test('fail registra uma falha permanente de infraestrutura', () => {
    const failed = transaction();
    failed.fail(InfrastructureFailureCode.PermanentInfrastructureFailure);

    expect(failed.status).toBe(WagerTransactionStatus.Failed);
    expect(failed.failureCode).toBe(InfrastructureFailureCode.PermanentInfrastructureFailure);
    expect(failed.isTerminal()).toBe(true);
  });

  test('os espaços de código de rejeição e de falha técnica são disjuntos', () => {
    const business: readonly string[] = Object.values(FailureCode);
    const technical: readonly string[] = Object.values(InfrastructureFailureCode);

    // Nenhum código pode significar as duas coisas: `fail(INSUFFICIENT_FUNDS)`
    // não compila, e a separação precisa continuar valendo no dado persistido.
    expect(technical.some((code) => business.includes(code))).toBe(false);
    expect(business.length).toBeGreaterThan(0);
    expect(technical.length).toBeGreaterThan(0);
  });

  const terminals = [
    ['PROCESSED', () => processedTransaction()],
    [
      'REJECTED',
      () => {
        const tx = transaction();
        tx.reject(FailureCode.InsufficientFunds);
        return tx;
      },
    ],
    [
      'FAILED',
      () => {
        const tx = transaction();
        tx.fail(InfrastructureFailureCode.PermanentInfrastructureFailure);
        return tx;
      },
    ],
  ] as const;

  const transitions = [
    ['markProcessed', (tx: WagerTransaction) => { tx.markProcessed(undefined, LATER); }],
    ['reject', (tx: WagerTransaction) => { tx.reject(FailureCode.InsufficientFunds); }],
    ['fail', (tx: WagerTransaction) => { tx.fail(InfrastructureFailureCode.PermanentInfrastructureFailure); }],
    ['markPendingReference', (tx: WagerTransaction) => { tx.markPendingReference(); }],
  ] as const;

  for (const [statusName, build] of terminals) {
    for (const [transitionName, transition] of transitions) {
      test(`${statusName} não aceita ${transitionName}`, () => {
        const terminal = build();
        const status = terminal.status;
        const failureCode = terminal.failureCode;

        expect(() => { transition(terminal); }).toThrow(InvalidTransactionStateError);
        expect(terminal.status).toBe(status);
        expect(terminal.failureCode).toBe(failureCode);
      });
    }
  }
});

describe('consistência dos dados de estado', () => {
  test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback] as const)(
    '%s não é processado sem o id interno da referência',
    (kind) => {
      const reversal = transaction({ kind, referenceExternalTransactionId: 'ext-bet' });

      expect(() => reversal.markProcessed(undefined, LATER)).toThrow(InvalidInputError);
      expect(reversal.status).toBe(WagerTransactionStatus.Pending);
    },
  );

  test.each([WagerTransactionKind.Bet, WagerTransactionKind.Loss] as const)(
    '%s não pode ser vinculado a uma referência ao ser processado',
    (kind) => {
      const tx = transaction({ kind });

      expect(() => tx.markProcessed('tx-bet', LATER)).toThrow(InvalidInputError);
      expect(tx.status).toBe(WagerTransactionStatus.Pending);
    },
  );

  test('WIN pode ser processado com ou sem referência resolvida', () => {
    const linked = transaction({
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: 'ext-bet',
    });
    linked.markProcessed('tx-bet', LATER);

    const standalone = transaction({ kind: WagerTransactionKind.Win });
    standalone.markProcessed(undefined, LATER);

    expect(linked.referenceTransactionId).toBe('tx-bet');
    expect(standalone.referenceTransactionId).toBeUndefined();
  });

  test('WIN submetido com referência externa não é processado sem a interna', () => {
    const win = transaction({
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: 'ext-bet',
    });

    expect(() => win.markProcessed(undefined, LATER)).toThrow(InvalidInputError);
    expect(win.status).toBe(WagerTransactionStatus.Pending);
    expect(win.referenceTransactionId).toBeUndefined();
  });

  test('WIN submetido sem referência externa não recebe uma referência interna', () => {
    const win = transaction({ kind: WagerTransactionKind.Win });

    expect(() => win.markProcessed('tx-bet', LATER)).toThrow(InvalidInputError);
    expect(win.status).toBe(WagerTransactionStatus.Pending);
  });

  test('a referência interna é exigida exatamente quando há referência externa', () => {
    const cases = [
      { kind: WagerTransactionKind.Bet, external: undefined },
      { kind: WagerTransactionKind.Loss, external: undefined },
      { kind: WagerTransactionKind.Win, external: undefined },
      { kind: WagerTransactionKind.Win, external: 'ext-bet' },
      { kind: WagerTransactionKind.Refund, external: 'ext-bet' },
      { kind: WagerTransactionKind.Rollback, external: 'ext-bet' },
    ] as const;

    for (const { kind, external } of cases) {
      const tx = transaction({ kind, referenceExternalTransactionId: external });
      const internal = external === undefined ? undefined : 'tx-reference';

      tx.markProcessed(internal, LATER);

      expect(tx.status).toBe(WagerTransactionStatus.Processed);
      expect(tx.referenceTransactionId === undefined).toBe(external === undefined);
    }
  });

  test('as datas expostas não permitem alterar o estado interno', () => {
    const createdAt = new Date(AT.getTime());
    const bet = transaction({ createdAt });
    bet.markProcessed(undefined, LATER);

    createdAt.setFullYear(1999);
    bet.createdAt.setFullYear(1999);
    bet.processedAt?.setFullYear(1999);

    expect(bet.createdAt.toISOString()).toBe(AT.toISOString());
    expect(bet.processedAt?.toISOString()).toBe(LATER.toISOString());
  });
});

describe('consultas de domínio', () => {
  test('matchesPayload compara o hash recebido', () => {
    const bet = transaction({ payloadHash: 'hash-abc' });

    expect(bet.matchesPayload('hash-abc')).toBe(true);
    expect(bet.matchesPayload('hash-xyz')).toBe(false);
  });

  test('somente LOSS não afeta o saldo', () => {
    expect(transaction().affectsBalance()).toBe(true);
    expect(transaction({ kind: WagerTransactionKind.Win }).affectsBalance()).toBe(true);
    expect(transaction({ kind: WagerTransactionKind.Loss }).affectsBalance()).toBe(false);
  });

  test.each([
    [WagerTransactionKind.Bet, LedgerDirection.Debit],
    [WagerTransactionKind.Win, LedgerDirection.Credit],
  ] as const)('a direção de %s é %s', (kind, direction) => {
    expect(transaction({ kind }).ledgerDirectionFor()).toBe(direction);
  });

  test('REFUND credita a wallet', () => {
    const refund = transaction({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-bet',
    });

    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('LOSS não produz lançamento', () => {
    expect(() => transaction({ kind: WagerTransactionKind.Loss }).ledgerDirectionFor()).toThrow(
      InvalidInputError,
    );
  });

  test.each([
    [WagerTransactionKind.Bet, LedgerDirection.Credit],
    [WagerTransactionKind.Win, LedgerDirection.Debit],
    [WagerTransactionKind.Refund, LedgerDirection.Debit],
  ] as const)('ROLLBACK de %s produz %s', (referencedKind, direction) => {
    const reference = processedTransaction({
      id: 'tx-reference',
      externalTransactionId: 'ext-reference',
      idempotencyKey: 'provider-a:ext-reference',
      kind: referencedKind,
      referenceExternalTransactionId:
        referencedKind === WagerTransactionKind.Refund ? 'ext-bet' : undefined,
    });
    const rollback = transaction({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'ext-reference',
    });

    expect(rollback.ledgerDirectionFor(reference)).toBe(direction);
  });

  test('ROLLBACK sem referência não determina direção', () => {
    const rollback = transaction({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'ext-bet',
    });

    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidInputError);
  });
});

describe('rehydrate', () => {
  test('reconstrói uma transação terminal sem reexecutar validações', () => {
    const restored = WagerTransaction.rehydrate({
      id: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'provider-a:ext-1',
      payloadHash: 'hash-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: brl('25.00'),
      referenceExternalTransactionId: 'ext-bet',
      createdAt: AT,
      status: WagerTransactionStatus.Processed,
      referenceTransactionId: 'tx-bet',
      failureCode: undefined,
      processedAt: LATER,
    });

    expect(restored.status).toBe(WagerTransactionStatus.Processed);
    expect(restored.referenceTransactionId).toBe('tx-bet');
    expect(restored.processedAt?.toISOString()).toBe(LATER.toISOString());
    expect(restored.isTerminal()).toBe(true);
    expect(() => restored.markProcessed('tx-bet', LATER)).toThrow(InvalidTransactionStateError);
  });

  test('preserva um estado rejeitado com seu failureCode', () => {
    const restored = WagerTransaction.rehydrate({
      id: 'tx-2',
      providerId: 'provider-a',
      externalTransactionId: 'ext-2',
      idempotencyKey: 'provider-a:ext-2',
      payloadHash: 'hash-2',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: brl('25.00'),
      referenceExternalTransactionId: undefined,
      createdAt: AT,
      status: WagerTransactionStatus.Rejected,
      referenceTransactionId: undefined,
      failureCode: FailureCode.InsufficientFunds,
      processedAt: undefined,
    });

    expect(restored.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(restored.processedAt).toBeUndefined();
  });
});
