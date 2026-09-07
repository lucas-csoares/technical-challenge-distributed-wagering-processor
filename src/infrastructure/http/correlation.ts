/** Cabeçalho de correlação aceito na borda HTTP. */
export const CORRELATION_HEADER = 'x-correlation-id';

const MAX_LENGTH = 128;

/**
 * Correlação de uma requisição HTTP.
 *
 * Quem chama pode trazer a sua — é o que permite seguir uma operação desde o
 * sistema do provedor — e, quando não traz, a borda gera uma. O valor é
 * propagado explicitamente para o caso de uso, sem contexto global implícito:
 * um `AsyncLocalStorage` resolveria o mesmo problema escondendo a dependência,
 * e aqui ela cabe em um parâmetro.
 *
 * O comprimento é limitado porque este valor vai para log e para o envelope de
 * eventos; um cabeçalho arbitrariamente longo é entrada não confiável.
 */
export function correlationIdFrom(header: string | undefined): string {
  const candidate = header?.trim();

  if (candidate === undefined || candidate.length === 0 || candidate.length > MAX_LENGTH) {
    return crypto.randomUUID();
  }

  return candidate;
}
