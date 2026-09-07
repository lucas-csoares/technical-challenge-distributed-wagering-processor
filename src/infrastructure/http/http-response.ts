/**
 * Subconjunto da resposta HTTP realmente usado pelos adaptadores.
 *
 * Declarar só `status` e `json` evita depender das tipagens do Express para
 * duas chamadas, e mantém controllers e filtro presos ao contrato mínimo —
 * trocar o adaptador HTTP do NestJS não exigiria reescrevê-los.
 */
export interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): unknown;
}
