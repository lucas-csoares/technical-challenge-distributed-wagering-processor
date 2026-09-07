import { Wallet } from '../domain/wallet/wallet.js';
import { WalletLedgerEntry } from '../domain/wallet/wallet-ledger-entry.js';
import { WagerTransaction } from '../domain/wagering/wager-transaction.js';
import { Money, type MoneyProps } from '../domain/shared/money.js';
import { FinancialTransactionManager } from './ports/financial-transaction-manager.js';
import { WalletAlreadyExistsError } from './financial-errors.js';
import { isUniqueConstraint } from './ports/persistence-error.js';

export interface CreateWalletCommand {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
}

/** Descreve a wallet recém-criada por inteiro, para que o transporte não releia o banco. */
export interface CreateWalletResult {
  readonly walletId: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
}
export interface UseCaseRuntime {
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export class CreateWalletUseCase {
  constructor(
    private readonly transactions: FinancialTransactionManager,
    private readonly runtime: UseCaseRuntime = {},
  ) {}

  async execute(command: CreateWalletCommand): Promise<CreateWalletResult> {
    const initialBalance = Money.from(command.initialBalance);
    const openedAt = this.now();
    const newId = this.newId;

    try {
      return await this.transactions.execute(async (scope) => {
        const existingWallet = await scope.wallets.findByPlayerAndCurrency(
          command.playerId,
          initialBalance.currency,
        );

        if (existingWallet !== undefined) {
          throw new WalletAlreadyExistsError();
        }

        const opening = Wallet.open({
          id: newId(),
          playerId: command.playerId,
          initialBalance,
          openedAt,
        });
        await scope.wallets.save(opening.wallet);

        if (opening.movement !== undefined) {
          const transaction = WagerTransaction.createOpening({
            id: newId(),
            walletId: opening.wallet.id,
            playerId: command.playerId,
            money: initialBalance,
            createdAt: openedAt,
          });

          transaction.markProcessed(undefined, openedAt);
          transaction.recordResultBalance(opening.wallet.balance);
          await scope.transactions.save(transaction);
          await scope.ledger.append(
            WalletLedgerEntry.create({
              id: newId(),
              transactionId: transaction.id,
              createdAt: openedAt,
              ...opening.movement,
            }),
          );
        }

        return {
          walletId: opening.wallet.id,
          playerId: opening.wallet.playerId,
          balance: opening.wallet.balance.toJSON(),
          version: opening.wallet.version,
        };
      });
    } catch (error) {
      if (isUniqueConstraint(error, 'wallets_player_currency_unique')) {
        throw new WalletAlreadyExistsError();
      }

      throw error;
    }
  }

  private now = (): Date => (this.runtime.now ?? (() => new Date()))();
  private get newId(): () => string {
    return this.runtime.newId ?? (() => crypto.randomUUID());
  }
}
