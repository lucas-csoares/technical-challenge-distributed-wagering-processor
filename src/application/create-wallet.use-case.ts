import { Wallet } from '../domain/wallet/wallet.js';
import { WalletLedgerEntry } from '../domain/wallet/wallet-ledger-entry.js';
import { WagerTransaction } from '../domain/wagering/wager-transaction.js';
import { Money, type MoneyProps } from '../domain/shared/money.js';
import { FinancialTransactionManager } from './ports/financial-transaction-manager.js';
import { WalletAlreadyExistsError } from './financial-errors.js';
import { isUniqueConstraint } from './ports/persistence-error.js';

export interface CreateWalletCommand { readonly playerId: string; readonly initialBalance: MoneyProps; }

/** Descreve a wallet recém-criada por inteiro, para que o transporte não releia o banco. */
export interface CreateWalletResult {
  readonly walletId: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
}
export interface UseCaseRuntime { readonly now?: () => Date; readonly newId?: () => string; }

export class CreateWalletUseCase {
  constructor(private readonly transactions: FinancialTransactionManager, private readonly runtime: UseCaseRuntime = {}) {}
  async execute(command: CreateWalletCommand): Promise<CreateWalletResult> {
    const money = Money.from(command.initialBalance); const now = this.now(); const id = this.id;
    try { return await this.transactions.execute(async (scope) => {
      if (await scope.wallets.findByPlayerAndCurrency(command.playerId, money.currency)) throw new WalletAlreadyExistsError();
      const opening = Wallet.open({ id: id(), playerId: command.playerId, initialBalance: money, openedAt: now });
      await scope.wallets.save(opening.wallet);
      if (opening.movement) {
        const transaction = WagerTransaction.createOpening({ id: id(), walletId: opening.wallet.id, playerId: command.playerId, money, createdAt: now });
        transaction.markProcessed(undefined, now); transaction.recordResultBalance(opening.wallet.balance);
        await scope.transactions.save(transaction);
        await scope.ledger.append(WalletLedgerEntry.create({ id: id(), transactionId: transaction.id, createdAt: now, ...opening.movement }));
      }
      return {
        walletId: opening.wallet.id,
        playerId: opening.wallet.playerId,
        balance: opening.wallet.balance.toJSON(),
        version: opening.wallet.version,
      };
    }); } catch (error) {
      if (isUniqueConstraint(error, 'wallets_player_currency_unique')) throw new WalletAlreadyExistsError();
      throw error;
    }
  }
  private now = (): Date => (this.runtime.now ?? (() => new Date()))();
  private get id(): () => string { return this.runtime.newId ?? (() => crypto.randomUUID()); }
}
