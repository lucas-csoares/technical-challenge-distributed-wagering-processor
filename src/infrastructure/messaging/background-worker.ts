import { Logger } from '@nestjs/common';

export interface WorkerOptions {
  readonly name: string;
  readonly intervalMs: number;
}

/**
 * Laço de fundo com parada limpa.
 *
 * O ciclo em andamento sempre termina antes de o worker parar: `stop()` sinaliza
 * e aguarda a rodada corrente. Isso é o que permite ao `SIGTERM` não deixar
 * trabalho pela metade — uma mensagem em processamento chega ao commit e ao
 * `ACK`, ou não é confirmada e volta pela visibilidade do SQS.
 *
 * Um erro em uma rodada é registrado e não derruba o laço: workers de
 * infraestrutura precisam sobreviver a indisponibilidade temporária do banco
 * ou do broker.
 */
export class BackgroundWorker {
  private readonly logger: Logger;
  private running = false;
  private stopping = false;
  private currentCycle: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: WorkerOptions,
    private readonly cycle: () => Promise<void>,
  ) {
    this.logger = new Logger(options.name);
  }

  get name(): string {
    return this.options.name;
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.stopping = false;
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.currentCycle;
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      this.currentCycle = this.runCycle();
      await this.currentCycle;

      if (this.stopping) {
        break;
      }

      await this.sleep(this.options.intervalMs);
    }
  }

  private async runCycle(): Promise<void> {
    try {
      await this.cycle();
    } catch (error) {
      this.logger.error({
        event: 'worker.cycle_failed',
        worker: this.options.name,
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Não segura o processo vivo apenas por causa do intervalo ocioso.
      timer.unref?.();
    });
  }
}
