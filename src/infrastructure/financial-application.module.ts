import { Module } from '@nestjs/common';
import { CreateWalletUseCase } from '../application/create-wallet.use-case.js';
import { FinancialTransactionManager } from '../application/ports/financial-transaction-manager.js';
import { ProcessWagerTransactionUseCase } from '../application/process-wager-transaction.use-case.js';
import {
  GetWagerTransactionQuery,
  GetWalletLedgerQuery,
  GetWalletQuery,
} from '../application/queries/financial-queries.js';
import { ReconcileWalletUseCase } from '../application/reconcile-wallet.use-case.js';
import { PersistenceModule } from './persistence/persistence.module.js';

/**
 * Composição dos casos de uso financeiros.
 *
 * Fica em um módulo próprio porque HTTP e mensageria consomem exatamente os
 * mesmos objetos — é a garantia estrutural de que os dois canais de entrada
 * compartilham o núcleo em vez de cada um construir o seu. As classes de
 * aplicação continuam sem decorators: quem sabe montá-las é a infraestrutura.
 */
@Module({
  imports: [PersistenceModule],
  providers: [
    {
      provide: CreateWalletUseCase,
      inject: [FinancialTransactionManager],
      useFactory: (transactions: FinancialTransactionManager) =>
        new CreateWalletUseCase(transactions),
    },
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [FinancialTransactionManager],
      useFactory: (transactions: FinancialTransactionManager) =>
        new ProcessWagerTransactionUseCase(transactions),
    },
    {
      provide: GetWalletQuery,
      inject: [FinancialTransactionManager],
      useFactory: (transactions: FinancialTransactionManager) => new GetWalletQuery(transactions),
    },
    {
      provide: GetWalletLedgerQuery,
      inject: [FinancialTransactionManager],
      useFactory: (transactions: FinancialTransactionManager) =>
        new GetWalletLedgerQuery(transactions),
    },
    {
      provide: GetWagerTransactionQuery,
      inject: [FinancialTransactionManager],
      useFactory: (transactions: FinancialTransactionManager) =>
        new GetWagerTransactionQuery(transactions),
    },
    {
      provide: ReconcileWalletUseCase,
      inject: [FinancialTransactionManager],
      useFactory: (transactions: FinancialTransactionManager) =>
        new ReconcileWalletUseCase(transactions),
    },
  ],
  exports: [
    CreateWalletUseCase,
    ProcessWagerTransactionUseCase,
    GetWalletQuery,
    GetWalletLedgerQuery,
    GetWagerTransactionQuery,
    ReconcileWalletUseCase,
  ],
})
export class FinancialApplicationModule {}
