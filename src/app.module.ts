import { Module } from '@nestjs/common';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';

@Module({ imports: [PersistenceModule] })
export class AppModule {}
