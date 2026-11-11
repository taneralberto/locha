import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { DataSource } from 'typeorm';
import { AccountService } from '../src/accounts/account.service';
import { BudgetService } from '../src/budgets/budget.service';
import { backupDatabase, restoreDatabase, validateDatabase } from '../src/data/backup';
import { InitialSchema1767225600000 } from '../src/data/migrations/1767225600000-InitialSchema';
import { CaptureAndInference1769904000000 } from '../src/data/migrations/1769904000000-CaptureAndInference';
import { TelegramDelivery1772582400000 } from '../src/data/migrations/1772582400000-TelegramDelivery';
import { LedgerOperations1775260800000 } from '../src/data/migrations/1775260800000-LedgerOperations';
import { MovementCorrections1777939200000 } from '../src/data/migrations/1777939200000-MovementCorrections';
import { Budgets1780617600000 } from '../src/data/migrations/1780617600000-Budgets';
import { TransactionRunner } from '../src/data/transaction.runner';
import { FinancialService } from '../src/financial/financial.service';
import { snapshot } from './helpers/schema-snapshot';
import { createTempDatabase, openDatabase } from './helpers/temp-database';

const A = [InitialSchema1767225600000, CaptureAndInference1769904000000, TelegramDelivery1772582400000];
const B1 = [...A, LedgerOperations1775260800000];
const B2 = [...B1, MovementCorrections1777939200000];


