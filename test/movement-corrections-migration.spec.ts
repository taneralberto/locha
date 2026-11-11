import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { AccountService } from '../src/accounts/account.service';
import { backupDatabase, restoreDatabase, validateDatabase } from '../src/data/backup';
import { buildDataSourceOptions } from '../src/data/data-source';
import { InitialSchema1767225600000 } from '../src/data/migrations/1767225600000-InitialSchema';
import { CaptureAndInference1769904000000 } from '../src/data/migrations/1769904000000-CaptureAndInference';
import { TelegramDelivery1772582400000 } from '../src/data/migrations/1772582400000-TelegramDelivery';
import { LedgerOperations1775260800000 } from '../src/data/migrations/1775260800000-LedgerOperations';
import { MovementCorrections1777939200000 } from '../src/data/migrations/1777939200000-MovementCorrections';
import { TransactionRunner } from '../src/data/transaction.runner';
import { FinancialService } from '../src/financial/financial.service';
import { MovementRevision } from '../src/financial/movement-revision.entity';
import { snapshot } from './helpers/schema-snapshot';
import { createTempDatabase, openDatabase } from './helpers/temp-database';

const A = [InitialSchema1767225600000, CaptureAndInference1769904000000, TelegramDelivery1772582400000];
const B1 = [...A, LedgerOperations1775260800000];

const TABLES = ['account', 'movement', 'ledger_operation', 'capture', 'capture_event', 'ai_usage_day', 'telegram_inbox', 'telegram_outbox', 'telegram_cursor'];


