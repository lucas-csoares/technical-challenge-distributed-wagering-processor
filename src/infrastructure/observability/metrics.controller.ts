import { Controller, Get, Header } from '@nestjs/common';
import { PROMETHEUS_CONTENT_TYPE, PrometheusMetrics } from './prometheus-metrics.js';

/**
 * Endpoint operacional de métricas.
 *
 * Fica público, como os health checks: é um endpoint de plataforma, consumido
 * por um coletor que roda ao lado do serviço, e exigir autenticação nele
 * quebraria a coleta sem proteger nada de valor — não há dado financeiro aqui,
 * apenas contadores agregados sem identificadores.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: PrometheusMetrics) {}

  @Get()
  @Header('content-type', PROMETHEUS_CONTENT_TYPE)
  @Header('cache-control', 'no-store')
  async scrape(): Promise<string> {
    return this.metrics.scrape();
  }
}
