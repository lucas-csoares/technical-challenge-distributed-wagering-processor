import { Money } from '../../src/domain/shared/money.js';
import { Wallet, type WalletOpening } from '../../src/domain/wallet/wallet.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  type CreateWagerTransactionProps,
} from '../../src/domain/wagering/wager-transaction.js';

/** Instante fixo: o domínio nunca lê o relógio, quem chama fornece a data. */
export const AT = new Date('2026-09-06T12:00:00.000Z');
export const LATER = new Date('2026-09-06T12:05:00.000Z');

export function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

export function usd(amount: string): Money {
  return Money.from({ amount, currency: 'USD' });
}

export function openWallet(initialBalance = '100.00'): WalletOpening {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initialBalance),
    openedAt: AT,
  });
}

export function transaction(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    createdAt: AT,
    ...overrides,
  });
}

/** Transação já aplicada, como as referências resolvidas do banco estariam. */
export function processedTransaction(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const created = transaction(overrides);
  created.markProcessed(created.requiresReference() ? 'tx-reference' : undefined, AT);

  return created;
}
