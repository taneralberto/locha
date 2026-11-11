import { constants, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { canonicalPath } from './paths';
import { CaptureAndInference1769904000000 } from './migrations/1769904000000-CaptureAndInference';
import { InitialSchema1767225600000 } from './migrations/1767225600000-InitialSchema';
import { TelegramDelivery1772582400000 } from './migrations/1772582400000-TelegramDelivery';
import { LedgerOperations1775260800000 } from './migrations/1775260800000-LedgerOperations';
import { MovementCorrections1777939200000 } from './migrations/1777939200000-MovementCorrections';
import { Budgets1780617600000 } from './migrations/1780617600000-Budgets';
import { GoalsAndSavings1783209600000 } from './migrations/1783209600000-GoalsAndSavings';
import { Debts1785888000000 } from './migrations/1785888000000-Debts';
import { DebtCapture1788566400000 } from './migrations/1788566400000-DebtCapture';

/** Tablas que debe tener una base valida del proyecto. */
const EXPECTED_TABLES = [
  'account',
  'movement',
  'capture',
  'capture_event',
  'ai_usage_day',
  'telegram_inbox',
  'telegram_outbox',
  'telegram_cursor',
  'migrations',
];

/** Migraciones que debe tener aplicadas una base valida del proyecto. */
const EXPECTED_MIGRATIONS = [
  new InitialSchema1767225600000().name,
  new CaptureAndInference1769904000000().name,
  new TelegramDelivery1772582400000().name,
];

export interface BackupResult {
  source: string;
  destination: string;
  bytes: number;
}

/**
 * Copia de seguridad de la base de datos. Se usa la API de backup de SQLite: el
 * resultado es una copia consistente aunque la base este en modo WAL. **Nunca** se
 * copia el archivo `.sqlite` a pelo mientras la base esta viva.
 *
 * El destino debe ser un archivo **nuevo**: por defecto no se pisa nada. La
 * publicacion es atomica (un archivo temporal se publica con creacion exclusiva),
 * asi que un destino que aparece en el meanwhile no se pisa.
 */
export async function backupDatabase(
  sourcePath: string,
  destinationPath: string,
  options: { force?: boolean } = {},
): Promise<BackupResult> {
  const source = canonicalPath(sourcePath);
  const destination = canonicalPath(destinationPath);
  if (!existsSync(source)) {
    throw new Error(`No existe la base de datos "${source}".`);
  }
  if (source === destination) {
    throw new Error('El destino de la copia de seguridad no puede ser la base de datos.');
  }
  if (existsSync(destination) && !options.force) {
    throw new Error(
      `El destino "${destination}" ya existe. Usa otra ruta (o --force para reemplazarlo).`,
    );
  }
  mkdirSync(dirname(destination), { recursive: true });
  await publishCopy(source, destination, options.force === true);
  validateDatabase(destination);
  return { source, destination, bytes: statSync(destination).size };
}

/**
 * Restaura una copia de seguridad en una ruta **nueva**: la base actual nunca se
 * sobrescribe. El archivo restaurado se valida antes de terminar.
 */
export async function restoreDatabase(
  sourcePath: string,
  destinationPath: string,
): Promise<BackupResult> {
  const source = canonicalPath(sourcePath);
  const destination = canonicalPath(destinationPath);
  if (!existsSync(source)) {
    throw new Error(`No existe la copia de seguridad "${source}".`);
  }
  if (source === destination) {
    throw new Error('El destino de la restauracion no puede ser la copia de seguridad.');
  }
  if (existsSync(destination)) {
    throw new Error(`El destino "${destination}" ya existe. Restaura siempre en una ruta nueva.`);
  }
  validateDatabase(source);
  mkdirSync(dirname(destination), { recursive: true });
  await publishCopy(source, destination, false);
  validateDatabase(destination);
  return { source, destination, bytes: statSync(destination).size };
}

/**
 * Copia la base a un archivo temporal y lo publica en el destino. La publicacion
 * usa creacion exclusiva: si el destino aparece mientras se copiaba, la copia falla
 * en vez de pisarlo.
 */
export async function publishCopy(
  source: string,
  destination: string,
  force: boolean,
): Promise<void> {
  const temporary = join(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const database = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await database.backup(temporary);
  } finally {
    database.close();
  }
  try {
    if (force) {
      copyFileSync(temporary, destination);
    } else {
      copyFileSync(temporary, destination, constants.COPYFILE_EXCL);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `El destino "${destination}" ya existe. Usa otra ruta (o --force para reemplazarlo).`,
      );
    }
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Valida que el archivo sea una base integra y con el esquema del proyecto. Un archivo
 * que no pasa la validacion no sirve ni como copia ni como restauracion.
 */
export function validateDatabase(path: string): void {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = database.prepare('PRAGMA integrity_check').get() as
      | Record<string, unknown>
      | undefined;
    const value = integrity ? Object.values(integrity)[0] : undefined;
    if (value !== 'ok') {
      throw new Error(`La base "${path}" no esta integra (integrity_check: ${String(value)}).`);
    }
    const tables = database
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as { name: string }[];
    const names = tables.map((table) => table.name);
    const missing = EXPECTED_TABLES.filter((table) => !names.includes(table));
    if (missing.length > 0) {
      throw new Error(`La base "${path}" no tiene el esquema esperado: falta ${missing.join(', ')}.`);
    }
    const applied = database.prepare(`SELECT name FROM migrations`).all() as { name: string }[];
    const appliedNames = applied.map((migration) => migration.name);
    // Los prefijos completos A/B1/B2/B3 siguen siendo restaurables y se migran despues.
    if (names.includes('ledger_operation') !== appliedNames.includes(new LedgerOperations1775260800000().name)) {
      throw new Error(`La base "${path}" no tiene el esquema esperado de ledger_operation y su migracion.`);
    }
    const hasB2 = appliedNames.includes(new MovementCorrections1777939200000().name);
    if (names.includes('movement_revision') !== hasB2 || names.includes('balance_reconciliation') !== hasB2 ||
      (hasB2 && !appliedNames.includes(new LedgerOperations1775260800000().name))) {
      throw new Error(`La base "${path}" no tiene el esquema esperado B2: movement_revision, balance_reconciliation y su migracion requieren B1.`);
    }
    const hasB3 = appliedNames.includes(new Budgets1780617600000().name);
    if (names.includes('budget') !== hasB3 || (hasB3 && !hasB2)) {
      throw new Error(`La base "${path}" no tiene el esquema esperado B3: budget y su migracion requieren B2 y B1.`);
    }
    const hasB4 = appliedNames.includes(new GoalsAndSavings1783209600000().name);
    if (names.includes('goal') !== hasB4 || names.includes('savings_entry') !== hasB4 || (hasB4 && !hasB3)) {
      throw new Error(`La base "${path}" no tiene el esquema esperado B4: goal, savings_entry y su migracion requieren B3, B2 y B1.`);
    }
    const hasB5 = appliedNames.includes(new Debts1785888000000().name);
    if (names.includes('debt') !== hasB5 || names.includes('debt_payment') !== hasB5 || (hasB5 && !hasB4)) {
      throw new Error(`La base "${path}" no tiene el esquema esperado B5: debt, debt_payment y su migracion requieren B4, B3, B2 y B1.`);
    }
    // La columna del borrador de deuda va junto a su migracion: B6 exige B5.
    const captureColumns = database.prepare(`PRAGMA table_info("capture")`).all() as { name: string }[];
    const hasDebtPayload = captureColumns.some((column) => column.name === 'debtPayload');
    const hasB6 = appliedNames.includes(new DebtCapture1788566400000().name);
    if (hasDebtPayload !== hasB6 || (hasB6 && !hasB5)) {
      throw new Error(
        `La base "${path}" no tiene el esquema esperado B6: la columna debtPayload del borrador y su migracion requieren B5, B4, B3, B2 y B1.`,
      );
    }
    const pending = EXPECTED_MIGRATIONS.filter((migration) => !appliedNames.includes(migration));
    if (pending.length > 0) {
      throw new Error(
        `La base "${path}" no tiene las migraciones esperadas: falta ${pending.join(', ')}.`,
      );
    }
  } finally {
    database.close();
  }
}
