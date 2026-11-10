import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { config as loadEnvFile } from 'dotenv';
import { AppModule } from './app.module';
import { resolveDatabasePath } from './config/configuration';
import { acquireInstanceLock, lockPathFor, releaseInstanceLock } from './lock/instance-lock';
import { TelegramService } from './telegram/telegram.service';

async function bootstrap(): Promise<void> {
  // El archivo `.env` se carga aqui para conocer la ruta de la base antes de abrirla.
  loadEnvFile({ quiet: true });
  const databasePath = resolveDatabasePath(process.env);
  acquireInstanceLock({ path: lockPathFor(databasePath), label: 'locha' });
  process.on('exit', () => releaseInstanceLock());

  const app = await NestFactory.createApplicationContext(AppModule, {
    // Sin esto Nest aborta el proceso sin mostrar el error de configuracion.
    abortOnError: false,
  });
  const logger = new Logger('Bootstrap');
  logger.log('Contexto NestJS iniciado (Etapa A). Todavia no hay servidor HTTP.');

  const telegram = app.get(TelegramService);
  if (telegram.enabled) {
    await telegram.start();
    logger.log('Bot de Telegram activo (long polling).');
  } else if (telegram.partial) {
    logger.warn(
      'Telegram: configuracion parcial (falta el token, el usuario o el chat). El bot queda desactivado.',
    );
  } else {
    logger.log('Telegram: sin configurar. El bot queda desactivado.');
  }

  // El contexto de aplicacion no abre sockets por si solo: un temporizador mantiene vivo el proceso.
  const keepAlive = setInterval(() => undefined, 60_000);
  const shutdown = (): void => {
    clearInterval(keepAlive);
    void app.close().then(() => {
      releaseInstanceLock();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void bootstrap().catch((error: unknown) => {
  releaseInstanceLock();
  console.error(error);
  process.exit(1);
});
