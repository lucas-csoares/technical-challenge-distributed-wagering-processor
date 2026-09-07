import {
  Body,
  Controller,
  Get,
  HttpCode,
  Headers,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MetricsPort } from '../../application/ports/metrics.js';
import { CreateWalletUseCase } from '../../application/create-wallet.use-case.js';
import {
  GetWalletLedgerQuery,
  GetWalletQuery,
  type LedgerPageView,
  type WalletView,
} from '../../application/queries/financial-queries.js';
import {
  ReconcileWalletUseCase,
  type WalletReconciliation,
} from '../../application/reconcile-wallet.use-case.js';
import { correlationIdFrom, CORRELATION_HEADER } from './correlation.js';
import { ProviderIdentityGuard } from './provider-identity.guard.js';
import { parseCreateWalletRequest } from './dto/financial-requests.js';
import { optionalPositiveInteger } from './dto/request-parsing.js';

interface CreateWalletResponse {
  readonly id: string;
  readonly playerId: string;
  readonly balance: { readonly amount: string; readonly currency: string };
  readonly version: number;
}

/**
 * Adaptador HTTP das wallets.
 *
 * O controller lê, valida o contrato, delega e mapeia a resposta. Aritmética
 * monetária, abertura com `OPENING`, reconstrução do ledger e paginação vivem
 * na camada de aplicação; nada aqui conhece MikroORM nem SQL.
 */
@Controller('wallets')
@UseGuards(ProviderIdentityGuard)
export class WalletsController {
  private readonly logger = new Logger(WalletsController.name);

  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletQuery,
    private readonly getLedger: GetWalletLedgerQuery,
    private readonly reconcileWallet: ReconcileWalletUseCase,
    private readonly metrics: MetricsPort,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() payload: unknown): Promise<CreateWalletResponse> {
    const command = parseCreateWalletRequest(payload);
    const result = await this.createWallet.execute(command);

    return {
      id: result.walletId,
      playerId: result.playerId,
      balance: result.balance,
      version: result.version,
    };
  }

  @Get(':walletId')
  async findById(@Param('walletId') walletId: string): Promise<WalletView> {
    const wallet = await this.getWallet.execute(walletId);

    if (wallet === undefined) {
      throw new NotFoundException('Wallet was not found.');
    }

    return wallet;
  }

  @Get(':walletId/ledger')
  async findLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<LedgerPageView> {
    const page = await this.getLedger.execute({
      walletId,
      cursor,
      limit: optionalPositiveInteger(limit, 'limit'),
    });

    if (page === undefined) {
      throw new NotFoundException('Wallet was not found.');
    }

    return page;
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(
    @Param('walletId') walletId: string,
    @Headers(CORRELATION_HEADER) correlation?: string,
  ): Promise<WalletReconciliation> {
    const reconciliation = await this.reconcileWallet.execute(walletId);

    if (reconciliation === undefined) {
      throw new NotFoundException('Wallet was not found.');
    }

    // Divergência é reportada, nunca corrigida: `consistent` fica falso, a
    // diferença aparece na resposta, o fato é logado e a métrica é incrementada.
    // Um saldo divergente corrigido em silêncio destrói a evidência do bug.
    if (!reconciliation.consistent) {
      this.metrics.recordReconciliationDivergence();
      this.logger.error({
        event: 'wallet.reconciliation.divergent',
        correlationId: correlationIdFrom(correlation),
        walletId,
        difference: reconciliation.difference.amount,
        currency: reconciliation.difference.currency,
        checkedEntries: reconciliation.checkedEntries,
      });
    }

    return reconciliation;
  }
}
