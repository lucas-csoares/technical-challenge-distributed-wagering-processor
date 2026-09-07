import type { HttpResponse } from './http-response.js';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { MetricsPort } from '../../application/ports/metrics.js';
import {
  GetWagerTransactionQuery,
  type WagerTransactionView,
} from '../../application/queries/financial-queries.js';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionResult,
} from '../../application/process-wager-transaction.use-case.js';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction.js';
import { correlationIdFrom, CORRELATION_HEADER } from './correlation.js';
import { ProviderIdentityGuard } from './provider-identity.guard.js';
import { parseWagerTransactionRequest } from './dto/financial-requests.js';

/**
 * Adaptador HTTP do processamento de wagering.
 *
 * Reutiliza `ProcessWagerTransactionUseCase` sem reimplementar nada: a
 * idempotência, o hash canônico, a resolução de referência e o locking já
 * acontecem lá. O consumidor SQS da próxima etapa entrará pelo mesmo caso de
 * uso, o que é justamente o motivo de o controller ser tão fino.
 */
@Controller()
@UseGuards(ProviderIdentityGuard)
export class WageringController {
  private readonly logger = new Logger(WageringController.name);

  constructor(
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly getTransaction: GetWagerTransactionQuery,
    private readonly metrics: MetricsPort,
  ) {}

  /**
   * O status distingue o desfecho para que o provedor decida sem ler mensagem:
   * `PROCESSED` responde 200, `PENDING_REFERENCE` 202 (aceito, aguardando a
   * referência) e `REJECTED` 422 (rejeição de negócio, com `failureCode`).
   */
  @Post('wagering/transactions')
  async process(
    @Body() payload: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers(CORRELATION_HEADER) correlation: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ProcessWagerTransactionResult> {
    const command = parseWagerTransactionRequest(payload, idempotencyKey);
    const correlationId = correlationIdFrom(correlation);
    const startedAt = performance.now();
    const result = await this.processWager.execute(command, { correlationId });

    this.record(command.providerId, command.walletId, correlationId, result, startedAt);
    response.status(statusFor(result.status));

    return result;
  }

  /**
   * O log leva identidade e desfecho, nunca o corpo da requisição nem o valor
   * movimentado: diagnóstico precisa saber *qual* operação, não *quanto* ela
   * moveu — e um payload financeiro completo em log é exatamente o que não deve
   * existir.
   */
  private record(
    providerId: string,
    walletId: string,
    correlationId: string,
    result: ProcessWagerTransactionResult,
    startedAt: number,
  ): void {
    this.metrics.recordWagerTransaction(result.status, 'http');
    this.metrics.observeWagerProcessing('http', (performance.now() - startedAt) / 1_000);

    if (result.idempotentReplay) {
      this.metrics.recordDuplicate('financial_idempotency');
    }

    this.logger.log({
      event: 'wager.processed',
      correlationId,
      providerId,
      walletId,
      transactionId: result.transactionId,
      status: result.status,
      failureCode: result.failureCode,
      idempotentReplay: result.idempotentReplay,
    });
  }

  @Get('wagering/transactions/:transactionId')
  async findById(@Param('transactionId') transactionId: string): Promise<WagerTransactionView> {
    return required(await this.getTransaction.execute(transactionId));
  }

  /** A identidade é do par `(providerId, externalTransactionId)`. */
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async findByExternalIdentity(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return required(
      await this.getTransaction.executeByExternalIdentity(providerId, externalTransactionId),
    );
  }
}

function statusFor(status: WagerTransactionStatus): HttpStatus {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return HttpStatus.OK;
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;
    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.Failed:
      // Nenhum dos dois é resposta de uma requisição concluída: `PENDING` não
      // sobrevive à transação e `FAILED` é falha técnica permanente.
      return HttpStatus.SERVICE_UNAVAILABLE;
  }
}

function required(view: WagerTransactionView | undefined): WagerTransactionView {
  if (view === undefined) {
    throw new NotFoundException('Wager transaction was not found.');
  }

  return view;
}
