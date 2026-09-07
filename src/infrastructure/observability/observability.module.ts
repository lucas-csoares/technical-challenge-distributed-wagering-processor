import { Module } from '@nestjs/common';
import { MetricsPort } from '../../application/ports/metrics.js';
import { MetricsController } from './metrics.controller.js';
import { PrometheusMetrics } from './prometheus-metrics.js';

/**
 * Observabilidade.
 *
 * Não importa nenhum outro módulo de propósito: persistência e mensageria
 * dependem dela, e uma dependência de volta fecharia um ciclo. O que precisa
 * olhar para fora — a profundidade da DLQ — é ligado pela mensageria, que já
 * conhece o broker.
 */
@Module({
  providers: [
    { provide: PrometheusMetrics, useFactory: () => new PrometheusMetrics() },
    { provide: MetricsPort, useExisting: PrometheusMetrics },
  ],
  controllers: [MetricsController],
  exports: [PrometheusMetrics, MetricsPort],
})
export class ObservabilityModule {}
