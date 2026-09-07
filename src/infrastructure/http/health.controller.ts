import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { DatabaseHealth } from '../persistence/database-health.js';
import { SqsClientAdapter } from '../messaging/sqs/sqs-client.js';
import type { HttpResponse } from './http-response.js';

interface LivenessBody {
  readonly status: 'ok';
}

interface ReadinessBody {
  readonly status: 'ok' | 'degraded';
  readonly dependencies: Readonly<Record<string, 'ok' | 'unavailable'>>;
}

/**
 * Health checks públicos, sem autenticação, conforme o desafio.
 *
 * `live` responde sobre o processo e deliberadamente não toca no banco: um
 * orquestrador que reinicia o container porque o PostgreSQL oscilou só piora o
 * incidente. `ready` responde sobre a capacidade de atender tráfego e por isso
 * consulta as dependências de verdade.
 *
 * As dependências verificadas são o PostgreSQL e o SQS: são as duas de que a
 * aplicação precisa para atender tráfego e consumir a fila.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly database: DatabaseHealth,
    private readonly sqs: SqsClientAdapter,
  ) {}

  @Get('live')
  live(): LivenessBody {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: HttpResponse): Promise<ReadinessBody> {
    const [postgres, sqs] = await Promise.all([
      this.database.isReachable(),
      this.sqs.isReachable(),
    ]);
    const ready = postgres && sqs;

    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: ready ? 'ok' : 'degraded',
      dependencies: {
        postgres: postgres ? 'ok' : 'unavailable',
        sqs: sqs ? 'ok' : 'unavailable',
      },
    };
  }
}
