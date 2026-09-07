import {
  FinancialTransactionManager,
  type FinancialTransactionOptions,
  type FinancialTransactionScope,
} from '../../src/application/ports/financial-transaction-manager.js';
import type { InboxRecord, InboxRepository } from '../../src/application/ports/inbox.repository.js';
import { FinancialPersistenceError } from '../../src/application/ports/persistence-error.js';

/**
 * Ponto de encontro entre execuções concorrentes.
 *
 * Existe para provocar a corrida da Inbox de forma determinística: as duas
 * execuções só seguem depois que ambas observaram a mesma ausência. Sem isso o
 * teste dependeria de `sleep` e de sorte de escalonamento, e passaria a provar
 * o agendador em vez do código.
 */
export class Barrier {
  private waiting = 0;
  private pending: (() => void)[] = [];

  constructor(private readonly parties: number) {}

  arrive(): Promise<void> {
    this.waiting += 1;

    if (this.waiting < this.parties) {
      return new Promise((resolve) => {
        this.pending.push(resolve);
      });
    }

    const released = this.pending;
    this.pending = [];

    for (const resolve of released) {
      resolve();
    }

    return Promise.resolve();
  }
}

/** Troca só a Inbox do escopo, preservando os demais repositories. */
function withInbox(scope: FinancialTransactionScope, inbox: InboxRepository): FinancialTransactionScope {
  return {
    wallets: scope.wallets,
    transactions: scope.transactions,
    ledger: scope.ledger,
    outbox: scope.outbox,
    inbox,
  };
}

/**
 * Sincroniza execuções concorrentes no ponto exato da corrida.
 *
 * A espera acontece depois de a verificação prévia devolver "não existe" e
 * antes de qualquer inserção, que é a janela em que duas instâncias podem
 * concluir, ambas, que a mensagem é nova. A transação que espera aqui é apenas
 * de leitura e não segura lock que impeça a outra de avançar.
 */
export class InboxRaceManager extends FinancialTransactionManager {
  constructor(
    private readonly inner: FinancialTransactionManager,
    private readonly barrier: Barrier,
  ) {
    super();
  }

  override execute<T>(
    work: (scope: FinancialTransactionScope) => Promise<T>,
    options: FinancialTransactionOptions = {},
  ): Promise<T> {
    return this.inner.execute(async (scope) => {
      const gated: InboxRepository = {
        find: async (consumerName, messageId) => {
          const found = await scope.inbox.find(consumerName, messageId);

          if (found === undefined) {
            await this.barrier.arrive();
          }

          return found;
        },
        register: (record: InboxRecord) => scope.inbox.register(record),
        markProcessed: (consumerName, messageId, at) =>
          scope.inbox.markProcessed(consumerName, messageId, at),
      };

      return work(withInbox(scope, gated));
    }, options);
  }
}

/**
 * Falha transitória controlada, uma única vez, antes do commit.
 *
 * O trabalho real acontece — Inbox, wallet, ledger e Outbox são escritos — e só
 * então a transação é abortada, o que exercita o rollback de verdade em vez de
 * simular a ausência de efeito. O gatilho é o registro na Inbox, e não a ordem
 * das chamadas, para que a falha caia sempre na unidade de trabalho que escreve
 * e nunca na verificação prévia, que é apenas leitura.
 */
export class FailOnceAfterInboxRegister extends FinancialTransactionManager {
  private armed = true;
  private injected = 0;

  constructor(private readonly inner: FinancialTransactionManager) {
    super();
  }

  /** Quantas vezes a falha foi realmente injetada. */
  get failures(): number {
    return this.injected;
  }

  override execute<T>(
    work: (scope: FinancialTransactionScope) => Promise<T>,
    options: FinancialTransactionOptions = {},
  ): Promise<T> {
    return this.inner.execute(async (scope) => {
      let registered = false;
      const observed: InboxRepository = {
        find: (consumerName, messageId) => scope.inbox.find(consumerName, messageId),
        register: async (record: InboxRecord) => {
          registered = true;
          await scope.inbox.register(record);
        },
        markProcessed: (consumerName, messageId, at) =>
          scope.inbox.markProcessed(consumerName, messageId, at),
      };

      const result = await work(withInbox(scope, observed));

      if (this.armed && registered) {
        this.armed = false;
        this.injected += 1;
        throw new FinancialPersistenceError(new Error('injected transient persistence failure'));
      }

      return result;
    }, options);
  }
}
