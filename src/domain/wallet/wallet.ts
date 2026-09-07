import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidInputError,
} from '../shared/domain-error.js';
import { assertIdentifier, cloneInstant, toInstant } from '../shared/guards.js';
import { Money } from '../shared/money.js';
import { LedgerDirection } from './ledger-direction.js';

/**
 * Efeito de uma movimentação aceita pela wallet.
 *
 * Carrega exatamente os dados que o lançamento correspondente do ledger
 * precisa, de modo que saldo e ledger não possam divergir por descuido de
 * quem orquestra a operação. A persistência atômica desse par é
 * responsabilidade da aplicação e do PostgreSQL — nada aqui, em memória,
 * garante atomicidade.
 */
export interface WalletMovement {
  readonly walletId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
}

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly openedAt: Date;
}

/**
 * Resultado da abertura de uma wallet.
 *
 * `movement` descreve o crédito de abertura (de zero até o saldo inicial) e é
 * `undefined` quando a wallet abre zerada. A `version` permanece `1` nos dois
 * casos: a abertura é a criação da wallet, não uma alteração posterior de
 * saldo. Compor `Wallet`, a `WagerTransaction` interna `OPENING` e o
 * `WalletLedgerEntry` em uma única transação SQL é trabalho do caso de uso.
 */
export interface WalletOpening {
  readonly wallet: Wallet;
  readonly movement: WalletMovement | undefined;
}

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Aggregate root do saldo materializado de um jogador em uma moeda. */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): WalletOpening {
    assertIdentifier(props.id, 'id');
    assertIdentifier(props.playerId, 'playerId');

    const initialBalance = props.initialBalance;

    if (initialBalance.isNegative()) {
      throw new InvalidInputError('initialBalance must not be negative.');
    }

    const openedAt = toInstant(props.openedAt, 'openedAt');
    const currency = initialBalance.currency;

    const wallet = new Wallet(
      props.id,
      props.playerId,
      currency,
      initialBalance,
      1,
      openedAt,
      openedAt,
    );

    const movement: WalletMovement | undefined = initialBalance.isPositive()
      ? {
          walletId: wallet.id,
          direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: Money.zero(currency),
          balanceAfter: initialBalance,
        }
      : undefined;

    return { wallet, movement };
  }

  /** Reconstrói estado já persistido: não revalida regras nem move o saldo. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      cloneInstant(state.createdAt),
      cloneInstant(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return cloneInstant(this._createdAt);
  }

  get updatedAt(): Date {
    return cloneInstant(this._updatedAt);
  }

  debit(money: Money, at: Date): WalletMovement {
    const appliedAt = this.assertMovementIsApplicable(money, at);
    const balanceBefore = this._balance;

    if (balanceBefore.isLessThan(money)) {
      throw new InsufficientFundsError();
    }

    return this.apply(LedgerDirection.Debit, money, balanceBefore.subtract(money), appliedAt);
  }

  credit(money: Money, at: Date): WalletMovement {
    const appliedAt = this.assertMovementIsApplicable(money, at);
    const balanceBefore = this._balance;

    return this.apply(LedgerDirection.Credit, money, balanceBefore.add(money), appliedAt);
  }

  /**
   * Toda validação acontece antes de qualquer atribuição, de forma que uma
   * movimentação recusada não deixe a wallet parcialmente alterada.
   */
  private assertMovementIsApplicable(money: Money, at: Date): Date {
    this.assertSameCurrency(money);

    if (!money.isPositive()) {
      throw new InvalidInputError('A wallet movement must be a positive amount.');
    }

    return toInstant(at, 'at');
  }

  private apply(
    direction: LedgerDirection,
    money: Money,
    balanceAfter: Money,
    at: Date,
  ): WalletMovement {
    const balanceBefore = this._balance;

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;

    return { walletId: this.id, direction, money, balanceBefore, balanceAfter };
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
