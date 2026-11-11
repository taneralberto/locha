import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { AccountService } from '../src/accounts/account.service';
import { backupDatabase, restoreDatabase, validateDatabase } from '../src/data/backup';
import { buildDataSourceOptions } from '../src/data/data-source';
import { LedgerOperations1775260800000 } from '../src/data/migrations/1775260800000-LedgerOperations';
import { InitialSchema1767225600000 } from '../src/data/migrations/1767225600000-InitialSchema';
import { CaptureAndInference1769904000000 } from '../src/data/migrations/1769904000000-CaptureAndInference';
import { TelegramDelivery1772582400000 } from '../src/data/migrations/1772582400000-TelegramDelivery';
import { TransactionRunner } from '../src/data/transaction.runner';
import { FinancialService } from '../src/financial/financial.service';
import { LedgerOperation } from '../src/financial/ledger-operation.entity';
import { snapshot } from './helpers/schema-snapshot';
import { createTempDatabase, openDatabase } from './helpers/temp-database';

const A_MIGRATIONS = [InitialSchema1767225600000, CaptureAndInference1769904000000, TelegramDelivery1772582400000];

const TABLES = ['account', 'movement', 'capture', 'capture_event', 'ai_usage_day', 'telegram_inbox', 'telegram_outbox', 'telegram_cursor'];


