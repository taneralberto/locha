import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DataSourceOptions } from 'typeorm';
import { Account } from '../accounts/account.entity';
import { Budget } from '../budgets/budget.entity';
import { Debt } from '../debts/debt.entity';
import { DebtPayment } from '../debts/debt-payment.entity';
import { Goal } from '../savings/goal.entity';
import { SavingsEntry } from '../savings/savings-entry.entity';
import { GoalsAndSavings1783209600000 } from './migrations/1783209600000-GoalsAndSavings';
import { Debts1785888000000 } from './migrations/1785888000000-Debts';
import { DebtCapture1788566400000 } from './migrations/1788566400000-DebtCapture';
import { AiUsageDay } from '../capture/ai-usage.entity';
import { CaptureEvent } from '../capture/capture-event.entity';
import { Capture } from '../capture/capture.entity';
import { Movement } from '../financial/movement.entity';
import { LedgerOperation } from '../financial/ledger-operation.entity';
import { MovementRevision } from '../financial/movement-revision.entity';
import { BalanceReconciliation } from '../financial/balance-reconciliation.entity';
import { TelegramCursor } from '../telegram/telegram-cursor.entity';
import { TelegramInbox } from '../telegram/telegram-inbox.entity';
import { TelegramOutbox } from '../telegram/telegram-outbox.entity';
import { InitialSchema1767225600000 } from './migrations/1767225600000-InitialSchema';
import { CaptureAndInference1769904000000 } from './migrations/1769904000000-CaptureAndInference';
import { TelegramDelivery1772582400000 } from './migrations/1772582400000-TelegramDelivery';
import { LedgerOperations1775260800000 } from './migrations/1775260800000-LedgerOperations';
import { MovementCorrections1777939200000 } from './migrations/1777939200000-MovementCorrections';
import { Budgets1780617600000 } from './migrations/1780617600000-Budgets';

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
      Budget,
      Goal,
      SavingsEntry,
      Debt,
      DebtPayment,
      Movement,
      LedgerOperation,
      MovementRevision,
      BalanceReconciliation,
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
      LedgerOperations1775260800000,
      MovementCorrections1777939200000,
      Budgets1780617600000,
      GoalsAndSavings1783209600000,
      Debts1785888000000,
      DebtCapture1788566400000,
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
