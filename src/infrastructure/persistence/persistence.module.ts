import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { createDatabaseOptions } from './database.config.js';

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      useFactory: () => createDatabaseOptions(),
    }),
  ],
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
