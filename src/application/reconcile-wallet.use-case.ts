import { Money, type MoneyProps } from '../domain/shared/money.js';
import { LedgerDirection } from '../domain/wallet/ledger-direction.js';
import { FinancialTransactionManager } from './ports/financial-transaction-manager.js';

export interface WalletReconciliation {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

/**
 * Compara o saldo materializado da wallet com o saldo reconstruído pelo ledger.
 *
 * A reconciliação **detecta e relata**; ela nunca corrige. Uma divergência
 * indica que uma invariante foi violada em algum ponto, e sobrescrever o saldo
 * apagaria a evidência exatamente quando ela é mais necessária. A correção,
 * quando cabível, é uma operação financeira nova e auditável.
 *
 * A leitura roda em `REPEATABLE READ`. Wallet e ledger são consultados em
 * statements diferentes, e sob `READ COMMITTED` cada um veria um snapshot
 * próprio: uma operação confirmada no intervalo faria a comparação acusar uma
 * divergência que nunca existiu. O snapshot único elimina esse falso positivo
 * sem bloquear ninguém — não há lock exclusivo aqui, porque nada é escrito e
 * segurar a wallet penalizaria o processamento por uma consulta de auditoria.
 */
export class ReconcileWalletUseCase {
  constructor(private readonly transactions: FinancialTransactionManager) {}

  async execute(walletId: string): Promise<WalletReconciliation | undefined> {
    return this.transactions.execute(
      async (scope) => {
        const wallet = await scope.wallets.findById(walletId);

        if (wallet === undefined) {
          return undefined;
        }

        const entries = await scope.ledger.findByWalletId(walletId);
        const calculated = entries.reduce(
          (balance, entry) =>
            entry.direction === LedgerDirection.Credit
              ? balance.add(entry.money)
              : balance.subtract(entry.money),
          Money.zero(wallet.currency),
        );
        // Money mantém a subtração exata, inclusive quando o resultado é negativo.
        const difference = wallet.balance.subtract(calculated);

        return {
          walletId,
          storedBalance: wallet.balance.toJSON(),
          calculatedBalance: calculated.toJSON(),
          difference: difference.toJSON(),
          consistent: difference.isZero(),
          checkedEntries: entries.length,
        };
      },
      { isolationLevel: 'REPEATABLE READ' },
    );
  }
}
