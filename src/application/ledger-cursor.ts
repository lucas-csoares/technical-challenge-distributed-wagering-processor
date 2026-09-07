/** Posição estável no ledger: a ordenação é `(createdAt, id)`. */
export interface LedgerCursorPosition {
  readonly createdAt: Date;
  readonly id: string;
}

export class InvalidLedgerCursorError extends Error {
  constructor() {
    super('The pagination cursor is not valid.');
    this.name = 'InvalidLedgerCursorError';
  }
}

interface EncodedCursor {
  readonly v: number;
  readonly at: string;
  readonly id: string;
}

const CURSOR_VERSION = 1;

/**
 * O cursor é opaco para o cliente: um base64url de JSON, sem contrato público.
 *
 * Ele carrega a posição `(createdAt, id)` em vez de um offset porque o ledger é
 * append-only e cresce durante a paginação — um offset pularia ou repetiria
 * lançamentos assim que uma nova operação fosse confirmada entre duas páginas.
 * O campo de versão permite mudar a estrutura depois sem aceitar em silêncio um
 * cursor emitido por outra versão.
 */
export function encodeLedgerCursor(position: LedgerCursorPosition): string {
  const payload: EncodedCursor = {
    v: CURSOR_VERSION,
    at: position.createdAt.toISOString(),
    id: position.id,
  };

  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeLedgerCursor(cursor: string): LedgerCursorPosition {
  const decoded = parseCursorPayload(cursor);

  if (
    decoded.v !== CURSOR_VERSION ||
    typeof decoded.at !== 'string' ||
    typeof decoded.id !== 'string' ||
    decoded.id.length === 0
  ) {
    throw new InvalidLedgerCursorError();
  }

  const createdAt = new Date(decoded.at);

  if (Number.isNaN(createdAt.getTime())) {
    throw new InvalidLedgerCursorError();
  }

  return { createdAt, id: decoded.id };
}

function parseCursorPayload(cursor: string): Partial<EncodedCursor> {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);

    if (typeof parsed !== 'object' || parsed === null) {
      throw new InvalidLedgerCursorError();
    }

    return parsed;
  } catch {
    throw new InvalidLedgerCursorError();
  }
}