describe('Migracion y backups B2', () => {
  it.each(['A', 'B1'])('restaura prefijo %s, migra aditivamente y conserva historial/saldos B2 al restaurar', async (prefix) => {
    const directory = mkdtempSync(join(tmpdir(), 'locha-b2-migration-'));
    const connections: DataSource[] = [];
    try {
      const sourcePath = join(directory, 'source.sqlite');
      const source = new DataSource({ ...buildDataSourceOptions(sourcePath), migrations: prefix === 'A' ? A : B1 });
      connections.push(source);
      await source.initialize();
      await source.runMigrations();
      const transactions = new TransactionRunner(source);
      const accounts = new AccountService(source, transactions);
      const account = await accounts.add({ name: 'Efectivo', currency: 'USD' });
      const other = await accounts.add({ name: 'Banco', currency: 'VES' });
      const old = new FinancialService(transactions);
      const input = { sourceKey: 'legacy', accountId: account.id, kind: 'income' as const, money: { currency: 'USD' as const, minor: 900719925474099399n }, occurredOn: '2026-11-01' };
      const movement = (await old.register(input)).movement;
      if (prefix === 'B1') {
        await old.open({ sourceKey: 'open', accountId: account.id, money: { currency: 'USD', minor: -100n }, occurredOn: '2026-11-01' });
        await old.transfer({ sourceKey: 'transfer', from: { accountId: account.id, money: { currency: 'USD', minor: 500n } }, to: { accountId: other.id, money: { currency: 'VES', minor: 10000n } }, fee: { accountId: account.id, money: { currency: 'USD', minor: 20n } }, occurredOn: '2026-11-02' });
      }
      await backupDatabase(sourcePath, join(directory, 'prefix-backup.sqlite'));
      const restoredPath = join(directory, 'restored.sqlite');
      await restoreDatabase(join(directory, 'prefix-backup.sqlite'), restoredPath);
      // Open without migration to compare the original schema and rows at the B1 seam.
      const restored = new DataSource({ ...buildDataSourceOptions(restoredPath), migrations: B1 });
      connections.push(restored);
      await restored.initialize();
      await restored.runMigrations();
      const before = await snapshot(restored, TABLES);
      await restored.destroy();
      const b2 = await openDatabase(restoredPath);
      connections.push(b2);
      expect(await snapshot(b2, TABLES)).toEqual(before);
      const financial = new FinancialService(new TransactionRunner(b2));
      await financial.editMovement({ sourceKey: 'edit', movementId: movement.id, expectedRevision: 0, amountMinor: 9007199254740993123456n, occurredOn: '2026-10-31', category: 'Etiqueta', reason: 'Correccion' });
      await financial.reconcile({ sourceKey: 'rec', accountId: account.id, currency: 'USD', targetMinor: -500n, occurredOn: '2026-11-03', reason: 'Conteo' });
      await financial.voidMovement({ sourceKey: 'void', movementId: movement.id, expectedRevision: 1, reason: 'Duplicado' });
      const history = await financial.movementHistory(movement.id);
      const balances = await financial.balances('2026-11-30');
      const reconciliations = await financial.reconciliations();
      await backupDatabase(restoredPath, join(directory, 'b2-backup.sqlite'));
      const finalPath = join(directory, 'final.sqlite');
      await restoreDatabase(join(directory, 'b2-backup.sqlite'), finalPath);
      const final = await openDatabase(finalPath);
      connections.push(final);
      const service = new FinancialService(new TransactionRunner(final));
      expect(await service.movementHistory(movement.id)).toEqual(history);
      expect(await service.balances('2026-11-30')).toEqual(balances);
      expect(await service.reconciliations()).toEqual(reconciliations);
      expect((await service.register(input)).created).toBe(false);
      expect(() => validateDatabase(finalPath)).not.toThrow();
    } finally {
      for (const connection of connections) if (connection.isInitialized) await connection.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['movement_revision', 'balance_reconciliation', 'marker', 'B1'])('rechaza B2 inconsistente: %s', async (missing) => {
    const db = await createTempDatabase();
    try {
      if (missing === 'marker' || missing === 'B1') {
        await db.dataSource.query('DELETE FROM migrations WHERE name = ?', [missing === 'marker' ? new MovementCorrections1777939200000().name : new LedgerOperations1775260800000().name]);
        if (missing === 'B1') await db.dataSource.query('DROP TABLE ledger_operation');
      } else await db.dataSource.query(`DROP TABLE ${missing}`);
      expect(() => validateDatabase(db.path)).toThrow(/B2/);
    } finally { await db.cleanup(); }
  });

  it('columnas monetarias TEXT, forma completa/nula, indices unicos, FK y down aditivo', async () => {
    const db = await createTempDatabase([...B1, MovementCorrections1777939200000]);
    try {
      const account = await new AccountService(db.dataSource, db.transactions).add({ name: 'Efectivo', currency: 'USD' });
      const service = new FinancialService(db.transactions);
      const movement = (await service.register({ sourceKey: 'original', accountId: account.id, kind: 'expense', money: { currency: 'USD', minor: 1n }, occurredOn: '2026-11-01' })).movement;
      const revision = (await service.editMovement({ sourceKey: 'edit', movementId: movement.id, expectedRevision: 0, amountMinor: 2n, occurredOn: '2026-11-02', reason: 'Corregir' })).revision;
      const repository = db.dataSource.getRepository(MovementRevision);
      const invalid: Partial<MovementRevision>[] = [
        { kind: 'void' }, { amountMinor: null }, { occurredOn: null }, { amountMinor: 0n }, { amountMinor: -1n },
        { expectedRevision: -1 }, { revision: 0 }, { revision: 1.5 }, { expectedRevision: 2 },
        { reason: '' }, { category: 'x'.repeat(81) }, { movementId: 'missing' },
      ];
      for (const change of invalid) {
        await expect(repository.save(repository.create({ ...revision, id: randomUUID(), sourceKey: randomUUID(), revision: 2, expectedRevision: 1, ...change }))).rejects.toThrow();
      }
      await expect(repository.save(repository.create({ ...revision, id: randomUUID(), sourceKey: 'duplicate-revision' }))).rejects.toThrow(/UNIQUE/);
      await expect(repository.save(repository.create({ ...revision, id: randomUUID(), revision: 2, expectedRevision: 1 }))).rejects.toThrow(/UNIQUE/);
      await expect(db.dataSource.query('DELETE FROM movement WHERE id = ?', [movement.id])).rejects.toThrow(/FOREIGN KEY/);
      for (const [table, names] of [['movement_revision', ['amountMinor']], ['balance_reconciliation', ['targetMinor', 'beforeMinor', 'deltaMinor']]] as const) {
        const columns = await db.dataSource.query<{ name: string; type: string }[]>(`PRAGMA table_info(${table})`);
        expect(columns.filter((column) => (names as readonly string[]).includes(column.name)).every((column) => column.type.toLowerCase() === 'text')).toBe(true);
      }
      for (const bad of ['-0', '01', '1.2', '1e3', '', '--1']) {
        await expect(db.dataSource.query(`INSERT INTO balance_reconciliation (id, sourceKey, accountId, currency, targetMinor, beforeMinor, deltaMinor, occurredOn, reason, createdAt) VALUES (?, ?, ?, 'USD', ?, '0', '0', '2026-11-01', 'Conteo', '2026-11-01')`, [randomUUID(), randomUUID(), account.id, bad])).rejects.toThrow();
      }
      const before = await snapshot(db.dataSource, TABLES);
      await db.dataSource.undoLastMigration();
      expect(await snapshot(db.dataSource, TABLES)).toEqual(before);
      expect(await db.dataSource.query(`SELECT name FROM sqlite_master WHERE name IN ('movement_revision', 'balance_reconciliation')`)).toEqual([]);
    } finally { await db.cleanup(); }
  });
});
