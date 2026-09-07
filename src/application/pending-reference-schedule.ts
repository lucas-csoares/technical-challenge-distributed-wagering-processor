export interface PendingReferenceSchedule {
  /** Instante da primeira reavaliação de uma pendência recém-criada. */
  firstAttemptAt(now: Date): Date;
  /** Próxima tentativa após `attempts` falhas, ou `undefined` quando esgotou. */
  nextAttemptAt(attempts: number, now: Date): Date | undefined;
  readonly maxAttempts: number;
}

export interface BackoffOptions {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxAttempts: number;
}

/**
 * Backoff exponencial limitado para reavaliar `PENDING_REFERENCE`.
 *
 * A espera dobra a cada tentativa e satura em `maxDelayMs`, para que uma
 * referência que demora não vire varredura apertada nem espere indefinidamente.
 * Esgotado `maxAttempts`, a operação é rejeitada com código estável em vez de
 * ficar pendente para sempre — pendência eterna é pior que rejeição explícita,
 * porque o provedor nunca descobre o desfecho.
 *
 * Os valores são injetáveis justamente para que o teste comprove a expiração
 * sem esperar tempo real.
 */
export class ExponentialPendingReferenceSchedule implements PendingReferenceSchedule {
  readonly maxAttempts: number;

  constructor(private readonly options: BackoffOptions) {
    this.maxAttempts = options.maxAttempts;
  }

  firstAttemptAt(now: Date): Date {
    return new Date(now.getTime() + this.options.baseDelayMs);
  }

  nextAttemptAt(attempts: number, now: Date): Date | undefined {
    if (attempts >= this.options.maxAttempts) {
      return undefined;
    }

    const delay = Math.min(this.options.baseDelayMs * 2 ** attempts, this.options.maxDelayMs);

    return new Date(now.getTime() + delay);
  }
}

/**
 * Padrão de produção: começa em 5s, satura em 5min e desiste após 8 tentativas
 * — cerca de 20 minutos de janela, folgado para uma reordenação de fila e curto
 * o bastante para o provedor receber um desfecho no mesmo turno operacional.
 */
export const defaultPendingReferenceSchedule = new ExponentialPendingReferenceSchedule({
  baseDelayMs: 5_000,
  maxDelayMs: 300_000,
  maxAttempts: 8,
});
