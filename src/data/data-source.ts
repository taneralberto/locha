import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DataSourceOptions } from 'typeorm';
import { Account } from '../accounts/account.entity';
import { AiUsageDay } from '../capture/ai-usage.entity';
import { CaptureEvent } from '../capture/capture-event.entity';
import { Capture } from '../capture/capture.entity';
import { Movement } from '../financial/movement.entity';
import { TelegramCursor } from '../telegram/telegram-cursor.entity';
import { TelegramInbox } from '../telegram/telegram-inbox.entity';
import { TelegramOutbox } from '../telegram/telegram-outbox.entity';
import { InitialSchema1767225600000 } from './migrations/1767225600000-InitialSchema';
import { CaptureAndInference1769904000000 } from './migrations/1769904000000-CaptureAndInference';
import { TelegramDelivery1772582400000 } from './migrations/1772582400000-TelegramDelivery';

/**
 * Opciones de conexion compartidas por la aplicacion NestJS, la CLI y las pruebas.
 * `synchronize` permanece desactivado: el esquema solo cambia por migraciones.
 */
export function buildDataSourceOptions(databasePath: string): DataSourceOptions {
  return {
    type: 'better-sqlite3',
    database: databasePath,
    entities: [
      Account,
      Movement,
      Capture,
      CaptureEvent,
      AiUsageDay,
      TelegramInbox,
      TelegramOutbox,
      TelegramCursor,
    ],
    migrations: [
      InitialSchema1767225600000,
      CaptureAndInference1769904000000,
      TelegramDelivery1772582400000,
    ],
    synchronize: false,
    migrationsRun: false,
    logging: false,
  };
}

/** SQLite no crea los directorios intermedios: hay que garantizarlo antes de abrir la base. */
export function ensureDatabaseDirectory(databasePath: string): void {
  if (databasePath === ':memory:') {
    return;
  }
  mkdirSync(dirname(resolve(databasePath)), { recursive: true });
}