describe('Migracion y backups B3', () => {
  it.each([['A', A], ['B1', B1], ['B2', B2]] as const)('restaura prefijo %s, migra sin mutacion historica y restaura B3 con reportes/replay iguales', async (prefix, migrations) => {
    const db = await createTempDatabase([...migrations]);
    const connections: DataSource[] = [];
    try {
      const accounts = new AccountService(db.dataSource, db.transactions);
      const account = await accounts.add({ name: 'USDT', currency: 'USDT' });
      const other = await accounts.add({ name: 'USD', currency: 'USD' });
      const old = new FinancialService(db.transactions);
      const movement = (await old.register({ sourceKey: 'legacy', accountId: account.id, kind: 'expense', money: { currency: 'USDT', minor: 9007199254740993123456n }, occurredOn: '2026-11-01' })).movement;
      if (prefix !== 'A') {
        await old.open({ sourceKey: 'open', accountId: account.id, money: { currency: 'USDT', minor: -100n }, occurredOn: '2026-11-01' });
        await old.transfer({ sourceKey: 'transfer', from: { accountId: account.id, money: { currency: 'USDT', minor: 1000000n } }, to: { accountId: other.id, money: { currency: 'USD', minor: 100n } }, fee: { accountId: account.id, money: { currency: 'USDT', minor: 1n } }, occurredOn: '2026-11-02' });
      }
      if (prefix === 'B2') {
        await old.editMovement({ sourceKey: 'edit', movementId: movement.id, expectedRevision: 0, amountMinor: 9007199254740993123457n, occurredOn: '2026-11-03', category: 'Comida', reason: 'Categoria' });
        await old.reconcile({ sourceKey: 'rec', accountId: account.id, currency: 'USDT', targetMinor: -100n, occurredOn: '2026-11-03', reason: 'Conteo' });
      }
      const names = (await db.dataSource.query<{ name: string }[]>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('migrations', 'sqlite_sequence') ORDER BY name`)).map((row) => row.name);
      const before = await snapshot(db.dataSource, names);
      const backup = join(dirname(db.path), 'prefix-backup.sqlite');
      await backupDatabase(db.path, backup);
      const restoredPath = join(dirname(db.path), 'restored.sqlite');
      await restoreDatabase(backup, restoredPath);
      const upgraded = await openDatabase(restoredPath);
      connections.push(upgraded);
      expect(await snapshot(upgraded, names)).toEqual(before);
      const transactions = new TransactionRunner(upgraded);
      const financial = new FinancialService(transactions);
      const budgets = new BudgetService(transactions, financial);
      const input = { sourceKey: 'budget', name: 'Noviembre', currency: 'USDT' as const, limitMinor: 9007199254740993123456n, startsOn: '2026-11-01', endsOn: '2026-11-30' };
      const budget = (await budgets.create(input)).budget;
      await budgets.create({ ...input, sourceKey: 'category', category: 'Comida', limitMinor: 0n });
      const reports = await budgets.status({ on: '2026-11-30' });
      expect(reports.find((row) => row.budget.id === budget.id)!.spent).toBe(input.limitMinor + (prefix === 'A' ? 0n : prefix === 'B1' ? 1n : 2n));
      const definitions = await budgets.list();
      const balances = await financial.balances('2026-11-30');
      const history = await financial.movementHistory(movement.id);
      const b3Backup = join(dirname(db.path), 'b3-backup.sqlite');
      await backupDatabase(restoredPath, b3Backup);
      const finalPath = join(dirname(db.path), 'final.sqlite');
      await restoreDatabase(b3Backup, finalPath);
      const final = await openDatabase(finalPath);
      connections.push(final);
      const finalTransactions = new TransactionRunner(final);
      const finalFinancial = new FinancialService(finalTransactions);
      const finalBudgets = new BudgetService(finalTransactions, finalFinancial);
      expect(await finalBudgets.status({ on: '2026-11-30' })).toEqual(reports);
      expect(await finalBudgets.list()).toEqual(definitions);
      expect(await finalBudgets.create(input)).toMatchObject({ created: false, budget });
      expect(await finalFinancial.balances('2026-11-30')).toEqual(balances);
      expect(await finalFinancial.movementHistory(movement.id)).toEqual(history);
      expect(await snapshot(final, names)).toEqual(before);
      expect(() => validateDatabase(finalPath)).not.toThrow();
    } finally {
      for (const connection of connections) if (connection.isInitialized) await connection.destroy();
      await db.cleanup();
    }
  });

  it.each(['table', 'marker', 'B2', 'B1'])('rechaza B3 inconsistente: %s', async (missing) => {
    const db = await createTempDatabase();
    try {
      if (missing === 'table') await db.dataSource.query('DROP TABLE budget');
      if (missing === 'marker') await db.dataSource.query('DELETE FROM migrations WHERE name = ?', [new Budgets1780617600000().name]);
      if (missing === 'B2') {
        await db.dataSource.query('DROP TABLE movement_revision');
        await db.dataSource.query('DROP TABLE balance_reconciliation');
        await db.dataSource.query('DELETE FROM migrations WHERE name = ?', [new MovementCorrections1777939200000().name]);
      }
      if (missing === 'B1') {
        await db.dataSource.query('DROP TABLE ledger_operation');
        await db.dataSource.query('DELETE FROM migrations WHERE name = ?', [new LedgerOperations1775260800000().name]);
      }
      expect(() => validateDatabase(db.path)).toThrow(missing === 'B1' ? /B2/ : /B3/);
    } finally { await db.cleanup(); }
  });

  it('fresh: limite TEXT no negativo, unicidad, restricciones y down solo aditivo', async () => {
    const db = await createTempDatabase([...B2, Budgets1780617600000]);
    try {
      const columns = await db.dataSource.query<{ name: string; type: string }[]>('PRAGMA table_info(budget)');
      expect(columns.find((row) => row.name === 'limitMinor')!.type.toLowerCase()).toBe('text');
      const insert = (minor: string, category: string | null = null, name = 'Presupuesto') => db.dataSource.query(`INSERT INTO budget
        (id, sourceKey, name, currency, limitMinor, category, startsOn, endsOn, createdAt)
        VALUES (?, ?, ?, 'USDT', ?, ?, '2026-11-01', '2026-11-30', '2026-11-01')`, [randomUUID(), randomUUID(), name, minor, category]);
      await insert('0');
      await insert('9007199254740993123456');
      for (const bad of ['-1', '-0', '01', '1.2', '1e3', '']) await expect(insert(bad)).rejects.toThrow();
      await expect(insert('0', '')).rejects.toThrow();
      await expect(insert('0', 'c'.repeat(81))).rejects.toThrow();
      await expect(insert('0', null, '')).rejects.toThrow();
      await expect(db.dataSource.query(`INSERT INTO budget SELECT ?, sourceKey, name, currency, limitMinor, category, startsOn, endsOn, createdAt FROM budget LIMIT 1`, [randomUUID()])).rejects.toThrow(/UNIQUE/);
      const tables = (await db.dataSource.query<{ name: string }[]>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('budget', 'migrations', 'sqlite_sequence')`)).map((row) => row.name);
      const before = await snapshot(db.dataSource, tables);
      await db.dataSource.undoLastMigration();
      expect(await snapshot(db.dataSource, tables)).toEqual(before);
      expect(await db.dataSource.query(`SELECT name FROM sqlite_master WHERE name = 'budget'`)).toEqual([]);
      expect(() => validateDatabase(db.path)).not.toThrow();
    } finally { await db.cleanup(); }
  });
});
