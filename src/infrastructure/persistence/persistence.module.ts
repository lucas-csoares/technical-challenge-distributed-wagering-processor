import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { MetricsPort } from '../../application/ports/metrics.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { createDatabaseOptions } from './database.config.js';
import { FinancialTransactionManager } from '../../application/ports/financial-transaction-manager.js';
import { DatabaseHealth } from './database-health.js';
import { MikroOrmFinancialTransactionManager } from './mikro-orm-financial-transaction-manager.js';

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      useFactory: () => createDatabaseOptions(),
    }),
    ObservabilityModule,
  ],
  providers: [
    {
      provide: FinancialTransactionManager,
      inject: [MikroORM, MetricsPort],
      useFactory: (orm: MikroORM, metrics: MetricsPort) =>
        new MikroOrmFinancialTransactionManager(orm, metrics),
    },
    {
      provide: DatabaseHealth,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => new DatabaseHealth(orm),
    },
  ],
  exports: [FinancialTransactionManager, DatabaseHealth],
})
export class PersistenceModule implements OnModuleInit {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.orm.em.fork().execute('select 1');
    } catch {
      await this.orm.close();
      throw new Error('PostgreSQL connection failed. Check database configuration and availability.');
    }
  }
}
