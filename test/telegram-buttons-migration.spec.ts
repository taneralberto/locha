import { dirname, join } from 'node:path';
import { DataSource } from 'typeorm';
import { backupDatabase, restoreDatabase, validateDatabase } from '../src/data/backup';
import { buildDataSourceOptions } from '../src/data/data-source';
import { TelegramButtons1793000000000 } from '../src/data/migrations/1793000000000-TelegramButtons';
import { createTempDatabase, openDatabase } from './helpers/temp-database';

const migrations = buildDataSourceOptions(':memory:').migrations as Function[];
/**
 * El prefijo B8: todo hasta la migracion de los botones, buscada por su nombre (no
 * por su posicion, que cambia con cada migracion nueva).
 */
const indiceB9 = migrations.findIndex(
  (migration) => new (migration as new () => { name: string })().name === new TelegramButtons1793000000000().name,
);
const hastaB8 = migrations.slice(0, indiceB9);

/**
 * Unidad 1 (botones inline de Telegram): el teclado de la entrega, su id de mensaje y
 * la pulsacion de boton. La migracion es **aditiva**: anade columnas y no reescribe
 * ni una fila de las que ya existian.
 */
describe('Migracion de los botones inline de Telegram', () => {
  it('anade las columnas sin tocar las filas que ya estaban', async () => {
    const db = await createTempDatabase(hastaB8);
    const connections: DataSource[] = [];
    try {
      const outboxColumns = await db.dataSource.query<{ name: string }[]>(
        `PRAGMA table_info("telegram_outbox")`,
      );
      expect(outboxColumns.map((column) => column.name)).not.toContain('markup');
      expect(outboxColumns.map((column) => column.name)).not.toContain('messageId');
      const inboxColumns = await db.dataSource.query<{ name: string }[]>(
        `PRAGMA table_info("telegram_inbox")`,
      );
      expect(inboxColumns.map((column) => column.name)).not.toContain('callback');

      // Las filas se insertan en SQL plano: la entidad todavia no conoce las columnas
      // nuevas de B9.
      await db.dataSource.query(
        `INSERT INTO telegram_outbox (id, updateId, chatId, userId, text, state, attempts, nextAttemptAt, lastError, createdAt, updatedAt)
         VALUES ('entrega', 10, '111', '111', 'respuesta', 'pending', 0, 0, NULL, '2026-11-10 00:00:00', '2026-11-10 00:00:00')`,
      );
      await db.dataSource.query(
        `INSERT INTO telegram_inbox (updateId, chatId, userId, text, receivedAt, state, createdAt, updatedAt)
         VALUES (11, '111', '111', 'hola', '2026-11-10T20:00:00.000Z', 'accepted', '2026-11-10 00:00:00', '2026-11-10 00:00:00')`,
      );
      const before = {
        outbox: await db.dataSource.query(
          `SELECT id, updateId, chatId, userId, text, state, attempts, nextAttemptAt, lastError, createdAt, updatedAt FROM telegram_outbox`,
        ),
        inbox: await db.dataSource.query(
          `SELECT updateId, chatId, userId, text, receivedAt, state, createdAt, updatedAt FROM telegram_inbox`,
        ),
      };

      // La base B8 abierta con todas las migraciones migra a B9.
      const upgraded = await openDatabase(db.path);
      connections.push(upgraded);

      const afterOutbox = await upgraded.query<{ name: string }[]>(
        `PRAGMA table_info("telegram_outbox")`,
      );
      expect(afterOutbox.map((column) => column.name)).toContain('markup');
      expect(afterOutbox.map((column) => column.name)).toContain('messageId');
      const afterInbox = await upgraded.query<{ name: string }[]>(
        `PRAGMA table_info("telegram_inbox")`,
      );
      expect(afterInbox.map((column) => column.name)).toContain('callback');
      // Las filas de B8 siguen iguales (las columnas nuevas vienen vacias).
      expect(
        await upgraded.query(
          `SELECT id, updateId, chatId, userId, text, state, attempts, nextAttemptAt, lastError, createdAt, updatedAt FROM telegram_outbox`,
        ),
      ).toEqual(before.outbox);
      expect(
        await upgraded.query(
          `SELECT updateId, chatId, userId, text, receivedAt, state, createdAt, updatedAt FROM telegram_inbox`,
        ),
      ).toEqual(before.inbox);
      expect(() => validateDatabase(db.path)).not.toThrow();
    } finally {
      for (const connection of connections) if (connection.isInitialized) await connection.destroy();
      await db.cleanup();
    }
  });

  it('una copia tomada en B9 conserva el teclado, el id de mensaje y la pulsacion', async () => {
    const db = await createTempDatabase();
    const connections: DataSource[] = [];
    try {
      // Una entrega con su teclado y su id de mensaje, y una pulsacion pendiente.
      await db.dataSource.query(
        `INSERT INTO telegram_outbox (id, updateId, chatId, userId, text, markup, messageId, state, attempts, nextAttemptAt, lastError, createdAt, updatedAt)
         VALUES ('entrega', 10, '111', '111', 'respuesta', '[[{"text":"Si","callback_data":"accion:si"}]]', 1001, 'sent', 0, 0, NULL, '2026-11-10 00:00:00', '2026-11-10 00:00:00')`,
      );
      await db.dataSource.query(
        `INSERT INTO telegram_inbox (updateId, chatId, userId, text, callback, receivedAt, state, createdAt, updatedAt)
         VALUES (11, '111', '111', NULL, '{"callbackId":"cb-11","data":"accion:si","messageId":1001}', '2026-11-10T20:00:00.000Z', 'accepted', '2026-11-10 00:00:00', '2026-11-10 00:00:00')`,
      );

      const backup = join(dirname(db.path), 'copia.sqlite');
      const restoredPath = join(dirname(db.path), 'restaurada.sqlite');
      await backupDatabase(db.path, backup);
      await restoreDatabase(backup, restoredPath);
      const restored = await openDatabase(restoredPath);
      connections.push(restored);

      expect(() => validateDatabase(restoredPath)).not.toThrow();
      expect(
        await restored.query(`SELECT text, markup, messageId FROM telegram_outbox`),
      ).toEqual([
        {
          text: 'respuesta',
          markup: '[[{"text":"Si","callback_data":"accion:si"}]]',
          messageId: 1001,
        },
      ]);
      expect(
        await restored.query(`SELECT text, callback, state FROM telegram_inbox`),
      ).toEqual([
        {
          text: null,
          callback: '{"callbackId":"cb-11","data":"accion:si","messageId":1001}',
          state: 'accepted',
        },
      ]);
    } finally {
      for (const connection of connections) if (connection.isInitialized) await connection.destroy();
      await db.cleanup();
    }
  });

  it('una copia anterior a B9 tambien se restaura y migra', async () => {
    const db = await createTempDatabase(hastaB8);
    const connections: DataSource[] = [];
    try {
      await db.dataSource.query(
        `INSERT INTO telegram_outbox (id, updateId, chatId, userId, text, state, attempts, nextAttemptAt, lastError, createdAt, updatedAt)
         VALUES ('entrega', 10, '111', '111', 'respuesta', 'pending', 0, 0, NULL, '2026-11-10 00:00:00', '2026-11-10 00:00:00')`,
      );

      const backupPreB9 = join(dirname(db.path), 'pre-b9.sqlite');
      await backupDatabase(db.path, backupPreB9);
      const restauradaPreB9 = join(dirname(db.path), 'pre-b9-restaurada.sqlite');
      await restoreDatabase(backupPreB9, restauradaPreB9);
      const antesDeB9 = await openDatabase(restauradaPreB9);
      connections.push(antesDeB9);
      expect(() => validateDatabase(restauradaPreB9)).not.toThrow();
      const columnas = await antesDeB9.query<{ name: string }[]>(
        `PRAGMA table_info("telegram_outbox")`,
      );
      expect(columnas.map((column) => column.name)).toContain('markup');
    } finally {
      for (const connection of connections) if (connection.isInitialized) await connection.destroy();
      await db.cleanup();
    }
  });

  it.each(['columnas', 'marcador'])('rechaza B9 parcial: %s', async (missing) => {
    const db = await createTempDatabase();
    try {
      if (missing === 'marcador') {
        await db.dataSource.query('DELETE FROM migrations WHERE name = ?', [
          new TelegramButtons1793000000000().name,
        ]);
      } else {
        await db.dataSource.query(`ALTER TABLE "telegram_outbox" DROP COLUMN "markup"`);
      }
      expect(() => validateDatabase(db.path)).toThrow(/B9/);
    } finally {
      await db.cleanup();
    }
  });

  it('el down descarta las pulsaciones pendientes y quita las columnas', async () => {
    // El down arranca en B9: es la ultima migracion.
    const db = await createTempDatabase();
    try {
      await db.dataSource.query(
        `INSERT INTO telegram_outbox (id, updateId, chatId, userId, text, markup, messageId, state, attempts, nextAttemptAt, lastError, createdAt, updatedAt)
         VALUES ('entrega', 10, '111', '111', 'respuesta', '[[{"text":"Si","callback_data":"accion:si"}]]', 1001, 'sent', 0, 0, NULL, '2026-11-10 00:00:00', '2026-11-10 00:00:00')`,
      );
      await db.dataSource.query(
        `INSERT INTO telegram_inbox (updateId, chatId, userId, text, callback, receivedAt, state, createdAt, updatedAt)
         VALUES (11, '111', '111', NULL, '{"callbackId":"cb-11","data":"accion:si","messageId":1001}', '2026-11-10T20:00:00.000Z', 'accepted', '2026-11-10 00:00:00', '2026-11-10 00:00:00')`,
      );
      const before = await db.dataSource.query(
        `SELECT id, updateId, chatId, userId, text, state FROM telegram_outbox`,
      );

      await db.dataSource.undoLastMigration();

      // La pulsacion pendiente se descarta antes de quitar su columna.
      const inbox = await db.dataSource.query<{ state: string }[]>(`SELECT state FROM telegram_inbox`);
      expect(inbox).toEqual([{ state: 'discarded' }]);
      const outboxColumns = await db.dataSource.query<{ name: string }[]>(
        `PRAGMA table_info("telegram_outbox")`,
      );
      expect(outboxColumns.map((column) => column.name)).not.toContain('markup');
      expect(outboxColumns.map((column) => column.name)).not.toContain('messageId');
      const inboxColumns = await db.dataSource.query<{ name: string }[]>(
        `PRAGMA table_info("telegram_inbox")`,
      );
      expect(inboxColumns.map((column) => column.name)).not.toContain('callback');
      // Las entregas ya escritas no se tocan.
      expect(await db.dataSource.query(`SELECT id, updateId, chatId, userId, text, state FROM telegram_outbox`)).toEqual(before);
    } finally {
      await db.cleanup();
    }
  });
});
