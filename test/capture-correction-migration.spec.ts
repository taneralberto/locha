import { dirname, join } from 'node:path';
import { DataSource } from 'typeorm';
import { AccountService } from '../src/accounts/account.service';
import { correctionButtons } from '../src/capture/correction';
import { decodeMetadata, encodeMetadata } from '../src/capture/correction-metadata';
import { backupDatabase, restoreDatabase, validateDatabase } from '../src/data/backup';
import { buildDataSourceOptions } from '../src/data/data-source';
import { ExpenseCorrection1792000000000 } from '../src/data/migrations/1792000000000-ExpenseCorrection';
import { FinancialService } from '../src/financial/financial.service';
import { createTempDatabase, openDatabase } from './helpers/temp-database';

const migrations = buildDataSourceOptions(':memory:').migrations as Function[];
/**
 * Los prefijos que usan estas pruebas, buscados por el **nombre** de la migracion (no
 * por su posicion, que cambia con cada migracion nueva): `hastaB7` es justo antes de
 * la correccion de gasto y `hastaB8` la incluye.
 */
const indiceB8 = migrations.findIndex(
  (migration) => new (migration as new () => { name: string })().name === new ExpenseCorrection1792000000000().name,
);
const hastaB7 = migrations.slice(0, indiceB8);
const hastaB8 = migrations.slice(0, indiceB8 + 1);
/** Las columnas historicas del borrador: la columna nueva se anade aparte. */
const CAPTURE_COLUMNS =
  'id, chatId, sourceKey, state, kind, amount, currency, accountId, occurredOn, description, sourceText, debtPayload, createdAt, updatedAt';

/**
 * Unidad 2: la columna que ancla una correccion de gasto en el borrador de captura.
 * La migracion es **aditiva**: anade una columna y no reescribe ni una fila de las que
 * ya existian.
 */
