import { AccountService } from '../src/accounts/account.service';
import { Budget } from '../src/budgets/budget.entity';
import { BudgetService, CreateBudgetInput } from '../src/budgets/budget.service';
import { ConflictError, NotFoundError, ValidationError } from '../src/domain/errors';
import { FinancialService } from '../src/financial/financial.service';
import { createTempDatabase, TempDatabase } from './helpers/temp-database';

const input: CreateBudgetInput = {
  sourceKey: 'budget', name: 'Noviembre', currency: 'USDT', limitMinor: 9007199254740993123456n,
  startsOn: '2026-11-01', endsOn: '2026-11-30',
};

describe('BudgetService (SQLite temporal)', () => {
  let db: TempDatabase;
  let financial: FinancialService;
  let budgets: BudgetService;
  let accountId: string;

  beforeEach(async () => {
    db = await createTempDatabase();
    financial = new FinancialService(db.transactions);
    budgets = new BudgetService(db.transactions, financial);
    accountId = (await new AccountService(db.dataSource, db.transactions).add({ name: 'USDT', currency: 'USDT' })).id;
  });
  afterEach(async () => { await db.cleanup(); });

  async function expense(sourceKey: string, amountMinor: bigint, occurredOn = '2026-11-01') {
    return (await financial.register({ sourceKey, accountId, kind: 'expense', money: { currency: 'USDT', minor: amountMinor }, occurredOn })).movement;
  }

  it('crea definiciones inmutables, normaliza todo y resuelve replay concurrente antes del solapamiento', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => budgets.create({ ...input, sourceKey: ' budget ', name: ' Noviembre ', startsOn: ' 2026-11-01 ' })));
    expect(results.filter((row) => row.created)).toHaveLength(1);
    expect(new Set(results.map((row) => row.budget.id)).size).toBe(1);
    const original = results[0]!.budget;
    expect(original).toMatchObject({ name: 'Noviembre', sourceKey: 'budget', category: null, limitMinor: input.limitMinor });
    expect(original.id).toMatch(/^[\da-f-]{36}$/);
    expect(original.createdAt).toBeInstanceOf(Date);
    for (const change of [
      { name: 'Otro' }, { currency: 'USD' as const }, { limitMinor: 0n }, { category: 'Comida' },
      { startsOn: '2026-11-02' }, { endsOn: '2026-11-29' },
    ]) await expect(budgets.create({ ...input, ...change })).rejects.toBeInstanceOf(ConflictError);
    expect(await budgets.list()).toEqual([original]);
    expect((await budgets.create({ ...input, category: null })).created).toBe(false);
    const conflicts = await Promise.allSettled([
      budgets.create({ ...input, sourceKey: 'concurrent-conflict', category: 'Otro' }),
      budgets.create({ ...input, sourceKey: 'concurrent-conflict', category: 'Otro', name: 'Distinto' }),
    ]);
    expect(conflicts.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(conflicts.find((row) => row.status === 'rejected')).toMatchObject({ reason: expect.any(ConflictError) });
  });

  it('limite cero valido, precision TEXT bigint, sin exigir cuenta/moneda ni fondos', async () => {
    const large = (await budgets.create(input)).budget;
    const zero = (await budgets.create({ ...input, sourceKey: 'zero', currency: 'VES', limitMinor: 0n })).budget;
    await expense('large', input.limitMinor + 1n);
    expect((await budgets.status({ budgetId: large.id, on: '2026-11-01' }))[0]).toMatchObject({ spent: input.limitMinor + 1n, remaining: -1n, overspent: true });
    expect((await budgets.status({ budgetId: zero.id, on: '2026-11-01' }))[0]).toMatchObject({ spent: 0n, remaining: 0n, overspent: false });
    expect(await db.dataSource.query('SELECT limitMinor, typeof(limitMinor) AS type FROM budget ORDER BY sourceKey')).toEqual([
      { limitMinor: input.limitMinor.toString(), type: 'text' }, { limitMinor: '0', type: 'text' },
    ]);
  });

  it('rechaza limites negativos/no bigint, textos y fechas invalidas sin persistir', async () => {
    for (const change of [
      { limitMinor: -1n }, { limitMinor: 1 as unknown as bigint }, { currency: 'EUR' as 'USD' },
      { name: '' }, { name: 'n'.repeat(81) }, { sourceKey: 's'.repeat(201) }, { category: '' }, { category: 'c'.repeat(81) },
      { startsOn: '2026-02-29' }, { endsOn: '2026-11-31' }, { startsOn: '2026-12-01' }, { startsOn: '26-11-01' },
    ]) await expect(budgets.create({ ...input, ...change })).rejects.toBeInstanceOf(ValidationError);
    expect(await budgets.list()).toEqual([]);
    await expect(budgets.status({ on: '2026-02-30' })).rejects.toBeInstanceOf(ValidationError);
    await expect(budgets.status({ budgetId: 'missing' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('solapamiento inclusivo solo en misma moneda y alcance exacto, con concurrencia', async () => {
    await budgets.create(input);
    for (const period of [
      { startsOn: '2026-10-01', endsOn: '2026-11-01' },
      { startsOn: '2026-11-30', endsOn: '2026-12-01' },
      { startsOn: '2026-11-02', endsOn: '2026-11-02' },
      { startsOn: '2026-01-01', endsOn: '2026-12-31' },
    ]) await expect(budgets.create({ ...input, sourceKey: 'overlap', ...period })).rejects.toThrow(/solapado/);
    for (const [key, change] of [
      ['previous', { startsOn: '2026-10-01', endsOn: '2026-10-31' }],
      ['next', { startsOn: '2026-12-01', endsOn: '2026-12-31' }],
      ['usd', { currency: 'USD' as const }], ['category', { category: 'Comida' }], ['case', { category: 'comida' }],
    ] as const) await budgets.create({ ...input, sourceKey: key, ...change });
    await expect(budgets.create({ ...input, sourceKey: 'trim', category: ' Comida ' })).rejects.toThrow(/solapado/);
    const concurrent = await Promise.allSettled(['a', 'b'].map((key) => budgets.create({ ...input, category: 'Nueva', sourceKey: key })));
    expect(concurrent.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter((row) => row.status === 'rejected')).toHaveLength(1);
  });

  it('rango inclusivo acotado por asOf, activos por defecto, historicos/futuros explicitos sin rollover', async () => {
    const current = (await budgets.create(input)).budget;
    const future = (await budgets.create({ ...input, sourceKey: 'future', startsOn: '2026-12-01', endsOn: '2026-12-31' })).budget;
    await expense('before', 1n, '2026-10-31');
    await expense('first', 2n);
    await expense('today', 3n, '2026-11-10');
    await expense('tomorrow', 5n, '2026-11-11');
    await expense('last', 7n, '2026-11-30');
    await expense('after', 11n, '2026-12-01');
    expect((await budgets.status({ on: '2026-11-10' }))).toMatchObject([{ budget: { id: current.id }, spent: 5n }]);
    expect((await budgets.status({ budgetId: current.id, on: '2026-12-10' }))[0]!.spent).toBe(17n);
    expect((await budgets.status({ budgetId: current.id, on: '2026-10-31' }))[0]!.spent).toBe(0n);
    expect((await budgets.status({ budgetId: future.id, on: '2026-11-30' }))[0]!.spent).toBe(0n);
    expect((await budgets.status({ on: '2026-12-01' }))[0]).toMatchObject({ budget: { id: future.id }, spent: 11n });
    expect(await budgets.status({ on: '2027-01-01' })).toEqual([]);
    expect(await budgets.list()).toHaveLength(2);
    jest.useFakeTimers({ now: new Date('2026-11-11T02:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    try { expect((await budgets.status())[0]).toMatchObject({ asOf: '2026-11-10', spent: 5n }); }
    finally { jest.useRealTimers(); }
  });

  it('edicion efectiva de importe/categoria/fecha y anulacion recalculan sin mutar originales/definiciones', async () => {
    const global = (await budgets.create({ ...input, limitMinor: 0n })).budget;
    const category = (await budgets.create({ ...input, sourceKey: 'category', category: 'Comida', limitMinor: 0n })).budget;
    const lower = (await budgets.create({ ...input, sourceKey: 'lower', category: 'comida' })).budget;
    const original = await expense('original', 1n);
    await financial.editMovement({ sourceKey: 'edit', movementId: original.id, expectedRevision: 0, amountMinor: 1234567n, occurredOn: '2026-11-10', category: 'Comida', reason: 'Corregir' });
    const rows = await budgets.status({ on: '2026-11-10' });
    expect(rows.find((row) => row.budget.id === global.id)).toMatchObject({ spent: 1234567n, remaining: -1234567n, overspent: true });
    expect(rows.find((row) => row.budget.id === category.id)!.spent).toBe(1234567n);
    expect(rows.find((row) => row.budget.id === lower.id)!.spent).toBe(0n);
    expect(rows).toHaveLength(3);
    await financial.editMovement({ sourceKey: 'date-category', movementId: original.id, expectedRevision: 1, amountMinor: 2n, occurredOn: '2026-12-01', category: 'comida', reason: 'Mover' });
    expect((await budgets.status({ on: '2026-11-30' })).every((row) => row.spent === 0n)).toBe(true);
    await financial.editMovement({ sourceKey: 'back', movementId: original.id, expectedRevision: 2, amountMinor: 2n, occurredOn: '2026-11-10', category: 'comida', reason: 'Volver' });
    expect((await budgets.status({ budgetId: lower.id, on: '2026-11-10' }))[0]!.spent).toBe(2n);
    await financial.voidMovement({ sourceKey: 'void', movementId: original.id, expectedRevision: 3, reason: 'Duplicado' });
    expect((await budgets.status({ on: '2026-11-30' })).every((row) => row.spent === 0n)).toBe(true);
    expect((await financial.movementHistory(original.id)).original).toEqual(original);
    expect((await budgets.list()).find((row) => row.id === global.id)).toEqual(global);
  });

  it('solo gastos efectivos: incluye comision, excluye principal, apertura, conciliacion e ingresos', async () => {
    await budgets.create(input);
    const to = (await new AccountService(db.dataSource, db.transactions).add({ name: 'Destino', currency: 'USD' })).id;
    await financial.open({ sourceKey: 'open', accountId, money: { currency: 'USDT', minor: 100000000n }, occurredOn: '2026-11-01' });
    await financial.register({ sourceKey: 'income', accountId, kind: 'income', money: { currency: 'USDT', minor: 999n }, occurredOn: '2026-11-01' });
    const operation = (await financial.transfer({ sourceKey: 'transfer', from: { accountId, money: { currency: 'USDT', minor: 1000000n } }, to: { accountId: to, money: { currency: 'USD', minor: 100n } }, fee: { accountId, money: { currency: 'USDT', minor: 1n } }, occurredOn: '2026-11-01' })).operation;
    await financial.reconcile({ sourceKey: 'rec', accountId, currency: 'USDT', targetMinor: -5000000n, occurredOn: '2026-11-01', reason: 'Conteo' });
    await financial.register({ sourceKey: 'usd-expense', accountId: to, kind: 'expense', money: { currency: 'USD', minor: 100n }, occurredOn: '2026-11-01' });
    expect((await budgets.status({ on: '2026-11-01' }))[0]!.spent).toBe(1n);
    await financial.editMovement({ sourceKey: 'fee-edit', movementId: operation.feeMovementId!, expectedRevision: 0, amountMinor: 2n, occurredOn: '2026-11-01', reason: 'Comision' });
    expect((await budgets.status({ on: '2026-11-01' }))[0]!.spent).toBe(2n);
    await financial.voidMovement({ sourceKey: 'fee-void', movementId: operation.feeMovementId!, expectedRevision: 1, reason: 'Duplicado' });
    expect((await budgets.status({ on: '2026-11-01' }))[0]!.spent).toBe(0n);
  });

  it('comparte cola de lecturas y manager opcional, con rollback atomico', async () => {
    await expect(db.transactions.run(async (manager) => {
      const row = await budgets.create(input, manager);
      await financial.register({ sourceKey: 'rolled-back', accountId, kind: 'expense', money: { currency: 'USDT', minor: 5n }, occurredOn: '2026-11-01' }, manager);
      expect(await budgets.list(manager)).toHaveLength(1);
      expect((await budgets.status({ budgetId: row.budget.id, on: '2026-11-01' }, manager))[0]!.spent).toBe(5n);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await budgets.list()).toEqual([]);
    const write = budgets.create(input);
    const read = budgets.status({ on: '2026-11-01' });
    await write;
    expect(await read).toHaveLength(1);
    const other = new BudgetService(db.transactions, financial);
    const movement = expense('queued', 3n);
    const status = other.status({ on: '2026-11-01' });
    await movement;
    expect((await status)[0]!.spent).toBe(3n);
    expect(await db.dataSource.getRepository(Budget).count()).toBe(1);
  });
});
