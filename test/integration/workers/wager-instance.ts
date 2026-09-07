/**
 * Instância independente do consumidor, executada como processo separado.
 *
 * Usada pelo teste multi-instância: cada processo tem o próprio pool de
 * conexões, o próprio cliente SQS e a própria memória, o que é o ponto —
 * `3 promises` no mesmo processo não provariam nada sobre a topologia real.
 *
 * Recebe o schema por argumento porque os testes montam um schema isolado, e
 * relata o resultado por stdout como JSON.
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { ConsumeWagerMessageUseCase } from '../../../src/application/consume-wager-message.use-case.js';
import { ProcessWagerTransactionUseCase } from '../../../src/application/process-wager-transaction.use-case.js';
import { createDatabaseOptions } from '../../../src/infrastructure/persistence/database.config.js';
import { MikroOrmFinancialTransactionManager } from '../../../src/infrastructure/persistence/mikro-orm-financial-transaction-manager.js';
import { createMessagingOptions } from '../../../src/infrastructure/messaging/messaging.config.js';
import { SqsClientAdapter } from '../../../src/infrastructure/messaging/sqs/sqs-client.js';
import { WagerSqsConsumer } from '../../../src/infrastructure/messaging/sqs/wager-sqs-consumer.js';

const schema = process.argv[2];
const consumerName = process.argv[3] ?? 'wager-transactions-multi';
const rounds = Number(process.argv[4] ?? '6');

if (schema === undefined) {
  throw new Error('Usage: wager-instance <schema> [consumerName] [rounds]');
}

const options = createDatabaseOptions();
const orm = await MikroORM.init({ ...options, schema });
const messaging = createMessagingOptions();
const sqs = new SqsClientAdapter(messaging);
const manager = new MikroOrmFinancialTransactionManager(orm);
const consume = new ConsumeWagerMessageUseCase(
  manager,
  new ProcessWagerTransactionUseCase(manager),
  consumerName,
);
const consumer = new WagerSqsConsumer(sqs, consume, messaging);

let acked = 0;
let received = 0;

try {
  for (let round = 0; round < rounds; round += 1) {
    const report = await consumer.pollOnce(2, 1);

    received += report.received;
    acked += report.acked;
  }
} finally {
  sqs.close();
  await orm.close();
}

process.stdout.write(`${JSON.stringify({ pid: process.pid, received, acked })}\n`);
