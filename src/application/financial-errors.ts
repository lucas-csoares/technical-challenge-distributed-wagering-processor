export class IdempotencyConflictError extends Error { constructor() { super('Idempotency key was already used with another command.'); this.name = 'IdempotencyConflictError'; } }
export class ExternalTransactionConflictError extends Error { constructor() { super('External transaction identity was already used.'); this.name = 'ExternalTransactionConflictError'; } }
export class WalletNotFoundError extends Error { constructor() { super('Wallet was not found.'); this.name = 'WalletNotFoundError'; } }
export class WalletAlreadyExistsError extends Error { constructor() { super('A wallet already exists for this player and currency.'); this.name = 'WalletAlreadyExistsError'; } }
