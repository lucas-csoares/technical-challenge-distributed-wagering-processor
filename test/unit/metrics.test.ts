import { describe, expect, test } from 'bun:test';
import { NoopMetrics, type MetricsPort } from '../../src/application/ports/metrics.js';
import {
  PROMETHEUS_CONTENT_TYPE,
  PrometheusMetrics,
} from '../../src/infrastructure/observability/prometheus-metrics.js';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction.js';

/** Uma linha exata da exposição, sem depender da ordem do texto. */
function sampleOf(exposition: string, series: string): string | undefined {
  return exposition
    .split('\n')
    .find((line) => line.startsWith(`${series} `))
    ?.slice(series.length + 1);
}

describe('exposição Prometheus', () => {
  test('todas as métricas obrigatórias do desafio estão declaradas', async () => {
    const metrics = new PrometheusMetrics();

    // Registrar um valor de cada família: uma métrica só aparece na exposição
    // depois de observada, e o que importa é que todas existam de verdade.
    metrics.recordWagerTransaction(WagerTransactionStatus.Processed, 'http');
    metrics.observeWagerProcessing('http', 0.01);
    metrics.recordDuplicate('financial_idempotency');
    metrics.recordRetry('outbox');
    metrics.recordPermanentMessage('malformed');
    metrics.observeWalletLockWait(0.002);
    metrics.recordLockConflict('deadlock');
    metrics.observeOutboxPublishLag(0.5);
    metrics.setOutboxOldestPendingAge(2);
    metrics.recordReconciliationDivergence();
    metrics.bindDlqProbe(() => Promise.resolve(3));

    const exposition = await metrics.scrape();

    for (const name of [
      'wager_transactions_total',
      'wager_processing_duration_seconds',
      'wager_duplicates_total',
      'wager_retries_total',
      'wager_messages_permanent_total',
      'wager_dlq_messages',
      'wallet_lock_wait_seconds',
      'wallet_lock_conflicts_total',
      'outbox_publish_lag_seconds',
      'outbox_oldest_pending_age_seconds',
      'wallet_reconciliation_divergences_total',
    ]) {
      expect(exposition).toContain(`# TYPE ${name}`);
    }
  });

  test('transações são separadas por status e transporte', async () => {
    const metrics = new PrometheusMetrics();

    metrics.recordWagerTransaction(WagerTransactionStatus.Processed, 'http');
    metrics.recordWagerTransaction(WagerTransactionStatus.Processed, 'http');
    metrics.recordWagerTransaction(WagerTransactionStatus.Rejected, 'sqs');

    const exposition = await metrics.scrape();

    expect(sampleOf(exposition, 'wager_transactions_total{status="PROCESSED",transport="http"}')).toBe('2');
    expect(sampleOf(exposition, 'wager_transactions_total{status="REJECTED",transport="sqs"}')).toBe('1');
  });

  test('os dois níveis de deduplicação não são somados', async () => {
    const metrics = new PrometheusMetrics();

    metrics.recordDuplicate('financial_idempotency');
    metrics.recordDuplicate('inbox_redelivery');
    metrics.recordDuplicate('inbox_redelivery');

    const exposition = await metrics.scrape();

    expect(sampleOf(exposition, 'wager_duplicates_total{source="financial_idempotency"}')).toBe('1');
    expect(sampleOf(exposition, 'wager_duplicates_total{source="inbox_redelivery"}')).toBe('2');
  });

  test('conflito de payload não entra na conta de duplicatas', async () => {
    const metrics = new PrometheusMetrics();

    metrics.recordPermanentMessage('payload_conflict');

    const exposition = await metrics.scrape();

    expect(sampleOf(exposition, 'wager_messages_permanent_total{reason="payload_conflict"}')).toBe('1');
    expect(exposition).not.toContain('wager_duplicates_total{');
  });

  test('retries são separados por componente', async () => {
    const metrics = new PrometheusMetrics();

    metrics.recordRetry('sqs_consumer');
    metrics.recordRetry('outbox');
    metrics.recordRetry('pending_reference');

    const exposition = await metrics.scrape();

    for (const component of ['sqs_consumer', 'outbox', 'pending_reference']) {
      expect(sampleOf(exposition, `wager_retries_total{component="${component}"}`)).toBe('1');
    }
  });

  test('latência entra no histograma, com contagem e soma', async () => {
    const metrics = new PrometheusMetrics();

    metrics.observeWagerProcessing('sqs', 0.02);
    metrics.observeWagerProcessing('sqs', 0.3);

    const exposition = await metrics.scrape();

    expect(sampleOf(exposition, 'wager_processing_duration_seconds_count{transport="sqs"}')).toBe('2');
    // O valor exato do somatório não é o contrato; ter sido observado é.
    expect(exposition).toContain('wager_processing_duration_seconds_sum{transport="sqs"}');
  });

  test('a profundidade da DLQ vem do broker no instante do scrape', async () => {
    const metrics = new PrometheusMetrics();

    metrics.bindDlqProbe(() => Promise.resolve(7));

    expect(sampleOf(await metrics.scrape(), 'wager_dlq_messages')).toBe('7');
  });

  test('DLQ inalcançável não derruba o scrape nem inventa zero', async () => {
    const metrics = new PrometheusMetrics();

    metrics.bindDlqProbe(() => Promise.reject(new Error('sqs unreachable')));

    const exposition = await metrics.scrape();

    // Sem resposta do broker não há amostra: zero afirmaria que a DLQ está vazia.
    expect(exposition).not.toContain('\nwager_dlq_messages ');
  });

  test('cada instância tem seu próprio registry', async () => {
    const first = new PrometheusMetrics();
    const second = new PrometheusMetrics();

    first.recordReconciliationDivergence();

    // Registrar as mesmas métricas duas vezes no mesmo processo é o caso normal
    // da suíte de testes: um registry global colidiria e vazaria contagem.
    expect(sampleOf(await first.scrape(), 'wallet_reconciliation_divergences_total')).toBe('1');
    expect(sampleOf(await second.scrape(), 'wallet_reconciliation_divergences_total')).toBe('0');
  });

  test('o content type anunciado é o que o registry produz', () => {
    expect(new PrometheusMetrics().contentType).toBe(PROMETHEUS_CONTENT_TYPE);
  });
});

describe('métricas nulas', () => {
  test('o padrão de quem é construído sem observabilidade não faz nada e não lança', () => {
    // Consumida pela porta, que é como o restante do código a enxerga.
    const metrics: MetricsPort = new NoopMetrics();

    expect(() => {
      metrics.recordWagerTransaction(WagerTransactionStatus.Processed, 'http');
      metrics.observeWagerProcessing('http', 1);
      metrics.recordDuplicate('inbox_redelivery');
      metrics.recordPermanentMessage('malformed');
      metrics.recordRetry('outbox');
      metrics.observeWalletLockWait(1);
      metrics.recordLockConflict('lock_timeout');
      metrics.observeOutboxPublishLag(1);
      metrics.setOutboxOldestPendingAge(1);
      metrics.recordReconciliationDivergence();
    }).not.toThrow();
  });
});