describe('Migracion de la correccion de gasto', () => {
  it('anade la columna del ancla sin tocar las filas que ya estaban', async () => {
    const db = await createTempDatabase(hastaB7);
    const connections: DataSource[] = [];
    try {
      const before = await db.dataSource.query<{ name: string }[]>(`PRAGMA table_info("capture")`);
      expect(before.map((column) => column.name)).not.toContain('correctionTargetEventId');
      const beforeEvent = await db.dataSource.query<{ name: string }[]>(
        `PRAGMA table_info("capture_event")`,
      );
      expect(beforeEvent.map((column) => column.name)).not.toContain('metadata');
      const account = await new AccountService(db.dataSource, db.transactions).add({
        name: 'Bolivares',
        currency: 'VES',
      });
      await new FinancialService(db.transactions).register({
        sourceKey: 'gasto',
        accountId: account.id,
        kind: 'expense',
        money: { currency: 'VES', minor: 150000n },
        occurredOn: '2026-11-02',
        description: 'Cena',
      });
      // Un borrador normal de B7: la migracion no lo toca.
      await db.dataSource.query(
        `INSERT INTO capture (id, chatId, sourceKey, state, kind, amount, currency, accountId, occurredOn, description, sourceText, createdAt, updatedAt)
         VALUES ('normal', 'chat-1', 'capture:normal', 'awaiting_confirmation', 'expense', '10', 'VES', ?, '2026-11-02', 'Cena', 'Cena 10 bs', '2026-11-02 00:00:00', '2026-11-02 00:00:00')`,
        [account.id],
      );
      const antes = await db.dataSource.query(`SELECT ${CAPTURE_COLUMNS} FROM capture`);

      // La base B7 abierta con todas las migraciones migra a B8.
      const upgraded = await openDatabase(db.path);
      connections.push(upgraded);

      const after = await upgraded.query<{ name: string }[]>(`PRAGMA table_info("capture")`);
      expect(after.map((column) => column.name)).toContain('correctionTargetEventId');
      const afterEvent = await upgraded.query<{ name: string }[]>(
        `PRAGMA table_info("capture_event")`,
      );
      expect(afterEvent.map((column) => column.name)).toContain('metadata');
      // Las filas de B7 siguen iguales (la columna nueva viene vacia).
      expect(await upgraded.query(`SELECT ${CAPTURE_COLUMNS} FROM capture`)).toEqual(antes);
      expect(() => validateDatabase(db.path)).not.toThrow();
    } finally {
      for (const connection of connections) if (connection.isInitialized) await connection.destroy();
      await db.cleanup();
    }
  });

  it('una base B7 poblada migra y su copia se restaura', async () => {
    const db = await createTempDatabase(hastaB8);
    const connections: DataSource[] = [];
    try {
      const account = await new AccountService(db.dataSource, db.transactions).add({
        name: 'Bolivares',
        currency: 'VES',
      });
      await new FinancialService(db.transactions).register({
        sourceKey: 'gasto',
        accountId: account.id,
        kind: 'expense',
        money: { currency: 'VES', minor: 150000n },
        occurredOn: '2026-11-02',
      });
      await db.dataSource.runMigrations();
      // La copia se toma ya en B8 y con una correccion pendiente.
      const upgraded = await openDatabase(db.path);
      connections.push(upgraded);
      await upgraded.query(
        `INSERT INTO capture (id, chatId, sourceKey, state, kind, amount, currency, accountId, occurredOn, description, sourceText, correctionTargetEventId, createdAt, updatedAt)
         VALUES ('pendiente', 'chat-1', 'capture:correccion', 'awaiting_confirmation', 'expense_correction', '2', 'USDT', ?, NULL, NULL, 'Mentira, fue 2 USDT', 'evento:1', '2026-11-02 00:00:00', '2026-11-02 00:00:00')`,
        [account.id],
      );

      const backup = join(dirname(db.path), 'copia.sqlite');
      const restoredPath = join(dirname(db.path), 'restaurada.sqlite');
      await backupDatabase(db.path, backup);
      await restoreDatabase(backup, restoredPath);
      const restored = await openDatabase(restoredPath);
      connections.push(restored);

      expect(() => validateDatabase(restoredPath)).not.toThrow();
      const columns = await restored.query<{ name: string }[]>(`PRAGMA table_info("capture")`);
      expect(columns.map((column) => column.name)).toContain('correctionTargetEventId');
      expect(await restored.query(`SELECT amountMinor FROM movement`)).toEqual([{ amountMinor: '150000' }]);
      // La correccion pendiente viaja con la copia.
      expect(await restored.query(`SELECT kind, state, correctionTargetEventId FROM capture`)).toEqual([
        { kind: 'expense_correction', state: 'awaiting_confirmation', correctionTargetEventId: 'evento:1' },
      ]);
    } finally {
      for (const connection of connections) if (connection.isInitialized) await connection.destroy();
      await db.cleanup();
    }
  });

  it('una copia B8 real conserva los metadatos del evento y sus botones', async () => {
    // La base se abre en B8: la copia se toma de verdad en ese esquema.
    const db = await createTempDatabase(hastaB8);
    const connections: DataSource[] = [];
    try {
      const account = await new AccountService(db.dataSource, db.transactions).add({
        name: 'Bolivares',
        currency: 'VES',
      });
      const movement = await new FinancialService(db.transactions).register({
        sourceKey: 'gasto',
        accountId: account.id,
        kind: 'expense',
        money: { currency: 'VES', minor: 150000n },
        occurredOn: '2026-11-02',
        description: 'Cena',
      });
      const metadata = encodeMetadata({ kind: 'offer', origin: 'capture:origen' });
      await db.dataSource.query(
        `INSERT INTO capture_event (id, eventId, chatId, state, reply, captureState, movementId, metadata, createdAt, updatedAt)
         VALUES ('evento:1', 'telegram:1', 'chat-1', 'completed', 'Registrado', 'registered', ?, ?, '2026-11-02 00:00:00', '2026-11-02 00:00:00')`,
        [movement.movement.id, metadata],
      );

      const backup = join(dirname(db.path), 'copia.sqlite');
      const restoredPath = join(dirname(db.path), 'restaurada.sqlite');
      await backupDatabase(db.path, backup);
      await restoreDatabase(backup, restoredPath);
      expect(() => validateDatabase(restoredPath)).not.toThrow();

      const restored = await openDatabase(restoredPath);
      connections.push(restored);
      const rows = await restored.query<{ metadata: string }[]>(`SELECT metadata FROM capture_event`);
      expect(rows).toEqual([{ metadata }]);
      // Los metadatos siguen siendo legibles: el boton de la oferta se puede sacar.
      const leido = decodeMetadata(rows[0]!.metadata);
      expect(leido).toEqual({ kind: 'offer', origin: 'capture:origen' });
      expect(correctionButtons(leido)).toEqual([[{ text: 'Corregir este gasto', data: 'corr:iniciar' }]]);
    } finally {
      for (const connection of connections) if (connection.isInitialized) await connection.destroy();
      await db.cleanup();
    }
  });

  it.each(['columna', 'marcador'])('rechaza B8 parcial: %s', async (missing) => {
    const db = await createTempDatabase();
    try {
      if (missing === 'marcador') {
        await db.dataSource.query('DELETE FROM migrations WHERE name = ?', [
          new ExpenseCorrection1792000000000().name,
        ]);
      } else {
        await db.dataSource.query(`ALTER TABLE "capture" DROP COLUMN "correctionTargetEventId"`);
      }
      expect(() => validateDatabase(db.path)).toThrow(/B8/);
    } finally {
      await db.cleanup();
    }
  });

  it('el down cancela los borradores correctivos vivos y no toca los originales', async () => {
    // El down historico es el de B8: la base se abre en ese prefijo, no en el ultimo.
    const db = await createTempDatabase(hastaB8);
    try {
      const account = await new AccountService(db.dataSource, db.transactions).add({
        name: 'Bolivares',
        currency: 'VES',
      });
      const movement = await new FinancialService(db.transactions).register({
        sourceKey: 'gasto',
        accountId: account.id,
        kind: 'expense',
        money: { currency: 'VES', minor: 150000n },
        occurredOn: '2026-11-02',
        description: 'Cena',
      });
      await db.dataSource.query(
        `INSERT INTO capture (id, chatId, sourceKey, state, kind, amount, currency, accountId, occurredOn, description, sourceText, correctionTargetEventId, createdAt, updatedAt)
         VALUES ('borrador', 'chat-1', 'capture:x', 'awaiting_confirmation', 'expense_correction', '2', 'USDT', ?, NULL, NULL, 'Mentira, fue 2 USDT', 'evento:1', '2026-11-02 00:00:00', '2026-11-02 00:00:00')`,
        [account.id],
      );
      const movements = await db.dataSource.query(`SELECT * FROM movement`);

      await db.dataSource.undoLastMigration();

      const rows = await db.dataSource.query<{ state: string; amount: string | null }[]>(
        `SELECT state, amount FROM capture`,
      );
      expect(rows).toEqual([{ state: 'cancelled', amount: null }]);
      const columns = await db.dataSource.query<{ name: string }[]>(`PRAGMA table_info("capture")`);
      expect(columns.map((column) => column.name)).not.toContain('correctionTargetEventId');
      // Los movimientos registrados no se tocan.
      expect(await db.dataSource.query(`SELECT * FROM movement`)).toEqual(movements);
      expect(movement.movement.id).not.toBe('');
    } finally {
      await db.cleanup();
    }
  });
});
