import { Application } from '@app/application';

import { env } from '@config/env';

import { logger } from '@infra/logger/logger';

async function bootstrap(): Promise<void> {
  logger.info('=================================');
  logger.info('EURUSD BOT INITIALIZING');
  logger.info(`ENVIRONMENT: ${env.NODE_ENV}`);
  logger.info('=================================');

  const application = new Application();

  await application.start();

  process.on('SIGINT', async () => {
    logger.warn('SIGINT RECEIVED');

    await application.stop();

    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.warn('SIGTERM RECEIVED');

    await application.stop();

    process.exit(0);
  });
}

bootstrap().catch((error) => {
  logger.error(error);

  process.exit(1);
});