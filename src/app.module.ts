import { Module } from '@nestjs/common';
import { HttpModule } from './infrastructure/http/http.module.js';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';

@Module({ imports: [PersistenceModule, HttpModule] })
export class AppModule {}
