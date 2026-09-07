import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const logger = new ConsoleLogger({ json: true });

export async function bootstrap(port = Number(process.env.PORT ?? '3000')) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535.');
  }

  const app = await NestFactory.create(AppModule, { logger, abortOnError: false });
  app.enableShutdownHooks();

  try {
    await app.listen(port);
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

if (import.meta.main) {
  bootstrap().catch((error: unknown) => {
    logger.error(error instanceof Error ? error.message : 'Application startup failed.');
    process.exitCode = 1;
  });
}
