import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { FinancialApplicationModule } from '../financial-application.module.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { FinancialExceptionFilter } from './financial-exception.filter.js';
import { HealthController } from './health.controller.js';
import { ProviderIdentityGuard } from './provider-identity.guard.js';
import { WageringController } from './wagering.controller.js';
import { WalletsController } from './wallets.controller.js';

/**
 * Composição do transporte HTTP.
 *
 * Importa a mesma composição de casos de uso que a mensageria usa, e depende
 * da mensageria apenas para o health check de readiness — a direção continua
 * apontando para dentro: infraestrutura conhece aplicação, nunca o contrário.
 */
@Module({
  imports: [PersistenceModule, FinancialApplicationModule, MessagingModule, ObservabilityModule],
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    ProviderIdentityGuard,
    { provide: APP_FILTER, useClass: FinancialExceptionFilter },
  ],
})
export class HttpModule {}
