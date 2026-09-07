export interface MessagingOptions {
  readonly region: string;
  readonly endpoint: string;
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string };
  readonly wagerQueueUrl: string;
  readonly dlqUrl: string;
  readonly eventsQueueUrl: string;
}

/**
 * Configuração de mensageria lida uma única vez, na borda.
 *
 * O restante do código recebe `MessagingOptions` por injeção em vez de tocar
 * `process.env`, o que mantém consumidor, publisher e workers testáveis contra
 * qualquer endpoint sem variável global.
 *
 * `NODE_ENV=test` seleciona exclusivamente as variáveis `TEST_*`, sem fallback
 * para as de desenvolvimento: um teste jamais deve publicar por engano na fila
 * que a aplicação local está consumindo.
 */
export function createMessagingOptions(env: NodeJS.ProcessEnv = process.env): MessagingOptions {
  const testing = env.NODE_ENV === 'test';
  const prefix = testing ? 'TEST_' : '';

  const required = (name: string): string => {
    const key = `${prefix}${name}`;
    const value = env[key];

    if (!value?.trim()) {
      throw new Error(`${key} is required.`);
    }

    return value;
  };

  const wagerQueueUrl = required('WAGER_QUEUE_URL');
  const dlqUrl = required('WAGER_DLQ_URL');
  const eventsQueueUrl = required('EVENTS_QUEUE_URL');

  if (testing && (wagerQueueUrl === env.WAGER_QUEUE_URL || eventsQueueUrl === env.EVENTS_QUEUE_URL)) {
    throw new Error('TEST_ queue URLs must differ from the development queues.');
  }

  return {
    region: env.AWS_REGION?.trim() ?? 'us-east-1',
    endpoint: required('SQS_ENDPOINT'),
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID?.trim() ?? 'local',
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY?.trim() ?? 'local',
    },
    wagerQueueUrl,
    dlqUrl,
    eventsQueueUrl,
  };
}
