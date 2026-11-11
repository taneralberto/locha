import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { DataSource } from 'typeorm';
import { AccountService } from '../src/accounts/account.service';
import { BudgetService } from '../src/budgets/budget.service';
import { backupDatabase, restoreDatabase, validateDatabase } from '../src/data/backup';
import { buildDataSourceOptions } from '../src/data/data-source';
import { GoalsAndSavings1783209600000 } from '../src/data/migrations/1783209600000-GoalsAndSavings';
import { TransactionRunner } from '../src/data/transaction.runner';
import { FinancialService } from '../src/financial/financial.service';
import { GoalService } from '../src/savings/goal.service';
import { SavingsService } from '../src/savings/savings.service';
import { snapshot } from './helpers/schema-snapshot';
import { createTempDatabase, openDatabase } from './helpers/temp-database';

const migrations = buildDataSourceOptions(':memory:').migrations as Function[];


describe('Migracion y backups B4', () => {
  it.each([['A', 3], ['B1', 4], ['B2', 5], ['B3', 6]] as const)('restaura prefijo %s, migra aditivo y restaura metas/historial/disponible/replay B4', async (prefix, count) => {
    const db = await createTempDatabase(migrations.slice(0, count));
    const connections: DataSource[] = [];
    try {
      const account = await new AccountService(db.dataSource, db.transactions).add({ name: 'USDT', currency: 'USDT' });
      const old = new FinancialService(db.transactions);
      const movement = (await old.register({ sourceKey: 'income', accountId: account.id, kind: 'income', money: { currency: 'USDT', minor: 9007199254740993123456n }, occurredOn: '2020-01-01' })).movement;
      if (count >= 4) await old.open({ sourceKey: 'open', accountId: account.id, money: { currency: 'USDT', minor: 1n }, occurredOn: '2020-01-01' });
      if (count >= 5) await old.editMovement({ sourceKey: 'edit', movementId: movement.id, expectedRevision: 0, amountMinor: 9007199254740993123457n, occurredOn: '2020-01-01', reason: 'Conteo' });
      if (prefix === 'B3') await new BudgetService(db.transactions, old).create({ sourceKey: 'budget', name: 'Historico', currency: 'USDT', limitMinor: 0n, startsOn: '2020-01-01', endsOn: '2099-12-31' });
      const tables = (await db.dataSource.query<{ name: string }[]>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('migrations', 'sqlite_sequence') ORDER BY name`)).map((row) => row.name);
      const before = await snapshot(db.dataSource, tables);
      const backup = join(dirname(db.path), 'prefix.sqlite');
      const restoredPath = join(dirname(db.path), 'upgraded.sqlite');
      await backupDatabase(db.path, backup);
      await restoreDatabase(backup, restoredPath);
      const upgraded = await openDatabase(restoredPath);
      connections.push(upgraded);
      expect(await snapshot(upgraded, tables)).toEqual(before);
      const transactions = new TransactionRunner(upgraded);
      const financial = new FinancialService(transactions);
      const goals = new GoalService(transactions);
      const savings = new SavingsService(transactions, financial, goals);
      const goalInput = { sourceKey: 'goal', name: 'Fondo', currency: 'USDT' as const, targetMinor: 9007199254740993123456n, targetOn: '2028-02-29' };
      const goal = (await goals.create(goalInput)).goal;
      const input = { sourceKey: 'reserve', goalId: goal.id, accountId: account.id, currency: 'USDT' as const, amountMinor: goal.targetMinor };
      const reserve = await savings.reserve(input);
      await savings.release({ ...input, sourceKey: 'release', amountMinor: 1n });
      await financial.reconcile({ sourceKey: 'deficit', accountId: account.id, currency: 'USDT', targetMinor: 1n, occurredOn: '2020-01-01', reason: 'Conteo' });
      const reports = { goals: await goals.list(), goalStatus: await savings.goalStatus(), status: await savings.status(), history: await savings.history(), balances: await financial.balances() };
      const b4Backup = join(dirname(db.path), 'b4.sqlite');
      const finalPath = join(dirname(db.path), 'final.sqlite');
      await backupDatabase(restoredPath, b4Backup);
      await restoreDatabase(b4Backup, finalPath);
      const final = await openDatabase(finalPath);
      connections.push(final);
      const finalTransactions = new TransactionRunner(final);
      const finalFinancial = new FinancialService(finalTransactions);
      const finalGoals = new GoalService(finalTransactions);
      const finalSavings = new SavingsService(finalTransactions, finalFinancial, finalGoals);
      expect({ goals: await finalGoals.list(), goalStatus: await finalSavings.goalStatus(), status: await finalSavings.status(), history: await finalSavings.history(), balances: await finalFinancial.balances() }).toEqual(reports);
      expect(await finalGoals.create(goalInput)).toMatchObject({ created: false, goal });
      expect(await finalSavings.reserve(input)).toEqual({ ...reserve, created: false });
      expect(await finalFinancial.movementHistory(movement.id)).toEqual(await financial.movementHistory(movement.id));
      expect(() => validateDatabase(finalPath)).not.toThrow();
    } finally {
      for (const connection of connections) if (connection.isInitialized) await connection.destroy();
      await db.cleanup();
    }
  });

  it.each(['goal', 'savings_entry', 'marker', 'B3'])('rechaza B4 parcial: %s', async (missing) => {
    const db = await createTempDatabase();
    try {
      if (missing === 'goal' || missing === 'savings_entry') await db.dataSource.query(`DROP TABLE ${missing}`);
      if (missing === 'marker') await db.dataSource.query('DELETE FROM migrations WHERE name = ?', [new GoalsAndSavings1783209600000().name]);
      if (missing === 'B3') {
        await db.dataSource.query('DROP TABLE budget');
        await db.dataSource.query('DELETE FROM migrations WHERE name = ?', ['Budgets1780617600000']);
      }
      expect(() => validateDatabase(db.path)).toThrow(/B4/);
    } finally { await db.cleanup(); }
  });

  it('fresh: importes TEXT canonicos positivos, UUID/clave unica, FK y down solo aditivo', async () => {
    const db = await createTempDatabase();
    try {
      const account = await new AccountService(db.dataSource, db.transactions).add({ name: 'USDT', currency: 'USDT' });
      const goal = (await new GoalService(db.transactions).create({ sourceKey: 'goal', name: 'Fondo', currency: 'USDT', targetMinor: 9007199254740993123456n })).goal;
      const insertGoal = (minor: string) => db.dataSource.query(`INSERT INTO goal (id, sourceKey, name, currency, targetMinor, targetOn, createdAt) VALUES (?, ?, 'Meta', 'USDT', ?, NULL, '2026-01-01')`, [randomUUID(), randomUUID(), minor]);
      const insertEntry = (minor: string, accountId = account.id, goalId = goal.id, kind = 'reserve', currency = 'USDT') => db.dataSource.query(`INSERT INTO savings_entry (id, sourceKey, kind, accountId, goalId, currency, amountMinor, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-01-01')`, [randomUUID(), randomUUID(), kind, accountId, goalId, currency, minor]);
      for (const bad of ['0', '-1', '-0', '01', '1.2', '1e3', '', ' 1', '+1', '1 ']) {
        await expect(insertGoal(bad)).rejects.toThrow();
        await expect(insertEntry(bad)).rejects.toThrow();
      }
      await insertGoal('1');
      await insertEntry('9007199254740993123456');
      for (const [table, column] of [['goal', 'targetMinor'], ['savings_entry', 'amountMinor']] as const) {
        expect((await db.dataSource.query<{ name: string; type: string }[]>(`PRAGMA table_info(${table})`)).find((row) => row.name === column)!.type.toLowerCase()).toBe('text');
        await expect(db.dataSource.query(`INSERT INTO ${table} SELECT ? , ${table === 'goal' ? 'sourceKey, name, currency, targetMinor, targetOn, createdAt' : 'sourceKey, kind, accountId, goalId, currency, amountMinor, createdAt'} FROM ${table} LIMIT 1`, [randomUUID()])).rejects.toThrow(/UNIQUE/);
      }
      await expect(insertEntry('1', 'missing')).rejects.toThrow(/FOREIGN KEY/);
      await expect(insertEntry('1', account.id, 'missing')).rejects.toThrow(/FOREIGN KEY/);
      await expect(insertEntry('1', account.id, goal.id, 'expense')).rejects.toThrow();
      await expect(insertEntry('1', account.id, goal.id, 'reserve', 'EUR')).rejects.toThrow();
      await expect(db.dataSource.query('DELETE FROM account WHERE id = ?', [account.id])).rejects.toThrow(/FOREIGN KEY/);
      await expect(db.dataSource.query('DELETE FROM goal WHERE id = ?', [goal.id])).rejects.toThrow(/FOREIGN KEY/);
      const tables = (await db.dataSource.query<{ name: string }[]>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('debt', 'debt_payment', 'goal', 'savings_entry', 'migrations', 'sqlite_sequence')`)).map((row) => row.name);
      const before = await snapshot(db.dataSource, tables);
      // Se revierten las migraciones posteriores a B4 (el borrador de deuda, las deudas y
      // las metas) y el resto del esquema tiene que quedar igual.
      await db.dataSource.undoLastMigration();
      await db.dataSource.undoLastMigration();
      await db.dataSource.undoLastMigration();
      expect(await snapshot(db.dataSource, tables)).toEqual(before);
      expect(await db.dataSource.query(`SELECT name FROM sqlite_master WHERE name IN ('goal', 'savings_entry')`)).toEqual([]);
      expect(() => validateDatabase(db.path)).not.toThrow();
    } finally { await db.cleanup(); }
  });
});
