import { Account } from '../src/accounts/account.entity';
import { AccountService } from '../src/accounts/account.service';
import { BudgetService } from '../src/budgets/budget.service';
import { Debt, DebtDirection } from '../src/debts/debt.entity';
import { DebtPayment } from '../src/debts/debt-payment.entity';
import { DebtService } from '../src/debts/debt.service';
import { ConflictError, NotFoundError, ValidationError } from '../src/domain/errors';
import { FinancialService } from '../src/financial/financial.service';
import { Movement } from '../src/financial/movement.entity';
import { GoalService } from '../src/savings/goal.service';
import { SavingsService } from '../src/savings/savings.service';
import { createTempDatabase, TempDatabase } from './helpers/temp-database';

const huge = 90071992547409931234567890n;

describe('DebtService: seguimiento y contabilidad de deudas', () => {
  let db: TempDatabase;
  let accounts: AccountService;
  let financial: FinancialService;
  let budgets: BudgetService;
  let savings: SavingsService;
  let debts: DebtService;
  let usd: string;
  let ves: string;
  let usdt: string;
  let goalId: string;

  beforeEach(async () => {
    db = await createTempDatabase();
    accounts = new AccountService(db.dataSource, db.transactions);
    financial = new FinancialService(db.transactions);
    budgets = new BudgetService(db.transactions, financial);
    savings = new SavingsService(db.transactions, financial, new GoalService(db.transactions));
    debts = new DebtService(db.transactions, financial);
    usd = (await accounts.add({ name: 'Efectivo USD', currency: 'USD' })).id;
    ves = (await accounts.add({ name: 'Efectivo VES', currency: 'VES' })).id;
    usdt = (await accounts.add({ name: 'Efectivo USDT', currency: 'USDT' })).id;
    await financial.open({ sourceKey: 'open-usd', accountId: usd, money: { currency: 'USD', minor: 10000n }, occurredOn: '2026-01-01' });
    await financial.open({ sourceKey: 'open-usdt', accountId: usdt, money: { currency: 'USDT', minor: 10000000n }, occurredOn: '2026-01-01' });
    await budgets.create({ sourceKey: 'budget', name: 'Hogar', currency: 'USD', limitMinor: 5000n, startsOn: '2026-01-01', endsOn: '2026-12-31' });
    goalId = (await new GoalService(db.transactions).create({ sourceKey: 'goal', name: 'Fondo', currency: 'USDT', targetMinor: 20000000n })).goal.id;
    await savings.reserve({ sourceKey: 'reserve', goalId, accountId: usdt, currency: 'USDT', amountMinor: 5000000n });
  });

  afterEach(async () => { await db.cleanup(); });

  async function debt(overrides: Partial<Parameters<DebtService['create']>[0]> = {}): Promise<Debt> {
    return (await debts.create({
      sourceKey: 'deuda',
      direction: 'payable',
      counterparty: 'Vecino',
      money: { currency: 'USD', minor: 1000n },
      occurredOn: '2026-11-01',
      ...overrides,
    })).debt;
  }

  it('crear la obligacion no crea movimientos ni cuentas y no cambia saldos, resumen, presupuestos ni reservas', async () => {
    const balances = await financial.balances();
    const summary = await financial.summary();
    const budgetStatus = await budgets.status();
    const savingsStatus = await savings.status();
    const list = await accounts.list();

    const created = await debts.create({
      sourceKey: ' deuda-1 ', direction: 'payable', counterparty: ' José Pérez ',
      money: { currency: 'USD', minor: 10000n }, occurredOn: '2026-11-01', description: ' Prestamo ',
    });

    expect(created.created).toBe(true);
    expect(created.debt).toMatchObject({
      sourceKey: 'deuda-1', direction: 'payable', counterparty: 'José Pérez', currency: 'USD',
      principalMinor: 10000n, occurredOn: '2026-11-01', description: 'Prestamo',
    });
    expect(created.debt.id).toMatch(/^[\da-f-]{36}$/);
    expect(created.debt.createdAt).toBeInstanceOf(Date);
    expect(await financial.balances()).toEqual(balances);
    expect(await financial.summary()).toEqual(summary);
    expect(await budgets.status()).toEqual(budgetStatus);
    expect(await savings.status()).toEqual(savingsStatus);
    expect(await accounts.list()).toEqual(list);
    expect(await db.dataSource.getRepository(Movement).count()).toBe(0);
    expect(await db.dataSource.getRepository(DebtPayment).count()).toBe(0);
  });

  it('pagar lo que se debe registra un gasto ordinario y cobrar lo que nos deben un ingreso, sin clasificar el origen', async () => {
    const payable = await debt({ sourceKey: 'pagar', counterparty: 'Vecino', money: { currency: 'USD', minor: 2500n } });
    const receivable = await debt({ sourceKey: 'cobrar', direction: 'receivable', counterparty: 'Vecino', money: { currency: 'USD', minor: 2500n } });
    const loan = await debt({ sourceKey: 'prestamo', counterparty: 'Banco', money: { currency: 'USD', minor: 1000n }, description: 'Prestamo del banco' });

    const expense = await debts.settle({ sourceKey: 'pago-1', debtId: payable.id, accountId: usd, money: { currency: 'USD', minor: 2500n }, occurredOn: '2026-11-05', expectedOutstandingMinor: 2500n });
    const income = await debts.settle({ sourceKey: 'cobro-1', debtId: receivable.id, accountId: usd, money: { currency: 'USD', minor: 2500n }, occurredOn: '2026-11-05', expectedOutstandingMinor: 2500n });
    await debts.settle({ sourceKey: 'pago-prestamo', debtId: loan.id, accountId: usd, money: { currency: 'USD', minor: 1000n }, occurredOn: '2026-11-05', expectedOutstandingMinor: 1000n });

    expect(expense.created).toBe(true);
    expect(expense.movement).toMatchObject({
      kind: 'expense', accountId: usd, currency: 'USD', amountMinor: 2500n, occurredOn: '2026-11-05',
      sourceKey: `debt-payment:${expense.payment.id}`,
    });
    expect(income.movement.kind).toBe('income');
    expect((await financial.summary()).find((row) => row.currency === 'USD')).toMatchObject({ income: 2500n, expense: 3500n, net: -1000n });
    expect((await financial.balances()).find((row) => row.accountId === usd)?.balance).toBe(9000n);
    expect((await debts.get(loan.id))).toMatchObject({ paidMinor: 1000n, outstandingMinor: 0n, status: 'paid' });
  });

  it('pago parcial y total: el pendiente y el estado se derivan del principal y el pago nunca lo excede', async () => {
    const created = await debt();
    expect((await debts.get(created.id))).toMatchObject({ paidMinor: 0n, outstandingMinor: 1000n, status: 'open' });

    await debts.settle({ sourceKey: 'p1', debtId: created.id, accountId: usd, money: { currency: 'USD', minor: 400n }, occurredOn: '2026-11-02', expectedOutstandingMinor: 1000n });
    expect((await debts.get(created.id))).toMatchObject({ paidMinor: 400n, outstandingMinor: 600n, status: 'partial' });

    await debts.settle({ sourceKey: 'p2', debtId: created.id, accountId: usd, money: { currency: 'USD', minor: 600n }, occurredOn: '2026-11-03', expectedOutstandingMinor: 600n });
    expect((await debts.get(created.id))).toMatchObject({ paidMinor: 1000n, outstandingMinor: 0n, status: 'paid' });

    await expect(debts.settle({ sourceKey: 'p3', debtId: created.id, accountId: usd, money: { currency: 'USD', minor: 1n }, occurredOn: '2026-11-04', expectedOutstandingMinor: 1n })).rejects.toBeInstanceOf(ConflictError);

    const pendiente = await debt({ sourceKey: 'pendiente' });
    await expect(debts.settle({ sourceKey: 'p4', debtId: pendiente.id, accountId: usd, money: { currency: 'USD', minor: 1001n }, occurredOn: '2026-11-04', expectedOutstandingMinor: 1000n })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rechaza expectativa obsoleta, sobrepago, moneda, cuenta inactiva, ausencias y fecha anterior sin escribir', async () => {
    const created = await debt();

    await expect(debts.settle({ sourceKey: 'stale', debtId: created.id, accountId: usd, money: { currency: 'USD', minor: 100n }, occurredOn: '2026-11-02', expectedOutstandingMinor: 999n })).rejects.toBeInstanceOf(ConflictError);
    await expect(debts.settle({ sourceKey: 'over', debtId: created.id, accountId: usd, money: { currency: 'USD', minor: 1001n }, occurredOn: '2026-11-02', expectedOutstandingMinor: 1000n })).rejects.toBeInstanceOf(ValidationError);
    await expect(debts.settle({ sourceKey: 'currency', debtId: created.id, accountId: ves, money: { currency: 'VES', minor: 100n }, occurredOn: '2026-11-02', expectedOutstandingMinor: 1000n })).rejects.toBeInstanceOf(ValidationError);
    await expect(debts.settle({ sourceKey: 'account-currency', debtId: created.id, accountId: ves, money: { currency: 'USD', minor: 100n }, occurredOn: '2026-11-02', expectedOutstandingMinor: 1000n })).rejects.toBeInstanceOf(ValidationError);
    await db.dataSource.getRepository(Account).update(usd, { active: false });
    await expect(debts.settle({ sourceKey: 'inactive', debtId: created.id, accountId: usd, money: { currency: 'USD', minor: 100n }, occurredOn: '2026-11-02', expectedOutstandingMinor: 1000n })).rejects.toBeInstanceOf(ValidationError);
    await db.dataSource.getRepository(Account).update(usd, { active: true });
    await expect(debts.settle({ sourceKey: 'missing-account', debtId: created.id, accountId: 'missing', money: { currency: 'USD', minor: 100n }, occurredOn: '2026-11-02', expectedOutstandingMinor: 1000n })).rejects.toBeInstanceOf(NotFoundError);
    await expect(debts.settle({ sourceKey: 'missing-debt', debtId: 'missing', accountId: usd, money: { currency: 'USD', minor: 100n }, occurredOn: '2026-11-02', expectedOutstandingMinor: 1000n })).rejects.toBeInstanceOf(NotFoundError);
    await expect(debts.settle({ sourceKey: 'date', debtId: created.id, accountId: usd, money: { currency: 'USD', minor: 100n }, occurredOn: '2026-10-31', expectedOutstandingMinor: 1000n })).rejects.toBeInstanceOf(ValidationError);

    expect(await db.dataSource.getRepository(Movement).count()).toBe(0);
    expect(await db.dataSource.getRepository(DebtPayment).count()).toBe(0);
    expect((await debts.get(created.id)).outstandingMinor).toBe(1000n);
  });

  it('serializa pagos rivales y replay concurrentes de la misma clave', async () => {
    const created = await debt();
    const other = new DebtService(db.transactions, financial);
    const results = await Promise.allSettled([
      debts.settle({ sourceKey: 'a', debtId: created.id, accountId: usd, money: { currency: 'USD', minor: 600n }, occurredOn: '2026-11-02', expectedOutstandingMinor: 1000n }),
      other.settle({ sourceKey: 'b', debtId: created.id, accountId: usd, money: { currency: 'USD', minor: 600n }, occurredOn: '2026-11-02', expectedOutstandingMinor: 1000n }),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((row) => row.status === 'rejected')).toHaveLength(1);
    expect((await debts.get(created.id)).paidMinor).toBe(600n);
    expect(await db.dataSource.getRepository(Movement).count()).toBe(1);

    const replays = await Promise.all(Array.from({ length: 8 }, () => other.settle({ sourceKey: 'a', debtId: created.id, accountId: usd, money: { currency: 'USD', minor: 600n }, occurredOn: '2026-11-02', expectedOutstandingMinor: 1000n })));
    expect(replays.every((row) => !row.created)).toBe(true);

    const same = await Promise.all(Array.from({ length: 8 }, () => other.settle({ sourceKey: 'c', debtId: created.id, accountId: usd, money: { currency: 'USD', minor: 400n }, occurredOn: '2026-11-02', expectedOutstandingMinor: 400n })));
    expect(same.filter((row) => row.created)).toHaveLength(1);
    expect(same.filter((row) => !row.created)).toHaveLength(7);
    expect((await debts.get(created.id)).paidMinor).toBe(1000n);
    expect(await db.dataSource.getRepository(Movement).count()).toBe(2);
    expect(await db.dataSource.getRepository(DebtPayment).count()).toBe(2);
  });

  it('si falla el vinculo del pago, el movimiento registrado tambien se revierte', async () => {
    const created = await debt();
    await db.dataSource.query(`CREATE TRIGGER fail_payment BEFORE INSERT ON debt_payment BEGIN SELECT RAISE(ABORT, 'insercion simulada'); END`);
    await expect(debts.settle({ sourceKey: 'pago', debtId: created.id, accountId: usd, money: { currency: 'USD', minor: 100n }, occurredOn: '2026-11-02', expectedOutstandingMinor: 1000n })).rejects.toThrow('insercion simulada');
    await db.dataSource.query('DROP TRIGGER fail_payment');

    expect(await db.dataSource.getRepository(Movement).count()).toBe(0);
    expect(await db.dataSource.getRepository(DebtPayment).count()).toBe(0);
    expect((await financial.balances()).find((row) => row.accountId === usd)?.balance).toBe(10000n);
    expect((await debts.get(created.id)).outstandingMinor).toBe(1000n);
    expect((await debts.settle({ sourceKey: 'pago', debtId: created.id, accountId: usd, money: { currency: 'USD', minor: 100n }, occurredOn: '2026-11-02', expectedOutstandingMinor: 1000n })).created).toBe(true);
  });

  it('replay devuelve el pago y el movimiento originales, tambien anulados, y nunca crea un sustituto', async () => {
    const created = await debt();
    const other = await debt({ sourceKey: 'otra', counterparty: 'Otro' });
    const input = { sourceKey: 'pago', debtId: created.id, accountId: usd, money: { currency: 'USD' as const, minor: 100n }, occurredOn: '2026-11-02', expectedOutstandingMinor: 1000n };
    const first = await debts.settle(input);

    expect((await debts.settle(input)).created).toBe(false);
    await expect(debts.settle({ ...input, money: { currency: 'USD', minor: 200n } })).rejects.toBeInstanceOf(ConflictError);
    await expect(debts.settle({ ...input, expectedOutstandingMinor: 900n })).rejects.toBeInstanceOf(ConflictError);
    await expect(debts.settle({ ...input, debtId: other.id })).rejects.toBeInstanceOf(ConflictError);
    await expect(debts.settle({ ...input, accountId: ves })).rejects.toBeInstanceOf(ConflictError);
    await expect(debts.settle({ ...input, occurredOn: '2026-11-03' })).rejects.toBeInstanceOf(ConflictError);
    await expect(debts.settle({ ...input, description: 'Otro' })).rejects.toBeInstanceOf(ConflictError);

    await financial.voidMovement({ sourceKey: 'anular', movementId: first.movement.id, expectedRevision: 0, reason: 'Pago incorrecto' });
    const replay = await debts.settle(input);
    expect(replay.created).toBe(false);
    expect(replay.payment.id).toBe(first.payment.id);
    expect(replay.movement.id).toBe(first.movement.id);
    expect(await db.dataSource.getRepository(Movement).count()).toBe(1);
    expect(await db.dataSource.getRepository(DebtPayment).count()).toBe(1);

    const registered = await financial.register({ sourceKey: `debt-payment:${first.payment.id}`, accountId: usd, kind: 'expense', money: { currency: 'USD', minor: 100n }, occurredOn: '2026-11-02' });
    expect(registered.created).toBe(false);
    expect(registered.movement.id).toBe(first.movement.id);
    expect(await db.dataSource.getRepository(Movement).count()).toBe(1);
  });

  it('el movimiento de un pago no se edita; anularlo reabre la deuda y devuelve cuentas y reportes', async () => {
    const created = await debt();
    const payment = await debts.settle({ sourceKey: 'pago', debtId: created.id, accountId: usd, money: { currency: 'USD', minor: 100n }, occurredOn: '2026-11-02', expectedOutstandingMinor: 1000n });

    await expect(financial.editMovement({ sourceKey: 'edit', movementId: payment.movement.id, expectedRevision: 0, amountMinor: 500n, occurredOn: '2026-11-02', reason: 'Importe' })).rejects.toBeInstanceOf(ConflictError);

    const ordinary = (await financial.register({ sourceKey: 'ordinary', accountId: usd, kind: 'expense', money: { currency: 'USD', minor: 100n }, occurredOn: '2026-11-02' })).movement;
    const edit = await financial.editMovement({ sourceKey: 'edit-ordinary', movementId: ordinary.id, expectedRevision: 0, amountMinor: 150n, occurredOn: '2026-11-03', reason: 'Importe' });
    expect(edit.created).toBe(true);
    expect((await financial.summary()).find((row) => row.currency === 'USD')).toMatchObject({ income: 0n, expense: 250n });

    await financial.voidMovement({ sourceKey: 'anular', movementId: payment.movement.id, expectedRevision: 0, reason: 'Pago incorrecto' });
    const view = await debts.get(created.id);
    expect(view).toMatchObject({ paidMinor: 0n, outstandingMinor: 1000n, status: 'open' });
    expect(view.payments).toHaveLength(1);
    expect(view.payments[0]).toMatchObject({ voided: true, movement: { id: payment.movement.id } });
    expect((await financial.balances()).find((row) => row.accountId === usd)?.balance).toBe(10000n - 150n);
    expect((await financial.summary()).find((row) => row.currency === 'USD')).toMatchObject({ income: 0n, expense: 150n });
  });

  it('la contraparte se compara canonicamente, sin fusionar ni elegir la primera', async () => {
    const jose = await debt({ sourceKey: 'a', counterparty: 'José Pérez' });
    const jose2 = await debt({ sourceKey: 'b', direction: 'receivable', counterparty: 'JOSE  PÉREZ' });
    const similar = await debt({ sourceKey: 'c', counterparty: 'Jose' });

    const found = await debts.list({ counterparty: 'josé pérez' });
    expect(found.map((row) => row.debt.id).sort()).toEqual([jose.id, jose2.id].sort());
    expect(found.map((row) => row.debt.counterparty)).toEqual(['José Pérez', 'JOSE  PÉREZ']);
    expect((await debts.list({ counterparty: 'jose' })).map((row) => row.debt.id)).toEqual([similar.id]);
    expect((await debts.list({ direction: 'payable' })).map((row) => row.debt.id).sort()).toEqual([jose.id, similar.id].sort());
    expect(await debts.list({ currency: 'USD' })).toHaveLength(3);
    expect(await debts.list({ currency: 'VES' })).toHaveLength(0);
    expect(await debts.list({ status: 'open' })).toHaveLength(3);
    expect(await debts.list({ status: 'paid' })).toHaveLength(0);
    await expect(debts.list({ direction: 'other' as DebtDirection })).rejects.toBeInstanceOf(ValidationError);
    await expect(debts.list({ status: 'other' as 'open' })).rejects.toBeInstanceOf(ValidationError);
    await expect(debts.list({ currency: 'EUR' as 'USD' })).rejects.toBeInstanceOf(ValidationError);
  });

  it.each(['USD', 'VES', 'USDT'] as const)('importes grandes exactos en %s: TEXT canonico y sin perdida', async (currency) => {
    const accountId = currency === 'USD' ? usd : currency === 'VES' ? ves : usdt;
    const created = await debt({ sourceKey: `deuda-${currency}`, counterparty: 'Banco', money: { currency, minor: huge } });
    const payment = await debts.settle({ sourceKey: `pago-${currency}`, debtId: created.id, accountId, money: { currency, minor: huge }, occurredOn: '2026-11-02', expectedOutstandingMinor: huge });

    expect(payment.movement.amountMinor).toBe(huge);
    expect((await debts.get(created.id))).toMatchObject({ paidMinor: huge, outstandingMinor: 0n, status: 'paid' });
    expect(await db.dataSource.query('SELECT principalMinor, typeof(principalMinor) AS type FROM debt WHERE sourceKey = ?', [`deuda-${currency}`]))
      .toEqual([{ principalMinor: huge.toString(), type: 'text' }]);
    expect(await db.dataSource.query('SELECT expectedOutstandingMinor, typeof(expectedOutstandingMinor) AS type FROM debt_payment WHERE sourceKey = ?', [`pago-${currency}`]))
      .toEqual([{ expectedOutstandingMinor: huge.toString(), type: 'text' }]);
  });

  it('replay de la obligacion devuelve la original y un payload distinto da conflicto', async () => {
    const input = { sourceKey: ' deuda-1 ', direction: 'payable' as const, counterparty: ' José Pérez ', money: { currency: 'USD' as const, minor: 100n }, occurredOn: '2026-11-01', description: ' Prestamo ' };
    const first = await debts.create(input);
    const replay = await debts.create(input);

    expect(replay.created).toBe(false);
    expect(replay.debt.id).toBe(first.debt.id);
    expect(replay.debt.counterparty).toBe('José Pérez');
    for (const change of [
      { direction: 'receivable' as const }, { counterparty: 'Otro' }, { money: { currency: 'USD' as const, minor: 200n } },
      { occurredOn: '2026-11-02' }, { description: undefined }, { description: 'Otro' },
    ]) await expect(debts.create({ ...input, ...change })).rejects.toBeInstanceOf(ConflictError);
    expect(await debts.list()).toHaveLength(1);
  });

  it('rechaza entradas invalidas sin escribir', async () => {
    const base = { sourceKey: 'deuda', direction: 'payable' as const, counterparty: 'Vecino', money: { currency: 'USD' as const, minor: 100n }, occurredOn: '2026-11-01' };
    for (const change of [
      { direction: 'other' as unknown as DebtDirection }, { counterparty: ' ' }, { counterparty: 'x'.repeat(121) },
      { sourceKey: '' }, { sourceKey: 'k'.repeat(201) }, { money: { currency: 'EUR' as 'USD', minor: 1n } },
      { money: { currency: 'USD' as const, minor: 0n } }, { money: { currency: 'USD' as const, minor: -1n } },
      { money: { currency: 'USD' as const, minor: 1 as unknown as bigint } }, { occurredOn: '2026-02-30' },
      { occurredOn: '' }, { occurredOn: undefined as unknown as string }, { description: 'x'.repeat(281) },
    ]) await expect(debts.create({ ...base, ...change })).rejects.toBeInstanceOf(ValidationError);
    expect(await debts.list()).toEqual([]);

    const created = await debts.create(base);
    for (const change of [
      { expectedOutstandingMinor: 0n }, { expectedOutstandingMinor: -1n }, { expectedOutstandingMinor: 1 as unknown as bigint },
      { sourceKey: '' }, { debtId: '' }, { accountId: '' }, { money: { currency: 'USD' as const, minor: 0n } },
      { occurredOn: '2026-13-01' },
    ]) await expect(debts.settle({
      sourceKey: 'pago', debtId: created.debt.id, accountId: usd, money: { currency: 'USD', minor: 100n },
      occurredOn: '2026-11-02', expectedOutstandingMinor: 100n, ...change,
    })).rejects.toBeInstanceOf(ValidationError);
    expect(await db.dataSource.getRepository(Movement).count()).toBe(0);
    expect(await db.dataSource.getRepository(DebtPayment).count()).toBe(0);
  });

  it('compone con manager: el rollback del llamador descarta la obligacion y el pago', async () => {
    await expect(db.transactions.run(async (manager) => {
      const created = await debts.create({ sourceKey: 'rollback', direction: 'payable', counterparty: 'Vecino', money: { currency: 'USD', minor: 100n }, occurredOn: '2026-11-01' }, manager);
      await debts.settle({ sourceKey: 'pago', debtId: created.debt.id, accountId: usd, money: { currency: 'USD', minor: 100n }, occurredOn: '2026-11-02', expectedOutstandingMinor: 100n }, manager);
      expect((await debts.get(created.debt.id, manager)).paidMinor).toBe(100n);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await debts.list()).toEqual([]);
    expect(await db.dataSource.getRepository(Movement).count()).toBe(0);
    expect(await db.dataSource.getRepository(DebtPayment).count()).toBe(0);
  });
});
