import { Account } from '../src/accounts/account.entity';
import { AccountService } from '../src/accounts/account.service';
import { BudgetService } from '../src/budgets/budget.service';
import { ConflictError, NotFoundError, ValidationError } from '../src/domain/errors';
import { FinancialService } from '../src/financial/financial.service';
import { Movement } from '../src/financial/movement.entity';
import { GoalService } from '../src/savings/goal.service';
import { SavingsInput, SavingsService } from '../src/savings/savings.service';
import { createTempDatabase, TempDatabase } from './helpers/temp-database';

const huge = 9007199254740993123456n;
const goalInput = { sourceKey: 'goal', name: 'Meta', currency: 'USDT' as const, targetMinor: huge };

describe('GoalService y SavingsService (SQLite temporal)', () => {
  let db: TempDatabase;
  let financial: FinancialService;
  let goals: GoalService;
  let savings: SavingsService;
  let accountId: string;
  let goalId: string;
  let input: SavingsInput;

  beforeEach(async () => {
    db = await createTempDatabase();
    financial = new FinancialService(db.transactions);
    goals = new GoalService(db.transactions);
    savings = new SavingsService(db.transactions, financial, goals);
    accountId = (await new AccountService(db.dataSource, db.transactions).add({ name: 'USDT', currency: 'USDT' })).id;
    goalId = (await goals.create(goalInput)).goal.id;
    input = { sourceKey: 'reserve', goalId, accountId, currency: 'USDT', amountMinor: huge };
  });
  afterEach(async () => { jest.useRealTimers(); await db.cleanup(); });

  async function open(amount = huge) {
    await financial.open({ sourceKey: 'open', accountId, money: { currency: 'USDT', minor: amount }, occurredOn: '2020-01-01' });
  }

  it('meta UUID inmutable, normalizacion/replay concurrente y payload completo incluyendo fecha opcional', async () => {
    const dated = { ...goalInput, sourceKey: ' dated ', name: ' Meta fechada ', targetOn: ' 2024-02-29 ' };
    const results = await Promise.all(Array.from({ length: 8 }, () => goals.create(dated)));
    expect(results.filter((row) => row.created)).toHaveLength(1);
    const goal = results[0]!.goal;
    expect(goal.id).toMatch(/^[\da-f-]{36}$/);
    expect(goal.createdAt).toBeInstanceOf(Date);
    expect(goal).toMatchObject({ sourceKey: 'dated', name: 'Meta fechada', targetOn: '2024-02-29', targetMinor: huge });
    expect((await goals.create({ ...goalInput, targetOn: null })).created).toBe(false);
    for (const change of [{ name: 'Otra' }, { currency: 'USD' as const }, { targetMinor: 1n }, { targetOn: '2024-02-29' }]) {
      await expect(goals.create({ ...goalInput, ...change })).rejects.toBeInstanceOf(ConflictError);
    }
    const before = await goals.list();
    for (const change of [
      { targetMinor: 0n }, { targetMinor: -1n }, { targetMinor: 1 as unknown as bigint }, { currency: 'EUR' as 'USD' },
      { name: '' }, { name: 'n'.repeat(81) }, { sourceKey: '' }, { sourceKey: 's'.repeat(201) },
      { targetOn: '' }, { targetOn: '2026-02-29' }, { targetOn: '2026-11-31' },
    ]) await expect(goals.create({ ...goalInput, sourceKey: 'invalid', ...change })).rejects.toBeInstanceOf(ValidationError);
    expect(await goals.list()).toEqual(before);
    await expect(goals.get('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('bigint TEXT exacto, reserva combinada entre metas no excede saldo y liberar no crea movimientos', async () => {
    await open(huge + 1n);
    const budgets = new BudgetService(db.transactions, financial);
    await budgets.create({ sourceKey: 'budget', name: 'Presupuesto', currency: 'USDT', limitMinor: 0n, startsOn: '2020-01-01', endsOn: '2099-12-31' });
    const balances = await financial.balances();
    const summary = await financial.summary();
    const budgetStatus = await budgets.status();
    await savings.reserve(input);
    const other = (await goals.create({ ...goalInput, sourceKey: 'other', targetMinor: 1n })).goal;
    await expect(savings.reserve({ ...input, sourceKey: 'too-much', goalId: other.id, amountMinor: 2n })).rejects.toThrow(/insuficientes/);
    await savings.reserve({ ...input, sourceKey: 'last', goalId: other.id, amountMinor: 1n });
    expect((await savings.status())[0]).toMatchObject({ balance: huge + 1n, reserved: huge + 1n, available: 0n, deficit: 0n });
    expect((await savings.goalStatus(goalId))[0]).toMatchObject({ reserved: huge, remaining: 0n, progress: '100.00%', nominalWithDeficit: false });
    await expect(savings.release({ ...input, sourceKey: 'too-large', amountMinor: huge + 1n })).rejects.toThrow(/supera/);
    await savings.release({ ...input, sourceKey: 'release', amountMinor: huge - 1n });
    expect((await savings.status(accountId))[0]).toMatchObject({ reserved: 2n, available: huge - 1n });
    expect(await db.dataSource.query('SELECT amountMinor, typeof(amountMinor) AS type FROM savings_entry ORDER BY sourceKey')).toEqual([
      { amountMinor: '1', type: 'text' }, { amountMinor: (huge - 1n).toString(), type: 'text' }, { amountMinor: huge.toString(), type: 'text' },
    ]);
    expect(await financial.balances()).toEqual(balances);
    expect(await financial.summary()).toEqual(summary);
    expect(await budgets.status()).toEqual(budgetStatus);
    expect(await db.dataSource.getRepository(Movement).count()).toBe(0);
  });

  it('permite sobreobjetivo nominal y progreso exacto truncado a dos decimales sin Number', async () => {
    await open(huge);
    const goal = (await goals.create({ ...goalInput, sourceKey: 'small', targetMinor: 3n })).goal;
    await savings.reserve({ ...input, goalId: goal.id, amountMinor: 4n });
    expect((await savings.goalStatus(goal.id))[0]).toMatchObject({ reserved: 4n, remaining: 0n, progress: '133.33%' });
  });

  it('replay completo antes de fondos/actividad/estado tras liberar y deficit, conflicto por cada campo', async () => {
    await open();
    const original = await savings.reserve({ ...input, sourceKey: ' reserve ', accountId: ` ${accountId} `, goalId: ` ${goalId} ` });
    const released = await savings.release({ ...input, sourceKey: 'release' });
    await financial.reconcile({ sourceKey: 'rec', accountId, currency: 'USDT', targetMinor: -1n, occurredOn: '2020-01-01', reason: 'Conteo' });
    await db.dataSource.getRepository(Account).update(accountId, { active: false });
    expect(await savings.reserve(input)).toEqual({ ...original, created: false });
    expect(await savings.release({ ...input, sourceKey: 'release' })).toEqual({ ...released, created: false });
    for (const change of [
      { goalId: 'missing' }, { accountId: 'missing' }, { currency: 'USD' as const }, { amountMinor: 1n },
    ]) await expect(savings.reserve({ ...input, ...change })).rejects.toBeInstanceOf(ConflictError);
    await expect(savings.release(input)).rejects.toBeInstanceOf(ConflictError);
    await expect(savings.reserve({ ...input, sourceKey: 'new', amountMinor: 1n })).rejects.toThrow(/inactiva/);
    expect(await savings.history()).toHaveLength(2);
  });

  it('rechaza cero/negativo/no bigint, moneda divergente, entidades ausentes y filtros invalidos sin escribir', async () => {
    await open();
    const usd = (await new AccountService(db.dataSource, db.transactions).add({ name: 'USD', currency: 'USD' })).id;
    const usdGoal = (await goals.create({ ...goalInput, sourceKey: 'usd', currency: 'USD' })).goal.id;
    for (const change of [
      { amountMinor: 0n }, { amountMinor: -1n }, { amountMinor: 1 as unknown as bigint }, { currency: 'EUR' as 'USD' },
      { currency: 'USD' as const }, { accountId: usd }, { goalId: usdGoal },
      { sourceKey: '' }, { sourceKey: 'k'.repeat(201) }, { goalId: '' }, { accountId: '' },
    ]) for (const kind of ['reserve', 'release'] as const) await expect(savings[kind]({ ...input, ...change })).rejects.toBeInstanceOf(ValidationError);
    await expect(savings.reserve({ ...input, goalId: 'missing' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(savings.reserve({ ...input, accountId: 'missing' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(savings.status('missing')).rejects.toBeInstanceOf(NotFoundError);
    await expect(savings.goalStatus('missing')).rejects.toBeInstanceOf(NotFoundError);
    await expect(savings.history({ accountId: 'missing' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(savings.history({ goalId: 'missing' })).rejects.toBeInstanceOf(NotFoundError);
    expect(await savings.history()).toEqual([]);
  });

  it('serializa reservas rivales sobre los mismos fondos y replay concurrente entre instancias', async () => {
    await open(10n);
    const other = new SavingsService(db.transactions, financial, goals);
    const result = await Promise.allSettled([
      savings.reserve({ ...input, sourceKey: 'a', amountMinor: 6n }),
      other.reserve({ ...input, sourceKey: 'b', amountMinor: 6n }),
    ]);
    expect(result.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter((row) => row.status === 'rejected')).toHaveLength(1);
    const replays = await Promise.all(Array.from({ length: 8 }, () => other.reserve({ ...input, sourceKey: 'a', amountMinor: 6n })));
    expect(replays.every((row) => !row.created)).toBe(true);
    expect(await savings.history()).toHaveLength(1);
    expect((await savings.status())[0]!.available).toBe(4n);
  });

  it('rollback de reserva/liberacion/meta con manager y fallo de insercion sin medias escrituras', async () => {
    await open(10n);
    await expect(db.transactions.run(async (manager) => {
      const goal = (await goals.create({ ...goalInput, sourceKey: 'rollback' }, manager)).goal;
      await savings.reserve({ ...input, goalId: goal.id, amountMinor: 8n }, manager);
      await savings.release({ ...input, sourceKey: 'release', goalId: goal.id, amountMinor: 2n }, manager);
      expect((await savings.status(accountId, manager))[0]!.reserved).toBe(6n);
      expect(await savings.goalStatus(goal.id, manager)).toHaveLength(1);
      expect(await savings.history({}, manager)).toHaveLength(2);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await goals.list()).toHaveLength(1);
    expect(await savings.history()).toEqual([]);
    await db.dataSource.query(`CREATE TRIGGER fail_savings BEFORE INSERT ON savings_entry BEGIN SELECT RAISE(ABORT, 'insercion simulada'); END`);
    await expect(savings.reserve({ ...input, amountMinor: 1n })).rejects.toThrow('insercion simulada');
    await db.dataSource.query('DROP TRIGGER fail_savings');
    expect(await savings.history()).toEqual([]);
    expect((await savings.status())[0]!.available).toBe(10n);
    expect((await savings.reserve({ ...input, amountMinor: 1n })).created).toBe(true);
  });

  it('solo hoy Caracas: no reserva fondos de ingresos futuros ni tiene corte/scheduling', async () => {
    await financial.open({ sourceKey: 'today', accountId, money: { currency: 'USDT', minor: 1n }, occurredOn: '2026-11-10' });
    await financial.register({ sourceKey: 'tomorrow', accountId, kind: 'income', money: { currency: 'USDT', minor: huge }, occurredOn: '2026-11-11' });
    jest.useFakeTimers({ now: new Date('2026-11-11T02:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    expect((await savings.status())[0]).toMatchObject({ balance: 1n, available: 1n, asOf: '2026-11-10' });
    await expect(savings.reserve({ ...input, amountMinor: 2n })).rejects.toThrow(/insuficientes/);
    await savings.reserve({ ...input, amountMinor: 1n });
  });

  it.each(['expense', 'transfer-fee', 'edit', 'void-income', 'reconcile'] as const)('%s reduce respaldo: registra y advierte, preserva reservas y permite liberar en cuenta inactiva', async (kind) => {
    await open(10n);
    await savings.reserve({ ...input, amountMinor: 8n });
    const before = await savings.history();
    if (kind === 'expense' || kind === 'edit') {
      const movement = (await financial.register({ sourceKey: 'expense', accountId, kind: 'expense', money: { currency: 'USDT', minor: kind === 'edit' ? 1n : 5n }, occurredOn: '2020-01-01' })).movement;
      if (kind === 'edit') await financial.editMovement({ sourceKey: 'edit', movementId: movement.id, expectedRevision: 0, amountMinor: 5n, occurredOn: '2020-01-01', reason: 'Importe' });
    } else if (kind === 'transfer-fee') {
      const to = (await new AccountService(db.dataSource, db.transactions).add({ name: 'Destino', currency: 'USD' })).id;
      await financial.transfer({ sourceKey: 'transfer', from: { accountId, money: { currency: 'USDT', minor: 3n } }, to: { accountId: to, money: { currency: 'USD', minor: 1n } }, fee: { accountId, money: { currency: 'USDT', minor: 2n } }, occurredOn: '2020-01-01' });
    } else if (kind === 'void-income') {
      const movement = (await financial.register({ sourceKey: 'income', accountId, kind: 'income', money: { currency: 'USDT', minor: 5n }, occurredOn: '2020-01-01' })).movement;
      // Retroactive expense consumes that income; void removes its backing later.
      await financial.register({ sourceKey: 'expense', accountId, kind: 'expense', money: { currency: 'USDT', minor: 5n }, occurredOn: '2020-01-01' });
      await financial.voidMovement({ sourceKey: 'void', movementId: movement.id, expectedRevision: 0, reason: 'Duplicado' });
    } else await financial.reconcile({ sourceKey: 'rec', accountId, currency: 'USDT', targetMinor: 5n, occurredOn: '2020-01-01', reason: 'Conteo' });
    expect((await savings.status(accountId))[0]).toMatchObject({ balance: 5n, reserved: 8n, available: -3n, deficit: 3n });
    expect(await savings.warnings()).toEqual([expect.stringContaining(`cuenta ${accountId} | USDT | deficit 0.000003 | disponible -0.000003`)]);
    expect((await savings.goalStatus(goalId))[0]).toMatchObject({ reserved: 8n, nominalWithDeficit: true });
    expect(await savings.history()).toEqual(before);
    await expect(savings.reserve({ ...input, sourceKey: 'new', amountMinor: 1n })).rejects.toThrow(/insuficientes/);
    expect((await savings.reserve({ ...input, amountMinor: 8n })).created).toBe(false);
    await db.dataSource.getRepository(Account).update(accountId, { active: false });
    await savings.release({ ...input, sourceKey: 'release', amountMinor: 3n });
    expect((await savings.status(accountId))[0]).toMatchObject({ reserved: 5n, available: 0n, deficit: 0n });
    expect(await savings.warnings()).toEqual([]);
  });

  it('agrega cuentas nativas de una meta sin mezclar monedas ni inventar distribucion de deficit entre metas', async () => {
    await open(10n);
    const accounts = new AccountService(db.dataSource, db.transactions);
    const second = (await accounts.add({ name: 'Otra USDT', currency: 'USDT' })).id;
    const usd = (await accounts.add({ name: 'USD', currency: 'USD' })).id;
    await financial.open({ sourceKey: 'second', accountId: second, money: { currency: 'USDT', minor: 5n }, occurredOn: '2020-01-01' });
    await financial.open({ sourceKey: 'usd', accountId: usd, money: { currency: 'USD', minor: 10000n }, occurredOn: '2020-01-01' });
    const otherGoal = (await goals.create({ ...goalInput, sourceKey: 'other' })).goal.id;
    await savings.reserve({ ...input, amountMinor: 4n });
    await savings.reserve({ ...input, sourceKey: 'other', goalId: otherGoal, amountMinor: 4n });
    await savings.reserve({ ...input, sourceKey: 'second', accountId: second, amountMinor: 5n });
    await financial.reconcile({ sourceKey: 'deficit', accountId, currency: 'USDT', targetMinor: -2n, occurredOn: '2020-01-01', reason: 'Conteo' });
    expect((await savings.status(accountId))[0]).toMatchObject({ balance: -2n, reserved: 8n, available: -10n, deficit: 10n });
    expect((await savings.status(usd))[0]).toMatchObject({ reserved: 0n, available: 10000n });
    expect((await savings.goalStatus(goalId))[0]).toMatchObject({ reserved: 9n, remaining: huge - 9n, nominalWithDeficit: true });
    expect((await savings.goalStatus(otherGoal))[0]).toMatchObject({ reserved: 4n, remaining: huge - 4n, nominalWithDeficit: true });
    expect(await savings.history({ accountId, goalId })).toHaveLength(1);
    await savings.release({ ...input, sourceKey: 'release', amountMinor: 4n });
    expect((await savings.goalStatus(goalId))[0]).toMatchObject({ reserved: 5n, nominalWithDeficit: false });
    expect((await savings.goalStatus(otherGoal))[0]!.nominalWithDeficit).toBe(true);
  });
});
