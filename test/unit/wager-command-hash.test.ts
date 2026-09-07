import { expect, test } from 'bun:test';
import { canonicalizeWagerCommand, hashWagerCommand, type ProcessWagerTransactionCommand } from '../../src/application/process-wager-transaction.use-case.js';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction.js';

const command = (overrides: Partial<ProcessWagerTransactionCommand> = {}): ProcessWagerTransactionCommand => ({ providerId: 'provider', externalTransactionId: 'external', idempotencyKey: 'key-a', walletId: 'wallet', playerId: 'player', roundId: 'round', gameId: 'game', kind: WagerTransactionKind.Bet, money: { amount: '25.00', currency: 'BRL' }, ...overrides });
test('canonicalização ignora idempotencyKey e inclui os campos de negócio', () => {
  expect(canonicalizeWagerCommand(command())).toBe(canonicalizeWagerCommand(command({ idempotencyKey: 'key-b' })));
  expect(hashWagerCommand(command())).toBe(hashWagerCommand(command({ idempotencyKey: 'key-b' })));
  expect(hashWagerCommand(command())).not.toBe(hashWagerCommand(command({ money: { amount: '26.00', currency: 'BRL' } })));
  expect(hashWagerCommand(command())).not.toBe(hashWagerCommand(command({ referenceExternalTransactionId: 'reference' })));
});
