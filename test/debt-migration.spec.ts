import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { DataSource } from 'typeorm';
import { AccountService } from '../src/accounts/account.service';
import { BudgetService } from '../src/budgets/budget.service';
import { backupDatabase, restoreDatabase, validateDatabase } from '../src/data/backup';
import { buildDataSourceOptions } from '../src/data/data-source';
import { Debts1785888000000 } from '../src/data/migrations/1785888000000-Debts';
import { DebtCapture1788566400000 } from '../src/data/migrations/1788566400000-DebtCapture';
import { TransactionRunner } from '../src/data/transaction.runner';
import { DebtService } from '../src/debts/debt.service';
import { FinancialService } from '../src/financial/financial.service';
import { GoalService } from '../src/savings/goal.service';
import { snapshot } from './helpers/schema-snapshot';
import { createTempDatabase, openDatabase } from './helpers/temp-database';

const migrations = buildDataSourceOptions(':memory:').migrations as Function[];



describe('Migracion y backups B5 (deudas)', () => {
  it.each([['A', 3], ['B1', 4], ['B2', 5], ['B3', 6], ['B4', 7]] as const)('restaura el prefijo %s, migra aditivo y conserva sus filas', async (_prefix, count) => {
    const db = await createTempDatabase(migrations.slice(0, count));
    const connections: DataSource[] = [];
    try {
      const account = await new AccountService(db.dataSource, db.transactions).add({ name: 'Efectivo', currency: 'USD' });
      const old = new FinancialService(db.transactions);
      const movement = (await old.register({ sourceKey: 'income', accountId: account.id, kind: 'income', money: { currency: 'USD', minor: 9007199254740993123456n }, occurredOn: '2020-01-01' })).movement;
      if (count >= 4) await old.open({ sourceKey: 'open', accountId: account.id, money: { currency: 'USD', minor: 1n }, occurredOn: '2020-01-01' });
      if (count >= 6) await new BudgetService(db.transactions, old).create({ sourceKey: 'budget', name: 'Historico', currency: 'USD', limitMinor: 0n, startsOn: '2020-01-01', endsOn: '2099-12-31' });
      if (count >= 7) await new GoalService(db.transactions).create({ sourceKey: 'goal', name: 'Fondo', currency: 'USD', targetMinor: 9007199254740993123456n, targetOn: '2028-02-29' });
      const tables = (await db.dataSource.query<{ name: string }[]>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('migrations', 'sqlite_sequence') ORDER BY name`)).map((row) => row.name);
      const before = await snapshot(db.dataSource, tables);

      const backup = join(dirname(db.path), 'prefix.sqlite');
      const restoredPath = join(dirname(db.path), 'upgraded.sqlite');
      await backupDatabase(db.path, backup);
      await restoreDatabase(backup, restoredPath);
      const upgraded = await openDatabase(restoredPath);
      connections.push(upgraded);
      const after = await snapshot(upgraded, tables);
      expect(after).toEqual(before);
      expect((await upgraded.query<{ name: string }[]>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('debt', 'debt_payment')`)).map((row) => row.name).sort()).toEqual(['debt', 'debt_payment']);

      const transactions = new TransactionRunner(upgraded);
      const financial = new FinancialService(transactions);
      const debts = new DebtService(transactions, financial);
      const debt = (await debts.create({ sourceKey: 'deuda', direction: 'payable', counterparty: 'Vecino', money: { currency: 'USD', minor: 1000n }, occurredOn: '2026-02-01' })).debt;
      const payment = await debts.settle({ sourceKey: 'pago', debtId: debt.id, accountId: account.id, money: { currency: 'USD', minor: 400n }, occurredOn: '2026-03-01', expectedOutstandingMinor: 1000n });
      const reports = { list: await debts.list(), get: await debts.get(debt.id) };

      const b5Backup = join(dirname(db.path), 'b5.sqlite');
      const finalPath = join(dirname(db.path), 'final.sqlite');
      await backupDatabase(restoredPath, b5Backup);
      await restoreDatabase(b5Backup, finalPath);
      const final = await openDatabase(finalPath);
      connections.push(final);
      const finalTransactions = new TransactionRunner(final);
      const finalFinancial = new FinancialService(finalTransactions);
      const finalDebts = new DebtService(finalTransactions, finalFinancial);
      expect(await finalDebts.list()).toEqual(reports.list);
      expect(await finalDebts.get(debt.id)).toEqual(reports.get);
      expect(await finalDebts.settle({ sourceKey: 'pago', debtId: debt.id, accountId: account.id, money: { currency: 'USD', minor: 400n }, occurredOn: '2026-03-01', expectedOutstandingMinor: 1000n })).toMatchObject({ created: false, payment: { id: payment.payment.id } });
      expect(await finalFinancial.movementHistory(movement.id)).toEqual(await financial.movementHistory(movement.id));
      expect(() => validateDatabase(finalPath)).not.toThrow();
    } finally {
      for (const connection of connections) if (connection.isInitialized) await connection.destroy();
      await db.cleanup();
    }
  });

  it.each(['debt', 'debt_payment', 'marker'])('rechaza B5 parcial: %s', async (missing) => {    const db = await createTempDatabase();
    try {
      if (missing === 'debt' || missing === 'debt_payment') await db.dataSource.query(`DROP TABLE ${missing}`);
      if (missing === 'marker') await db.dataSource.query('DELETE FROM migrations WHERE name = ?', [new Debts1785888000000().name]);
      expect(() => validateDatabase(db.path)).toThrow(/B5/);
    } finally { await db.cleanup(); }
  });

  it('una base todavia sin la migracion B5 sigue permitiendo editar y anular movimientos', async () => {
    const db = await createTempDatabase(migrations.slice(0, 7));
    try {
      const account = await new AccountService(db.dataSource, db.transactions).add({ name: 'Efectivo', currency: 'USD' });
      const financial = new FinancialService(db.transactions);
      const movement = (await financial.register({ sourceKey: 'original', accountId: account.id, kind: 'expense', money: { currency: 'USD', minor: 100n }, occurredOn: '2026-02-01' })).movement;
      const edit = await financial.editMovement({ sourceKey: 'edit', movementId: movement.id, expectedRevision: 0, amountMinor: 150n, occurredOn: '2026-02-02', reason: 'Importe' });
      expect(edit.created).toBe(true);
      await financial.voidMovement({ sourceKey: 'void', movementId: movement.id, expectedRevision: 1, reason: 'Duplicado' });
      expect((await financial.movementHistory(movement.id)).effective.voided).toBe(true);
    } finally { await db.cleanup(); }
  });

  it('fresh: importes TEXT canonicos positivos, clave unica, movimiento unico, FK restrict y down solo aditivo', async () => {    const db = await createTempDatabase();
    try {
      const account = await new AccountService(db.dataSource, db.transactions).add({ name: 'Efectivo', currency: 'USD' });
      const financial = new FinancialService(db.transactions);
      const debts = new DebtService(db.transactions, financial);
      const debt = (await debts.create({ sourceKey: 'deuda', direction: 'payable', counterparty: 'Vecino', money: { currency: 'USD', minor: 100n }, occurredOn: '2026-02-01' })).debt;
      const payment = await debts.settle({ sourceKey: 'pago', debtId: debt.id, accountId: account.id, money: { currency: 'USD', minor: 100n }, occurredOn: '2026-03-01', expectedOutstandingMinor: 100n });
      const other = (await financial.register({ sourceKey: 'other', accountId: account.id, kind: 'expense', money: { currency: 'USD', minor: 5n }, occurredOn: '2026-03-02' })).movement;
      const spare = (await financial.register({ sourceKey: 'spare', accountId: account.id, kind: 'expense', money: { currency: 'USD', minor: 6n }, occurredOn: '2026-03-03' })).movement;

      const insertDebt = (minor: string) => db.dataSource.query(`INSERT INTO debt (id, sourceKey, direction, counterparty, currency, principalMinor, occurredOn, description, createdAt) VALUES (?, ?, 'payable', 'Vecino', 'USD', ?, '2026-02-01', NULL, '2026-01-01')`, [randomUUID(), randomUUID(), minor]);
      const insertPayment = (minor: string, debtId = debt.id, movementId = payment.movement.id, sourceKey: string = randomUUID()) => db.dataSource.query(`INSERT INTO debt_payment (id, sourceKey, debtId, movementId, expectedOutstandingMinor, createdAt) VALUES (?, ?, ?, ?, ?, '2026-01-01')`, [randomUUID(), sourceKey, debtId, movementId, minor]);

      for (const bad of ['0', '-1', '-0', '01', '1.2', '1e3', '', ' 1', '+1', '1 ']) {
        await expect(insertDebt(bad)).rejects.toThrow();
        await expect(insertPayment(bad)).rejects.toThrow();
      }
      await insertDebt('1');
      await expect(insertPayment('1')).rejects.toThrow(/UNIQUE/);
      await insertPayment('1', debt.id, other.id, 'k1');
      await expect(insertPayment('1', debt.id, other.id, 'k1')).rejects.toThrow(/UNIQUE/);
      await expect(insertPayment('1', debt.id, other.id, 'k2')).rejects.toThrow(/UNIQUE/);
      await expect(insertPayment('1', 'missing', spare.id, 'k3')).rejects.toThrow(/FOREIGN KEY/);
      await expect(insertPayment('1', debt.id, 'missing', 'k4')).rejects.toThrow(/FOREIGN KEY/);
      await expect(db.dataSource.query(`INSERT INTO debt (id, sourceKey, direction, counterparty, currency, principalMinor, occurredOn, description, createdAt) VALUES (?, ?, 'other', 'Vecino', 'USD', '1', '2026-02-01', NULL, '2026-01-01')`, [randomUUID(), randomUUID()])).rejects.toThrow();
      await expect(db.dataSource.query(`INSERT INTO debt (id, sourceKey, direction, counterparty, currency, principalMinor, occurredOn, description, createdAt) VALUES (?, ?, 'payable', 'Vecino', 'EUR', '1', '2026-02-01', NULL, '2026-01-01')`, [randomUUID(), randomUUID()])).rejects.toThrow();
      await expect(db.dataSource.query('DELETE FROM movement WHERE id = ?', [payment.movement.id])).rejects.toThrow(/FOREIGN KEY/);
      await expect(db.dataSource.query('DELETE FROM debt WHERE id = ?', [debt.id])).rejects.toThrow(/FOREIGN KEY/);
      await expect(db.dataSource.query('DELETE FROM account WHERE id = ?', [account.id])).rejects.toThrow(/FOREIGN KEY/);

      const tables = (await db.dataSource.query<{ name: string }[]>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('debt', 'debt_payment', 'migrations', 'sqlite_sequence')`)).map((row) => row.name);
      const before = await snapshot(db.dataSource, tables);
      // Primero se revierte la columna del borrador y despues la migracion de deudas.
      await db.dataSource.undoLastMigration();
      await db.dataSource.undoLastMigration();
      const after = await snapshot(db.dataSource, tables);
      expect(after).toEqual(before);
      expect(after.rows).toEqual(before.rows);
      expect(await db.dataSource.query(`SELECT name FROM sqlite_master WHERE name IN ('debt', 'debt_payment')`)).toEqual([]);
      expect(() => validateDatabase(db.path)).not.toThrow();
    } finally { await db.cleanup(); }
  });
});

/**
 * Unidad 2: el borrador de captura gana una columna de texto con los datos de la deuda.
 * La migracion es aditiva: no reescribe filas historicas.
 */
describe('Migracion y backups B6 (borrador de deuda)', () => {
  it.each([['A', 3], ['B1', 4], ['B2', 5], ['B3', 6], ['B4', 7], ['B5', 8]] as const)(
    'restaura el prefijo %s, migra aditivo y conserva sus filas',
    async (_prefix, count) => {
      const db = await createTempDatabase(migrations.slice(0, count));
      const connections: DataSource[] = [];
      try {
        const account = await new AccountService(db.dataSource, db.transactions).add({ name: 'Efectivo', currency: 'USD' });
        await new FinancialService(db.transactions).register({
          sourceKey: 'gasto',
          accountId: account.id,
          kind: 'expense',
          money: { currency: 'USD', minor: 100n },
          occurredOn: '2026-01-01',
        });
        const tables = (
          await db.dataSource.query<{ name: string }[]>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('migrations', 'sqlite_sequence') ORDER BY name`)
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

        const columns = await upgraded.query<{ name: string }[]>(`PRAGMA table_info("capture")`);
        expect(columns.map((column) => column.name)).toContain('debtPayload');
        expect(() => validateDatabase(restoredPath)).not.toThrow();
      } finally {
        for (const connection of connections) if (connection.isInitialized) await connection.destroy();
        await db.cleanup();
      }
    },
  );

  it('no reescribe los borradores anteriores: la columna nueva queda en null', async () => {
    const db = await createTempDatabase(migrations.slice(0, 8));
    try {
      // La tabla todavia no tiene la columna: el borrador se inserta como era antes.
      await db.dataSource.query(
        `INSERT INTO capture (id, chatId, sourceKey, state, kind, amount, currency, accountId, occurredOn, description, sourceText, createdAt, updatedAt)
         VALUES ('id-1', 'chat-1', 'capture:1', 'awaiting_confirmation', 'expense', '10.00', 'USD', 'cuenta-1', '2026-11-10', 'Helado', 'hola', '2026-11-10 00:00:00', '2026-11-10 00:00:00')`,
      );

      await db.close();
      const upgraded = await openDatabase(db.path);
      try {
        const rows = await upgraded.query<{ amount: string; sourceText: string; debtPayload: string | null }[]>(
          `SELECT amount, sourceText, debtPayload FROM capture`,
        );
        expect(rows).toEqual([{ amount: '10.00', sourceText: 'hola', debtPayload: null }]);
      } finally {
        await upgraded.destroy();
      }
    } finally {
      await db.cleanup();
    }
  });

  it.each(['columna', 'marcador'])('rechaza B6 parcial: %s', async (missing) => {
    const db = await createTempDatabase();
    try {
      if (missing === 'marcador') {
        await db.dataSource.query('DELETE FROM migrations WHERE name = ?', [new DebtCapture1788566400000().name]);
      } else {
        await db.dataSource.query('ALTER TABLE "capture" DROP COLUMN "debtPayload"');
      }
      expect(() => validateDatabase(db.path)).toThrow(/B6/);
    } finally {
      await db.cleanup();
    }
  });

  it('el down quita la columna y no toca las demas tablas', async () => {
    const db = await createTempDatabase();
    try {
      const tables = (
        await db.dataSource.query<{ name: string }[]>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('migrations', 'sqlite_sequence')`)
      ).map((row) => row.name);
      const before = await snapshot(db.dataSource, tables);

      await db.dataSource.undoLastMigration();

      const columns = await db.dataSource.query<{ name: string }[]>(`PRAGMA table_info("capture")`);
      expect(columns.map((column) => column.name)).not.toContain('debtPayload');
      const after = await snapshot(db.dataSource, tables);
      expect(after).toEqual(before);
    } finally {
      await db.cleanup();
    }
  });
});
