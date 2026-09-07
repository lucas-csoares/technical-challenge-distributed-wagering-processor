import { describe, expect, test } from 'bun:test';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  InvalidLedgerCursorError,
} from '../../src/application/ledger-cursor.js';

const AT = new Date('2026-09-06T12:00:00.000Z');

describe('cursor do ledger', () => {
  test('sobrevive ao round-trip preservando instante e id', () => {
    const cursor = encodeLedgerCursor({ createdAt: AT, id: 'entry-1' });
    const decoded = decodeLedgerCursor(cursor);

    expect(decoded.createdAt.toISOString()).toBe(AT.toISOString());
    expect(decoded.id).toBe('entry-1');
  });

  test('é opaco: não revela o id nem a data em texto claro', () => {
    const cursor = encodeLedgerCursor({ createdAt: AT, id: 'entry-1' });

    expect(cursor).not.toContain('entry-1');
    expect(cursor).not.toContain('2026');
  });

  test('usa base64url, seguro em query string sem escape', () => {
    const cursor = encodeLedgerCursor({ createdAt: AT, id: 'a/b+c=d' });

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeLedgerCursor(cursor).id).toBe('a/b+c=d');
  });

  test('preserva milissegundos, que fazem parte da ordenação', () => {
    const precise = new Date('2026-09-06T12:00:00.123Z');
    const decoded = decodeLedgerCursor(encodeLedgerCursor({ createdAt: precise, id: 'x' }));

    expect(decoded.createdAt.getTime()).toBe(precise.getTime());
  });

  test.each([
    ['texto solto', 'not-a-cursor'],
    ['base64 de algo que não é JSON', Buffer.from('nope', 'utf8').toString('base64url')],
    ['JSON sem os campos', Buffer.from('{}', 'utf8').toString('base64url')],
    ['string vazia', ''],
    ['JSON de array', Buffer.from('[]', 'utf8').toString('base64url')],
  ])('recusa %s', (_name, cursor) => {
    expect(() => decodeLedgerCursor(cursor)).toThrow(InvalidLedgerCursorError);
  });

  test('recusa uma data inválida mesmo com a forma correta', () => {
    const payload = JSON.stringify({ v: 1, at: 'ontem', id: 'entry-1' });

    expect(() => decodeLedgerCursor(Buffer.from(payload, 'utf8').toString('base64url'))).toThrow(
      InvalidLedgerCursorError,
    );
  });

  test('recusa um cursor de outra versão em vez de interpretá-lo', () => {
    const payload = JSON.stringify({ v: 2, at: AT.toISOString(), id: 'entry-1' });

    expect(() => decodeLedgerCursor(Buffer.from(payload, 'utf8').toString('base64url'))).toThrow(
      InvalidLedgerCursorError,
    );
  });
});