describe('Migracion y backups B1', () => {
  it('restaura backup A completo, migra sin cambiar ninguna fila/esquema A, y restaura B1 con saldos iguales', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'locha-ledger-migration-'));
    const connections: DataSource[] = [];
    try {
      const source = join(directory, 'a.sqlite');
      const options = buildDataSourceOptions(source);
      const a = new DataSource({ ...options, migrations: A_MIGRATIONS });
      connections.push(a);
      await a.initialize();
      await a.runMigrations();
      const accounts = new AccountService(a, new TransactionRunner(a));
      const usd = await accounts.add({ name: 'Efectivo', currency: 'USD' });
      const ves = await accounts.add({ name: 'Banco', currency: 'VES' });
      const financialA = new FinancialService(new TransactionRunner(a));
      const old = await financialA.register({ sourceKey: 'legacy:source-key', accountId: usd.id, kind: 'expense', money: { currency: 'USD', minor: 900719925474099399n }, occurredOn: '2026-01-01' });
      await a.query(`INSERT INTO capture (id, chatId, sourceKey, state, kind, amount, currency, accountId, occurredOn, description, sourceText, createdAt, updatedAt)
        VALUES ('legacy-capture', '1', 'legacy:source-key', 'registered', 'expense', '9007199254740993.99', 'USD', ?, '2026-01-01', 'Historico', NULL, '2026-01-01', '2026-01-01')`, [usd.id]);
      await a.query(`INSERT INTO capture_event (id, eventId, chatId, state, reply, captureState, movementId, createdAt, updatedAt)
        VALUES ('legacy-event', 'telegram:1', '1', 'completed', 'Registrado', 'registered', ?, '2026-01-01', '2026-01-01')`, [old.movement.id]);
      await a.query(`INSERT INTO ai_usage_day VALUES ('2026-01-01', 1, 2000, 500, 5000)`);
      await a.query(`INSERT INTO telegram_inbox VALUES (1, '1', '1', NULL, '2026-01-01T12:00:00Z', 'processed', '2026-01-01', '2026-01-01')`);
      await a.query(`INSERT INTO telegram_outbox VALUES ('legacy-outbox', 1, '1', '1', 'Registrado', 'sent', 1, 0, NULL, '2026-01-01', '2026-01-01')`);
      await a.query(`INSERT INTO telegram_cursor VALUES ('polling', 1)`);
      const before = await snapshot(a, TABLES);
      expect(() => validateDatabase(source)).not.toThrow();
      const aCopy = join(directory, 'a-backup.sqlite');
      await backupDatabase(source, aCopy);
      const restoredPath = join(directory, 'restored-a.sqlite');
      await restoreDatabase(aCopy, restoredPath);
      const restored = await openDatabase(restoredPath);
      connections.push(restored);
      expect(await snapshot(restored, TABLES)).toEqual(before);
      const financial = new FinancialService(new TransactionRunner(restored));
      expect((await financial.balances('2026-01-01')).find((row) => row.accountId === usd.id)?.balance).toBe(-900719925474099399n);
      await financial.open({ sourceKey: 'b1:opening', accountId: usd.id, money: { currency: 'USD', minor: 900719925474100000n }, occurredOn: '2026-01-02' });
      const input = { sourceKey: 'b1:transfer', from: { accountId: usd.id, money: { currency: 'USD' as const, minor: 500n } }, to: { accountId: ves.id, money: { currency: 'VES' as const, minor: 200000n } }, fee: { accountId: usd.id, money: { currency: 'USD' as const, minor: 20n } }, occurredOn: '2026-01-03' };
      const operation = await financial.transfer(input);
      const balances = await financial.balances('2026-01-03');
      expect(balances.map((row) => row.balance)).toEqual([200000n, 81n]);
      const bCopy = join(directory, 'b-backup.sqlite');
      await backupDatabase(restoredPath, bCopy);
      const bPath = join(directory, 'restored-b.sqlite');
      await restoreDatabase(bCopy, bPath);
      const b = await openDatabase(bPath);
      connections.push(b);
      const financialB = new FinancialService(new TransactionRunner(b));
      expect(await financialB.balances('2026-01-03')).toEqual(balances);
      expect(await financialB.transfer(input)).toMatchObject({ created: false, operation: { id: operation.operation.id, feeMovementId: operation.operation.feeMovementId } });
      expect(await snapshot(b, TABLES)).toEqual(await snapshot(restored, TABLES));
    } finally {
      for (const connection of connections) {
        if (connection.isInitialized) await connection.destroy();
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['table', 'migration'])('rechaza backup con B1 %s ausente pero la otra presente', async (missing) => {
    const database = await createTempDatabase();
    try {
      if (missing === 'table') {
        await database.dataSource.query('DROP TABLE ledger_operation');
      } else {
        await database.dataSource.query('DELETE FROM migrations WHERE name = ?', [new LedgerOperations1775260800000().name]);
      }
      expect(() => validateDatabase(database.path)).toThrow(/ledger_operation/);
    } finally {
      await database.cleanup();
    }
  });

  it('fresh: deltas TEXT, indice parcial y restricciones de forma/FK con borrado restringido', async () => {
    const database = await createTempDatabase([...A_MIGRATIONS, LedgerOperations1775260800000]);
    try {
      const ds = database.dataSource;
      const accounts = new AccountService(ds, database.transactions);
      const from = await accounts.add({ name: 'Origen', currency: 'USD' });
      const to = await accounts.add({ name: 'Destino', currency: 'VES' });
      const financial = new FinancialService(database.transactions);
      const operation = await financial.transfer({ sourceKey: 'valid', from: { accountId: from.id, money: { currency: 'USD', minor: 100n } }, to: { accountId: to.id, money: { currency: 'VES', minor: 40000n } }, fee: { accountId: from.id, money: { currency: 'USD', minor: 1n } }, occurredOn: '2026-11-10' });
      const columns = await ds.query(`PRAGMA table_info('ledger_operation')`);
      expect(columns.filter((column: { name: string }) => ['deltaMinor', 'destinationDeltaMinor'].includes(column.name)).map((column: { type: string }) => column.type.toLowerCase())).toEqual(['text', 'text']);
      for (const account of [from, to]) {
        await expect(ds.query('DELETE FROM account WHERE id = ?', [account.id])).rejects.toThrow(/FOREIGN KEY/);
      }
      await expect(ds.query('DELETE FROM movement WHERE id = ?', [operation.operation.feeMovementId])).rejects.toThrow(/FOREIGN KEY/);
      const repository = ds.getRepository(LedgerOperation);
      const base = { ...operation.operation, id: randomUUID(), sourceKey: 'invalid', feeMovementId: null };
      const invalid: Partial<LedgerOperation>[] = [
        { kind: 'opening' }, { deltaMinor: 0n }, { deltaMinor: 1n },
        { destinationDeltaMinor: 0n }, { destinationDeltaMinor: -1n },
        { destinationAccountId: null }, { destinationCurrency: null }, { destinationDeltaMinor: null },
        { destinationAccountId: from.id }, { accountId: 'missing' },
        { feeMovementId: 'missing' },
        { destinationCurrency: 'USD', destinationDeltaMinor: 99n },
      ];
      for (const change of invalid) {
        await expect(repository.save(repository.create({ ...base, ...change }))).rejects.toThrow();
      }
      const opened = await financial.open({ sourceKey: 'open', accountId: from.id, money: { currency: 'USD', minor: 0n }, occurredOn: '2026-11-10' });
      await expect(repository.save(repository.create({ ...opened.operation, id: randomUUID(), sourceKey: 'duplicate' }))).rejects.toThrow(/UNIQUE/);
      await ds.undoLastMigration();
      expect((await ds.query(`SELECT name FROM sqlite_master WHERE name = 'ledger_operation'`))).toEqual([]);
      expect((await ds.query('SELECT * FROM movement'))).toHaveLength(1);
    } finally {
      await database.cleanup();
    }
  });
});
