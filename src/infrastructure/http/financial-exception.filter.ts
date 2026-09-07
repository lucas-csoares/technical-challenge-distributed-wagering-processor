import type { HttpResponse } from './http-response.js';
import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/financial-errors.js';
import { InvalidLedgerCursorError } from '../../application/ledger-cursor.js';
import { FinancialPersistenceError } from '../../application/ports/persistence-error.js';
import { InvalidMoneyError, DomainError } from '../../domain/shared/domain-error.js';
import { InvalidRequestError } from './dto/request-parsing.js';

export interface HttpErrorBody {
  readonly code: string;
  readonly message: string;
}

interface MappedError {
  readonly status: HttpStatus;
  readonly body: HttpErrorBody;
}

/**
 * Tradução única de erro conhecido para HTTP.
 *
 * Concentrar isso aqui evita `try/catch` repetido em cada controller e, mais
 * importante, garante que nada de infraestrutura escape: `SQLSTATE`, nome de
 * constraint, `DriverException` e stack trace ficam no log, e o cliente recebe
 * apenas um código estável e uma mensagem própria.
 */
@Catch()
export class FinancialExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(FinancialExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const mapped = this.map(exception);

    if (mapped.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // A causa técnica fica no log; a resposta permanece genérica.
      this.logger.error(mapped.body.code, describeCause(exception));
    }

    response.status(mapped.status).json(mapped.body);
  }

  private map(exception: unknown): MappedError {
    if (exception instanceof InvalidRequestError || exception instanceof InvalidLedgerCursorError) {
      return badRequest(exception instanceof InvalidLedgerCursorError ? 'INVALID_CURSOR' : 'INVALID_REQUEST', exception.message);
    }

    // Valor monetário malformado é contrato inválido, não rejeição financeira.
    if (exception instanceof InvalidMoneyError) {
      return badRequest('INVALID_MONEY', exception.message);
    }

    if (exception instanceof WalletNotFoundError) {
      return { status: HttpStatus.NOT_FOUND, body: { code: 'WALLET_NOT_FOUND', message: exception.message } };
    }

    if (exception instanceof WalletAlreadyExistsError) {
      return { status: HttpStatus.CONFLICT, body: { code: 'WALLET_ALREADY_EXISTS', message: exception.message } };
    }

    if (exception instanceof IdempotencyConflictError) {
      return { status: HttpStatus.CONFLICT, body: { code: 'IDEMPOTENCY_CONFLICT', message: exception.message } };
    }

    if (exception instanceof ExternalTransactionConflictError) {
      return {
        status: HttpStatus.CONFLICT,
        body: { code: 'EXTERNAL_TRANSACTION_CONFLICT', message: exception.message },
      };
    }

    // Falha de persistência não decide se a operação pode ser repetida, mas é
    // transitória o suficiente para o provedor tentar de novo com a mesma key.
    if (exception instanceof FinancialPersistenceError) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        body: { code: 'SERVICE_UNAVAILABLE', message: 'The service is temporarily unavailable.' },
      };
    }

    // Erro de domínio que escapou é uso indevido da API interna, não do cliente.
    if (exception instanceof DomainError) {
      return badRequest('INVALID_REQUEST', exception.message);
    }

    if (exception instanceof HttpException) {
      return { status: exception.getStatus(), body: toHttpExceptionBody(exception) };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: 'INTERNAL_ERROR', message: 'Unexpected error.' },
    };
  }
}

function badRequest(code: string, message: string): MappedError {
  return { status: HttpStatus.BAD_REQUEST, body: { code, message } };
}

function toHttpExceptionBody(exception: HttpException): HttpErrorBody {
  const status: number = exception.getStatus();

  return {
    code: status === Number(HttpStatus.NOT_FOUND) ? 'NOT_FOUND' : 'REQUEST_FAILED',
    message: exception.message,
  };
}

function describeCause(exception: unknown): string {
  return exception instanceof Error ? `${exception.name}: ${exception.message}` : 'unknown error';
}
