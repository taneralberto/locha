import { AccountService } from '../src/accounts/account.service';
import { BudgetService } from '../src/budgets/budget.service';
import { AiUsageDay } from '../src/capture/ai-usage.entity';
import { CaptureEvent } from '../src/capture/capture-event.entity';
import { Capture } from '../src/capture/capture.entity';
import { CaptureService } from '../src/capture/capture.service';
import { InferenceBudgetService } from '../src/capture/inference-budget.service';
import { FinancialService } from '../src/financial/financial.service';
import { Movement } from '../src/financial/movement.entity';
import { DebtService } from '../src/debts/debt.service';
import { GoalService } from '../src/savings/goal.service';
import { SavingsService } from '../src/savings/savings.service';
import { MAX_REPLY_LENGTH, TelegramCommands } from '../src/telegram/telegram-commands';
import { FakeInterpreter } from './helpers/fake-interpreter';
import { createTempDatabase, TempDatabase } from './helpers/temp-database';

const limits = { maxRequestsPerDay: 100, maxInputTokensPerCall: 2000, maxOutputTokensPerCall: 500, maxCostMicroUsdPerCall: 5000, dailyBudgetMicroUsd: 200000 };

describe('Telegram B4 determinista', () => {
  let db: TempDatabase;
  let commands: TelegramCommands;
  let financial: FinancialService;
  let accounts: AccountService;
  let goals: GoalService;
  let savings: SavingsService;
  let interpreter: FakeInterpreter;
  let accountId: string;
  let goalId: string;
  let event: number;

  beforeEach(async () => {
    db = await createTempDatabase();
    financial = new FinancialService(db.transactions);
    accounts = new AccountService(db.dataSource, db.transactions);
    goals = new GoalService(db.transactions);
    savings = new SavingsService(db.transactions, financial, goals);
    interpreter = new FakeInterpreter([]);
    const budget = new InferenceBudgetService(db.transactions, limits);
    const capture = new CaptureService(db.dataSource, db.transactions, financial, interpreter, budget, new DebtService(db.transactions, financial));
    commands = new TelegramCommands(capture, financial, accounts, budget, limits, new BudgetService(db.transactions, financial), savings, new DebtService(db.transactions, financial));
    accountId = (await accounts.add({ name: 'USDT', currency: 'USDT' })).id;
    goalId = (await goals.create({ sourceKey: 'goal', name: 'Fondo', currency: 'USDT', targetMinor: 9007199254740993123456n })).goal.id;
    await financial.open({ sourceKey: 'open', accountId, money: { currency: 'USDT', minor: 9007199254740993123456n }, occurredOn: '2020-01-01' });
    await savings.reserve({ sourceKey: 'reserve', goalId, accountId, currency: 'USDT', amountMinor: 9007199254740993123456n });
    event = 0;
  });
  afterEach(async () => { jest.useRealTimers(); await db.cleanup(); });

  function answer(text: string, eventId = `telegram:b4:${event++}`) {
    return commands.answer({ text, eventId, chatId: 'chat', receivedAt: '2026-11-10T20:00:00Z' });
  }

  it('/goals [id], /savings, /balances y ayuda sin IA/allowance/cambios del pendiente', async () => {
    interpreter.responses.push({ amount: '0.000001', currency: 'USDT', accountId, kind: 'expense', occurredOn: '2026-11-10', description: null, debt: null });
    await answer('Gaste un micro USDT');
    const pending = await db.dataSource.getRepository(Capture).find();
    const usage = await db.dataSource.getRepository(AiUsageDay).find();
    const events = await db.dataSource.getRepository(CaptureEvent).find();
    expect(await answer('/goals@locha_bot')).toContain('objetivo 9007199254740993.123456 | reservado nominal 9007199254740993.123456 | restante 0.000000 | progreso 100.00%');
    expect(await answer(`/goals ${goalId}`)).toContain(goalId);
    expect(await answer('/savings')).toContain('saldo 9007199254740993.123456 | reservado 9007199254740993.123456 | disponible 0.000000 | deficit 0.000000');
    expect(await answer('/balances')).toContain('reservado 9007199254740993.123456 | disponible 0.000000 | deficit 0.000000');
    const historical = await answer('/balances 2020-01-01');
    expect(historical).toContain('Reservas/disponibles solo actuales');
    expect(historical).not.toContain(' | reservado ');
    for (const raw of ['/goals missing', '/goals id extra', '/savings 2026-11-10']) expect(await answer(raw)).toContain('Usa /');
    for (const raw of ['/savings:reserve', '/goal:add', '/help']) {
      const reply = await answer(raw);
      expect(reply).toContain('/goals');
      expect(reply).toContain('/savings');
      expect(reply).toContain('solo por CLI');
    }
    expect(interpreter.requests).toHaveLength(1);
    expect(await db.dataSource.getRepository(Capture).find()).toEqual(pending);
    expect(await db.dataSource.getRepository(AiUsageDay).find()).toEqual(usage);
    expect(await db.dataSource.getRepository(CaptureEvent).find()).toEqual(events);
  });

  it('captura confirmada registra debajo de reservas y advierte; replay no duplica ni altera reply durable', async () => {
    interpreter.responses.push({ amount: '0.000001', currency: 'USDT', accountId, kind: 'expense', occurredOn: '2026-11-10', description: null, debt: null });
    expect(await answer('Gaste un micro USDT')).not.toContain('ADVERTENCIA');
    const reply = await answer('/confirm', 'telegram:confirm');
    expect(reply).toContain('Registrado');
    expect(reply).toContain('Movimiento:');
    expect(reply).toContain(`ADVERTENCIA: cuenta ${accountId} | USDT | deficit 0.000001 | disponible -0.000001`);
    const stored = await db.dataSource.getRepository(CaptureEvent).findOneByOrFail({ eventId: 'telegram:confirm' });
    expect(stored.reply).not.toContain('ADVERTENCIA');
    expect(await answer('/confirm', 'telegram:confirm')).toBe(reply);
    expect(await db.dataSource.getRepository(Movement).count()).toBe(1);
    expect(await db.dataSource.getRepository(CaptureEvent).findOneByOrFail({ eventId: 'telegram:confirm' })).toEqual(stored);
    expect(await answer('/confirm')).not.toContain('ADVERTENCIA');
    expect(await answer('/cancel')).not.toContain('ADVERTENCIA');
    expect(await answer('/savings')).toContain('disponible -0.000001 | deficit 0.000001 | ADVERTENCIA: reservas preservadas');
    expect(await answer('/balances')).toContain('disponible -0.000001 | deficit 0.000001 | ADVERTENCIA');
    expect(await answer('/goals')).toContain('reserva nominal con cuentas deficitarias');
    expect(interpreter.requests).toHaveLength(1);
    expect(await savings.history()).toHaveLength(1);
    await savings.release({ sourceKey: 'release', goalId, accountId, currency: 'USDT', amountMinor: 1n });
    const replayNow = await answer('/confirm', 'telegram:confirm');
    expect(replayNow).toContain('Registrado');
    expect(replayNow).not.toContain('ADVERTENCIA');
    expect(await db.dataSource.getRepository(Movement).count()).toBe(1);
    expect(await db.dataSource.getRepository(CaptureEvent).findOneByOrFail({ eventId: 'telegram:confirm' })).toEqual(stored);
  });

  it('consulta solo hoy Caracas, excluye futuros y conserva reservas actuales', async () => {
    await financial.register({ sourceKey: 'future', accountId, kind: 'expense', money: { currency: 'USDT', minor: 1n }, occurredOn: '2026-11-11' });
    jest.useFakeTimers({ now: new Date('2026-11-11T02:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    expect(await answer('/savings')).toContain('al 2026-11-10');
    expect(await answer('/savings')).toContain('disponible 0.000000 | deficit 0.000000');
    expect(await answer('/balances')).toContain('reservado 9007199254740993.123456');
    expect(interpreter.requests).toHaveLength(0);
  });

  it('con reply de registro enorme conserva su inicio y la advertencia en vez de omitir todo el registro', async () => {
    await financial.reconcile({ sourceKey: 'deficit', accountId, currency: 'USDT', targetMinor: 0n, occurredOn: '2020-01-01', reason: 'Conteo' });
    const handle = jest.spyOn(CaptureService.prototype, 'handle').mockResolvedValue({
      eventId: 'large', chatId: 'chat', captureState: 'registered', replayed: false,
      reply: `Registrado: ${'x'.repeat(MAX_REPLY_LENGTH)}`, movementId: 'movement',
    });
    try {
      const reply = await answer('/confirm');
      expect(reply).toMatch(/^Registrado:/);
      expect(reply).toContain('ADVERTENCIA: revisa deficits actuales en /savings');
      expect(reply.length).toBe(MAX_REPLY_LENGTH);
    } finally { handle.mockRestore(); }
  });

  it('advierte tambien si la cuenta deficitaria queda fuera de las filas que caben en /balances o /savings', async () => {
    let lastId = '';
    for (let index = 0; index < 40; index += 1) {
      lastId = (await accounts.add({ name: `Cuenta ${index.toString().padStart(2, '0')} ${'x'.repeat(80)}`, currency: 'USD' })).id;
    }
    await financial.open({ sourceKey: 'last-deficit', accountId: lastId, money: { currency: 'USD', minor: -1n }, occurredOn: '2020-01-01' });
    for (const command of ['/balances', '/savings']) {
      const reply = await answer(command);
      expect(reply.length).toBeLessThanOrEqual(MAX_REPLY_LENGTH);
      expect(reply).not.toContain(lastId);
      expect(reply).toContain('ADVERTENCIA: hay cuentas deficitarias');
      expect(reply).toContain('CLI savings:status');
    }
    expect(interpreter.requests).toHaveLength(0);
  });

  it('respuestas acotadas deterministas por filas completas y advertencia de captura acotada aunque haya muchas cuentas', async () => {
    for (let index = 0; index < 50; index += 1) {
      await goals.create({ sourceKey: `goal:${index}`, name: 'n'.repeat(80), currency: 'USD', targetMinor: 1n });
      const account = await accounts.add({ name: `Cuenta ${index} ${'x'.repeat(80)}`, currency: 'USD' });
      await financial.open({ sourceKey: `open:${index}`, accountId: account.id, money: { currency: 'USD', minor: -1n }, occurredOn: '2020-01-01' });
    }
    for (const [command, fallback] of [['/goals', 'CLI goal:status'], ['/savings', 'CLI savings:status']]) {
      const reply = await answer(command!);
      expect(reply).toBe(await answer(command!));
      expect(reply.length).toBeLessThanOrEqual(MAX_REPLY_LENGTH);
      expect(reply).toContain('detalle omitido');
      expect(reply).toContain(fallback);
    }
    interpreter.responses.push({ amount: '0.000001', currency: 'USDT', accountId, kind: 'expense', occurredOn: '2026-11-10', description: null, debt: null });
    await answer('Gaste un micro');
    const confirm = await answer('/confirm');
    expect(confirm.length).toBeLessThanOrEqual(MAX_REPLY_LENGTH);
    expect(confirm).toContain('Registrado');
    expect(confirm).toContain('ADVERTENCIA: revisa deficits actuales en /savings');
    expect(confirm).toContain('detalle omitido');
    expect(await db.dataSource.getRepository(Movement).count()).toBe(1);
  });
});
