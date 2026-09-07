import type { WagerMessageEnvelope } from '../../../application/consume-wager-message.use-case.js';

/** Data e hora com fuso explícito, no formato que o envelope declara. */
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const REQUIRED_DATA_STRINGS = [
  'providerId',
  'externalTransactionId',
  'idempotencyKey',
  'playerId',
  'walletId',
  'roundId',
  'gameId',
  'kind',
];

/**
 * Validação do contrato de transporte, antes de qualquer efeito.
 *
 * Fica separada do consumidor porque é a fronteira entre um corpo arbitrário
 * vindo da fila e um comando tipado: um corpo que não passa aqui nunca chega
 * perto de dinheiro. Não há framework de validação envolvido — a superfície é
 * pequena, estável e o formato do erro é decidido pela política de DLQ, não por
 * uma biblioteca.
 */
export function parseWagerEnvelope(body: string): WagerMessageEnvelope | undefined {
  try {
    const parsed: unknown = JSON.parse(body);

    return isWagerEnvelope(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isWagerEnvelope(value: unknown): value is WagerMessageEnvelope {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate.messageId !== 'string' ||
    candidate.messageId.length === 0 ||
    candidate.type !== 'WagerTransactionRequested' ||
    !isIsoTimestamp(candidate.occurredAt) ||
    typeof candidate.data !== 'object' ||
    candidate.data === null
  ) {
    return false;
  }

  return isWagerCommand(candidate.data as Record<string, unknown>);
}

/**
 * `occurredAt` é quando o provedor diz que o fato aconteceu.
 *
 * A checagem tem três partes porque `Date.parse` sozinho não serve: ele aceita
 * formatos que o contrato não declara e, pior, converte `2026-02-31` em 3 de
 * março em vez de recusar. Aqui o formato é o declarado, a data existe no
 * calendário e o instante é interpretável — um carimbo silenciosamente
 * deslocado carregaria a auditoria de uma operação financeira.
 */
function isIsoTimestamp(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const match = ISO_TIMESTAMP.exec(value);

  if (match === null) {
    return false;
  }

  return (
    isCalendarDate(toInteger(match[1]), toInteger(match[2]), toInteger(match[3])) &&
    toInteger(match[4]) <= 23 &&
    toInteger(match[5]) <= 59 &&
    toInteger(match[6]) <= 59 &&
    !Number.isNaN(Date.parse(value))
  );
}

function toInteger(value: string | undefined): number {
  return Number.parseInt(value ?? '', 10);
}

/** Dia real do mês, para que `2026-02-31` não vire 3 de março. */
function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }

  // Dia zero do mês seguinte é o último dia deste, com ano bissexto incluído.
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isWagerCommand(data: Record<string, unknown>): boolean {
  if (REQUIRED_DATA_STRINGS.some((field) => typeof data[field] !== 'string' || data[field] === '')) {
    return false;
  }

  const money = data.money;

  if (typeof money !== 'object' || money === null) {
    return false;
  }

  const amounts = money as Record<string, unknown>;

  return typeof amounts.amount === 'string' && typeof amounts.currency === 'string';
}
