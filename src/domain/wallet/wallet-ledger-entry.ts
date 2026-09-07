import { CurrencyMismatchError, InvalidInputError } from '../shared/domain-error.js';
import { assertIdentifier, cloneInstant, toInstant } from '../shared/guards.js';
import { Money } from '../shared/money.js';
import { LedgerDirection } from './ledger-direction.js';
import type { WalletMovement } from './wallet.js';

export interface CreateLedgerEntryProps extends WalletMovement {
  readonly id: string;
  readonly transactionId: string;
  readonly createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Lançamento imutável do ledger.
 *
 * A imutabilidade é estrutural: não há campos mutáveis, métodos de transição
 * nem exposição de referências mutáveis — `createdAt` é copiado na entrada e
 * na leitura, para que ninguém altere um lançamento pela `Date` que passou.
 *
 * Unicidade (um lançamento por transação e wallet) e a proibição de `UPDATE`,
 * `DELETE` e `TRUNCATE` também são protegidas pela migration financeira.
 */
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    private readonly _createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    assertIdentifier(props.id, 'id');
    assertIdentifier(props.walletId, 'walletId');
    assertIdentifier(props.transactionId, 'transactionId');

    const { money, balanceBefore, balanceAfter } = props;

    if (!money.isPositive()) {
      throw new InvalidInputError('A ledger entry must record a positive amount.');
    }

    assertSameCurrency(money.currency, balanceBefore.currency);
    assertSameCurrency(money.currency, balanceAfter.currency);

    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidInputError('Ledger balances must not be negative.');
    }

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      money,
      balanceBefore,
      balanceAfter,
      toInstant(props.createdAt, 'createdAt'),
    );

    if (!entry.isBalanced()) {
      throw new InvalidInputError('balanceBefore does not match balanceAfter for this movement.');
    }

    return entry;
  }

  /** Reconstrói um lançamento já persistido, sem revalidar sua aritmética. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      cloneInstant(state.createdAt),
    );
  }

  get createdAt(): Date {
    return cloneInstant(this._createdAt);
  }

  /** `balanceBefore ± money === balanceAfter`, verificado na factory `create`. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);

    return expected.equals(this.balanceAfter);
  }
}

function assertSameCurrency(expected: string, received: string): void {
  if (expected !== received) {
    throw new CurrencyMismatchError(expected, received);
  }
}
