import type { MikroORM } from '@mikro-orm/postgresql';

/**
 * Sonda de disponibilidade do PostgreSQL para o health check de readiness.
 *
 * Existe para que o transporte não precise do `MikroORM` só para executar um
 * `select 1`, mantendo o ORM contido na persistência. Responde apenas se o
 * banco atende; a causa da falha fica no log, não na resposta HTTP.
 */
export class DatabaseHealth {
  constructor(private readonly orm: MikroORM) {}

  async isReachable(): Promise<boolean> {
    try {
      await this.orm.em.fork().execute('select 1');
      return true;
    } catch {
      return false;
    }
  }
}
