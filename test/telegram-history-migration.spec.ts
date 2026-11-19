import { dirname, join } from 'node:path';
import { DataSource } from 'typeorm';
import { AccountService } from '../src/accounts/account.service';
import { backupDatabase, restoreDatabase, validateDatabase } from '../src/data/backup';
import { buildDataSourceOptions } from '../src/data/data-source';
import { TelegramHistory1791158400000 } from '../src/data/migrations/1791158400000-TelegramHistory';
import { FinancialService } from '../src/financial/financial.service';
import { snapshot } from './helpers/schema-snapshot';
import { createTempDatabase, openDatabase } from './helpers/temp-database';

const migrations = buildDataSourceOptions(':memory:').migrations as Function[];

/**
 * El prefijo B7: todo hasta la migracion del historial, buscada por su nombre (no
 * por su posicion, que cambia con cada migracion nueva).
 */
const hastaB7 = migrations.slice(
  0,
  migrations.findIndex((migration) => new (migration as new () => { name: string })().name === new TelegramHistory1791158400000().name) + 1,
);

/**
 * Unidad 1: la tabla del historial de Telegram. La migracion es **aditiva**: crea una
 * tabla nueva y no reescribe ni una fila de las que ya existian.
 */
describe('Migracion del historial de Telegram', () => {
  it('crea la tabla con su clave (updateId, role) y sus indices', async () => {
    const db = await createTempDatabase();
    try {
      const tables = await db.dataSource.query<{ name: string }[]>(
        `SELECT name FROM sqlite_master WHERE type = 'table'`,
      );
      expect(tables.map((table) => table.name)).toContain('telegram_history');

      const columns = await db.dataSource.query<{ name: string; type: string; pk: number }[]>(
        `PRAGMA table_info("telegram_history")`,
      );
      expect(columns.map((column) => column.name)).toEqual([
        'updateId',
        'role',
        'chatId',
        'userId',
        'text',
        'sentAt',
      ]);
      // La clave es la actualizacion y el rol: un texto por actualizacion y rol.
      expect(columns.filter((column) => column.pk > 0).map((column) => column.name)).toEqual([
        'updateId',
        'role',
      ]);
      // El tiempo es numerico (epoch), no una fecha en texto.
      expect(columns.find((column) => column.name === 'sentAt')?.type?.toUpperCase()).toBe('INTEGER');

      const indexes = await db.dataSource.query<{ name: string }[]>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'telegram_history'`,
      );
      expect(indexes.map((index) => index.name)).toEqual(
        expect.arrayContaining(['IDX_telegram_history_subject', 'IDX_telegram_history_sentAt']),
      );
    } finally {
      await db.cleanup();
    }
  });

  it('admite un solo texto por actualizacion y rol', async () => {
    const db = await createTempDatabase();
    try {
      await db.dataSource.query(
        `INSERT INTO telegram_history (updateId, role, chatId, userId, text, sentAt)
         VALUES (1, 'user', '111', '111', 'hola', 1700000000000)`,
      );

      await expect(
        db.dataSource.query(
          `INSERT INTO telegram_history (updateId, role, chatId, userId, text, sentAt)
           VALUES (1, 'user', '111', '111', 'otro', 1700000000000)`,
        ),
      ).rejects.toThrow(/UNIQUE/);
      // El otro rol de la misma actualizacion si cabe.
      await db.dataSource.query(
        `INSERT INTO telegram_history (updateId, role, chatId, userId, text, sentAt)
         VALUES (1, 'bot', '111', '111', 'respuesta', 1700000000001)`,
      );
      expect(await db.dataSource.query(`SELECT * FROM telegram_history`)).toHaveLength(2);
    } finally {
      await db.cleanup();
    }
  });

  it.each([['A', 3], ['B1', 4], ['B2', 5], ['B3', 6], ['B4', 7], ['B5', 8], ['B6', 9]] as const)(
    'restaura el prefijo %s, migra aditivo y conserva sus filas',
    async (_prefix, count) => {
      const db = await createTempDatabase(migrations.slice(0, count));
      const connections: DataSource[] = [];
      try {
        const account = await new AccountService(db.dataSource, db.transactions).add({
          name: 'Efectivo',
          currency: 'USD',
        });
        await new FinancialService(db.transactions).register({
          sourceKey: 'gasto',
          accountId: account.id,
          kind: 'expense',
          money: { currency: 'USD', minor: 100n },
          occurredOn: '2026-01-01',
        });
        const tables = (
          await db.dataSource.query<{ name: string }[]>(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('migrations', 'sqlite_sequence') ORDER BY name`,
          )
        ).map((row) => row.name);
        const before = await snapshot(db.dataSource, tables);

        const backup = join(dirname(db.path), 'prefix.sqlite');
        const restoredPath = join(dirname(db.path), 'upgraded.sqlite');
        await backupDatabase(db.path, backup);
        await restoreDatabase(backup, restoredPath);
        const upgraded = await openDatabase(restoredPath);
        connections.push(upgraded);
        const after = await snapshot(upgraded, tables);
        expect(after).toEqual(before);
        expect(after.rows).toEqual(before.rows);

        // La tabla nueva existe y las anteriores siguen igual.
        const created = await upgraded.query<{ name: string }[]>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telegram_history'`,
        );
        expect(created).toHaveLength(1);
        expect(() => validateDatabase(restoredPath)).not.toThrow();
      } finally {
        for (const connection of connections) if (connection.isInitialized) await connection.destroy();
        await db.cleanup();
      }
    },
  );

  it.each(['tabla', 'marcador'])('rechaza B7 parcial: %s', async (missing) => {
    const db = await createTempDatabase();
    try {
      if (missing === 'marcador') {
        await db.dataSource.query('DELETE FROM migrations WHERE name = ?', [
          new TelegramHistory1791158400000().name,
        ]);
      } else {
        await db.dataSource.query('DROP TABLE telegram_history');
      }
      expect(() => validateDatabase(db.path)).toThrow(/B7/);
    } finally {
      await db.cleanup();
    }
  });

  it('el down quita la tabla y no toca las demas', async () => {
    // El down historico es el de B7: la base se abre en ese prefijo, no en el ultimo.
    const db = await createTempDatabase(hastaB7);
    try {
      const tables = (
        await db.dataSource.query<{ name: string }[]>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('telegram_history', 'migrations', 'sqlite_sequence')`,
        )
      ).map((row) => row.name);
      const before = await snapshot(db.dataSource, tables);

      await db.dataSource.undoLastMigration();

      const after = await snapshot(db.dataSource, tables);
      expect(after).toEqual(before);
      expect(after.rows).toEqual(before.rows);
      expect(
        await db.dataSource.query(`SELECT name FROM sqlite_master WHERE name = 'telegram_history'`),
      ).toEqual([]);
      // El prefijo anterior sigue siendo una base valida.
      expect(() => validateDatabase(db.path)).not.toThrow();
    } finally {
      await db.cleanup();
    }
  });
});
