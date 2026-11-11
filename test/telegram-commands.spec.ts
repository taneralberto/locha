import { AccountService } from '../src/accounts/account.service';
import { BudgetService } from '../src/budgets/budget.service';
import { DebtService } from '../src/debts/debt.service';
import { GoalService } from '../src/savings/goal.service';
import { SavingsService } from '../src/savings/savings.service';
import { AiUsageDay } from '../src/capture/ai-usage.entity';
import { CaptureService } from '../src/capture/capture.service';
import { DEFAULT_TIME_ZONE, InferenceBudgetService } from '../src/capture/inference-budget.service';
import { TransactionRunner } from '../src/data/transaction.runner';
import { dateInTimeZone } from '../src/domain/date';
import { FinancialService } from '../src/financial/financial.service';
import { Capture } from '../src/capture/capture.entity';
import { MAX_REPLY_LENGTH, TelegramCommands } from '../src/telegram/telegram-commands';
import { FakeInterpreter } from './helpers/fake-interpreter';
import { createTempDatabase, TempDatabase } from './helpers/temp-database';

const LIMITS = {
  maxRequestsPerDay: 100,
  maxInputTokensPerCall: 2000,
  maxOutputTokensPerCall: 500,
  maxCostMicroUsdPerCall: 5000,
  dailyBudgetMicroUsd: 200000,
};

describe('TelegramCommands', () => {
  let database: TempDatabase;
  let commands: TelegramCommands;
  let interpreter: FakeInterpreter;
  let financial: FinancialService;
  let accounts: AccountService;
  let budgets: BudgetService;

  beforeEach(async () => {
    database = await createTempDatabase();
    const transactions = new TransactionRunner(database.dataSource);
    financial = new FinancialService(transactions);
    accounts = new AccountService(database.dataSource, transactions);
    budgets = new BudgetService(transactions, financial);
    interpreter = new FakeInterpreter([]);
    const capture = new CaptureService(
      database.dataSource,
      transactions,
      financial,
      interpreter,
      new InferenceBudgetService(transactions, LIMITS),
      new DebtService(transactions, financial),
    );
    commands = new TelegramCommands(
      capture,
      financial,
      accounts,
      new InferenceBudgetService(transactions, LIMITS),
      LIMITS,
      budgets,
      new SavingsService(transactions, financial, new GoalService(transactions)),
      new DebtService(transactions, financial),
    );
  });

  afterEach(async () => {
    await database.cleanup();
  });

  function answer(text: string): Promise<string> {
    return commands.answer({
      eventId: 'telegram:1',
      chatId: 'chat-1',
      text,
      receivedAt: '2026-11-10T20:00:00.000Z',
    });
  }

  it('muestra la ayuda sin llamar al modelo', async () => {
    for (const text of ['/help', '/start', '/help@locha_bot', '/comando-inventado']) {
      const reply = await answer(text);

      expect(reply).toContain('/summary');
      expect(reply).toContain('/confirm');
      expect(interpreter.requests).toHaveLength(0);
    }
  });

  it('lista las cuentas sin llamar al modelo', async () => {
    await accounts.add({ name: 'Efectivo', currency: 'USD' });
    await accounts.add({ name: 'Banco', currency: 'VES' });

    const reply = await answer('/accounts');

    expect(reply).toContain('Efectivo');
    expect(reply).toContain('Banco');
    expect(interpreter.requests).toHaveLength(0);
  });

  it('lista los movimientos recientes con su identificador', async () => {
    const account = await accounts.add({ name: 'Efectivo', currency: 'USD' });
    const result = await financial.register({
      sourceKey: 'telegram:1',
      accountId: account.id,
      kind: 'expense',
      money: { currency: 'USD', minor: 1250n },
      occurredOn: '2026-11-10',
      description: 'Helado',
    });

    const reply = await answer('/recent');

    expect(reply).toContain(result.movement.id);
    expect(reply).toContain('12.50 USD');
    expect(reply).toContain('Efectivo');
    expect(interpreter.requests).toHaveLength(0);
  });

  it('resumen del mes con los totales exactos por moneda', async () => {
    const usd = await accounts.add({ name: 'Efectivo', currency: 'USD' });
    await financial.register({
      sourceKey: 'telegram:1',
      accountId: usd.id,
      kind: 'expense',
      money: { currency: 'USD', minor: 1250n },
      occurredOn: '2026-11-10',
    });
    await financial.register({
      sourceKey: 'telegram:2',
      accountId: usd.id,
      kind: 'income',
      money: { currency: 'USD', minor: 10000n },
      occurredOn: '2026-11-20',
    });
    await financial.register({
      sourceKey: 'telegram:3',
      accountId: usd.id,
      kind: 'expense',
      money: { currency: 'USD', minor: 500n },
      occurredOn: '2026-10-05',
    });

    const reply = await answer('/summary 2026-11');

    expect(reply).toContain('2026-11');
    expect(reply).toContain('USD');
    expect(reply).toContain('ingresos 100.00');
    expect(reply).toContain('gastos 12.50');
    expect(reply).toContain('neto 87.50');
    expect(reply).not.toContain('5.00');
    expect(reply).toContain('no son el saldo');
    expect(interpreter.requests).toHaveLength(0);
  });

  it('pide un mes valido cuando el mes no existe', async () => {
    const reply = await answer('/summary 2026-13');

    expect(reply).toContain('YYYY-MM');
    expect(interpreter.requests).toHaveLength(0);
  });

  describe('/balances', () => {
    it('muestra saldo exacto con apertura, movimiento y conversion, sin IA ni cambiar el borrador', async () => {
      const usd = await accounts.add({ name: 'Efectivo', currency: 'USD' });
      const ves = await accounts.add({ name: 'Banco', currency: 'VES' });
      await financial.open({ sourceKey: 'open', accountId: usd.id, money: { currency: 'USD', minor: 10000n }, occurredOn: '2026-11-01' });
      await financial.transfer({ sourceKey: 'convert', from: { accountId: usd.id, money: { currency: 'USD', minor: 5000n } }, to: { accountId: ves.id, money: { currency: 'VES', minor: 2000000n } }, occurredOn: '2026-11-02' });
      const captureSpy = jest.spyOn(CaptureService.prototype, 'handle');
      try {
        const reply = await answer('/balances@locha_bot 2026-11-02');
        expect(reply).toContain('50.00 USD | apertura si');
        expect(reply).toContain('20000.00 VES | apertura no');
        expect(reply).toContain(usd.id);
        expect(reply).toContain('2026-11-02');
        expect(captureSpy).not.toHaveBeenCalled();
        expect(interpreter.requests).toHaveLength(0);
      } finally {
        captureSpy.mockRestore();
      }
    });

    it('vacio y fecha invalida son deterministas', async () => {
      expect(await answer('/balances')).toContain('No hay cuentas');
      for (const argument of ['2026-02-30', '2026-11', '2026-11-02 extra']) {
        expect(await answer(`/balances ${argument}`)).toContain('Usa /balances YYYY-MM-DD');
      }
      expect((await answer('/help'))).toContain('/balances');
      expect(interpreter.requests).toHaveLength(0);
    });

    it('por defecto usa hoy en Caracas y excluye operaciones futuras', async () => {
      const usd = await accounts.add({ name: 'Efectivo', currency: 'USD' });
      await financial.open({ sourceKey: 'tomorrow', accountId: usd.id, money: { currency: 'USD', minor: 100n }, occurredOn: '2026-11-11' });
      jest.useFakeTimers({ now: new Date('2026-11-11T02:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
      try {
        const reply = await answer('/balances');
        expect(reply).toContain('2026-11-10');
        expect(reply).toContain('0.00 USD | apertura no');
        expect(interpreter.requests).toHaveLength(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('acota por filas completas y avisa de las cuentas omitidas', async () => {
      for (let index = 0; index < 60; index += 1) {
        await accounts.add({ name: `Cuenta ${index.toString().padStart(2, '0')} ${'x'.repeat(80)}`, currency: 'USD' });
      }
      const first = await answer('/balances 2026-11-10');
      expect(first).toBe(await answer('/balances 2026-11-10'));
      expect(first.length).toBeLessThanOrEqual(MAX_REPLY_LENGTH);
      expect(first).toContain('cuentas mas; usa balance:list');
      expect(first).toContain('No se suman monedas distintas');
      expect(interpreter.requests).toHaveLength(0);
    });
  });

  describe('/budgets', () => {
    it('consulta exacta independiente de categorias, sin IA ni tocar el pendiente o allowance', async () => {
      const usd = await accounts.add({ name: 'USDT', currency: 'USDT' });
      interpreter.responses.push({ amount: '2.000001', currency: 'USDT', accountId: usd.id, kind: 'expense', occurredOn: '2026-11-10', description: 'Pendiente', debt: null });
      await answer('Gaste 2 USDT');
      const pending = await database.dataSource.getRepository(Capture).find();
      const usage = await database.dataSource.getRepository(AiUsageDay).find();
      const requests = interpreter.requests.length;
      const input = { sourceKey: 'budget', name: 'Noviembre', currency: 'USDT' as const, limitMinor: 0n, startsOn: '2026-11-01', endsOn: '2026-11-30' };
      await budgets.create(input);
      await budgets.create({ ...input, sourceKey: 'category', category: 'Comida', limitMinor: 9007199254740993123456n });
      const movement = (await financial.register({ sourceKey: 'expense', accountId: usd.id, kind: 'expense', money: { currency: 'USDT', minor: 1234567n }, occurredOn: '2026-11-10' })).movement;
      await financial.editMovement({ sourceKey: 'edit', movementId: movement.id, expectedRevision: 0, amountMinor: 1234567n, occurredOn: '2026-11-10', category: 'Comida', reason: 'Categoria' });
      const reply = await answer('/budgets@locha_bot 2026-11-10');
      expect(reply).toContain('global | 2026-11-01..2026-11-30 | limite 0.000000 | gastado 1.234567 | restante -1.234567 | excedido');
      expect(reply).toContain('categoria Comida');
      expect(reply).toContain('limite 9007199254740993.123456');
      expect(reply).toContain('No sumar restantes');
      expect(reply).toContain('no saldo bancario; sin rollover');
      expect(await answer('/budgets 2026-12-01')).toContain('No hay presupuestos activos');
      for (const raw of ['2026-02-30', '2026-11', '2026-11-10 extra']) {
        expect(await answer(`/budgets ${raw}`)).toContain('Usa /budgets [YYYY-MM-DD]');
      }
      expect(await answer('/help')).toContain('/budgets');
      expect(interpreter.requests).toHaveLength(requests);
      expect(await database.dataSource.getRepository(Capture).find()).toEqual(pending);
      expect(await database.dataSource.getRepository(AiUsageDay).find()).toEqual(usage);
    });

    it('usa hoy Caracas excluyendo gastos futuros y acota por filas completas con alternativa CLI', async () => {
      const account = await accounts.add({ name: 'USD', currency: 'USD' });
      await financial.register({ sourceKey: 'future', accountId: account.id, kind: 'expense', money: { currency: 'USD', minor: 100n }, occurredOn: '2026-11-11' });
      const input = { sourceKey: 'global', name: 'Noviembre', currency: 'USD' as const, limitMinor: 100n, startsOn: '2026-11-01', endsOn: '2026-11-30' };
      await budgets.create(input);
      jest.useFakeTimers({ now: new Date('2026-11-11T02:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
      try {
        const reply = await answer('/budgets');
        expect(reply).toContain('al 2026-11-10');
        expect(reply).toContain('gastado 0.00 | restante 1.00');
      } finally { jest.useRealTimers(); }
      for (let index = 0; index < 40; index += 1) {
        await budgets.create({ ...input, sourceKey: `category:${index}`, category: `${index} ${'c'.repeat(70)}`, name: 'n'.repeat(80) });
      }
      const reply = await answer('/budgets 2026-11-10');
      expect(reply).toBe(await answer('/budgets 2026-11-10'));
      expect(reply.length).toBeLessThanOrEqual(MAX_REPLY_LENGTH);
      expect(reply).toContain('detalle omitido');
      expect(reply).toContain('CLI budget:status');
      expect(reply).toContain('No sumar restantes');
      expect(interpreter.requests).toHaveLength(0);
    });
  });

  describe('consultas B2 de solo lectura', () => {
    it('original/efectivo/historial/comision/categoria y conciliaciones sin IA ni modificar pendiente', async () => {
      const usd = await accounts.add({ name: 'Efectivo', currency: 'USD' });
      const ves = await accounts.add({ name: 'Banco', currency: 'VES' });
      interpreter.responses.push({ amount: '2.00', currency: 'USD', accountId: usd.id, kind: 'expense', occurredOn: '2026-11-10', description: 'Pendiente', debt: null });
      await answer('Gaste 2 USD');
      const pendingBefore = await database.dataSource.getRepository(Capture).find();
      const requestsBefore = interpreter.requests.length;
      const operation = (await financial.transfer({ sourceKey: 'transfer', from: { accountId: usd.id, money: { currency: 'USD', minor: 100n } }, to: { accountId: ves.id, money: { currency: 'VES', minor: 1000n } }, fee: { accountId: usd.id, money: { currency: 'USD', minor: 1n } }, occurredOn: '2026-11-10' })).operation;
      const id = operation.feeMovementId!;
      await financial.editMovement({ sourceKey: 'edit', movementId: id, expectedRevision: 0, amountMinor: 5n, occurredOn: '2026-11-11', category: 'Comisiones', reason: 'Importe correcto' });
      await financial.reconcile({ sourceKey: 'rec', accountId: usd.id, currency: 'USD', targetMinor: -200n, occurredOn: '2026-11-11', reason: 'Conteo' });
      for (const command of ['movement', 'history']) {
        const reply = await answer(`/${command}@locha_bot ${id}`);
        expect(reply).toContain('Original:');
        expect(reply).toContain('Efectivo:');
        expect(reply).toContain('Revision 1:');
        expect(reply).toContain(operation.id);
        expect(reply).toContain('Comisiones');
        expect(reply.length).toBeLessThanOrEqual(MAX_REPLY_LENGTH);
      }
      expect(await answer('/recent')).toContain('categoria Comisiones');
      expect(await answer(`/reconciliations ${usd.id}`)).toContain('objetivo -2.00 | antes -1.05 | delta -0.95');
      expect(await answer('/reconciliations')).toContain('Conteo');
      for (const text of ['/movement', '/history id extra', '/movement missing', '/reconciliations id extra', '/reconciliations missing']) {
        expect(await answer(text)).toContain('Usa /');
      }
      expect(await answer('/help')).toContain('/history');
      expect(await answer('/movement:edit')).toContain('Comandos disponibles');
      expect(interpreter.requests).toHaveLength(requestsBefore);
      expect(await database.dataSource.getRepository(Capture).find()).toEqual(pendingBefore);
    });

    it('acota historial y conciliaciones por entradas completas con alternativa CLI', async () => {
      const usd = await accounts.add({ name: 'Efectivo', currency: 'USD' });
      const id = (await financial.register({ sourceKey: 'original', accountId: usd.id, kind: 'income', money: { currency: 'USD', minor: 1n }, occurredOn: '2026-11-01' })).movement.id;
      for (let revision = 0; revision < 20; revision += 1) {
        await financial.editMovement({ sourceKey: `edit:${revision}`, movementId: id, expectedRevision: revision, amountMinor: 1n, occurredOn: '2026-11-01', reason: 'x'.repeat(280), description: 'd'.repeat(280), category: 'c'.repeat(80) });
        await financial.reconcile({ sourceKey: `rec:${revision}`, accountId: usd.id, currency: 'USD', targetMinor: 0n, occurredOn: '2026-11-01', reason: 'x'.repeat(280) });
      }
      for (const [command, fallback] of [[`/history ${id}`, 'CLI movement:history'], ['/reconciliations', 'CLI reconciliation:list']]) {
        const reply = await answer(command!);
        expect(reply).toBe(await answer(command!));
        expect(reply.length).toBeLessThanOrEqual(MAX_REPLY_LENGTH);
        expect(reply).toContain('detalle omitido');
        expect(reply).toContain(fallback);
      }
      expect(interpreter.requests).toHaveLength(0);
    });
  });

  it('manda /confirm y /cancel a la captura', async () => {
    interpreter.responses.push(
      {
        amount: '2.00',
        currency: 'USD',
        accountId: 'cuenta-1',
        kind: 'expense',
        occurredOn: '2026-11-10',
        description: 'Helado',
        debt: null,
      },
      {
        amount: '2.00',
        currency: 'USD',
        accountId: 'cuenta-1',
        kind: 'expense',
        occurredOn: '2026-11-10',
        description: 'Helado',
        debt: null,
      },
    );

    const cancel = await answer('/cancel');
    expect(cancel).toContain('No hay ninguna operacion pendiente');
    expect(interpreter.requests).toHaveLength(0);

    const confirm = await answer('/confirm');
    expect(confirm).toContain('No hay ninguna operacion pendiente');
    expect(interpreter.requests).toHaveLength(0);
  });

  it('manda un mensaje normal a la captura', async () => {
    const account = await accounts.add({ name: 'Efectivo', currency: 'USD' });
    interpreter.responses.push({
      amount: '2.00',
      currency: 'USD',
      accountId: account.id,
      kind: 'expense',
      occurredOn: '2026-11-10',
      description: 'Helado',
      debt: null,
    });

    const reply = await answer('Helado 2 dolares');

    expect(reply).toContain('/confirm');
    expect(interpreter.requests).toHaveLength(1);
  });

  describe('/usage', () => {
    async function usageDay(day: string): Promise<void> {
      const usage = database.dataSource.getRepository(AiUsageDay);
      await usage.save(
        usage.create({
          day,
          requests: 3,
          inputTokens: 6000,
          outputTokens: 1500,
          costMicroUsd: 15000,
        }),
      );
    }

    it('muestra el dia de Caracas con ceros cuando todavia no hay consumo', async () => {
      const reply = await answer('/usage');

      expect(reply).toContain(dateInTimeZone(new Date(), DEFAULT_TIME_ZONE));
      expect(reply).toContain(`llamadas reservadas: 0 de ${LIMITS.maxRequestsPerDay}`);
      expect(reply).toContain('costo reservado: 0 microUSD');
      expect(reply).toContain('Reserva local conservadora; no es la factura real del proveedor');
      expect(interpreter.requests).toHaveLength(0);
    });

    it('muestra el consumo reservado del dia', async () => {
      const day = dateInTimeZone(new Date(), DEFAULT_TIME_ZONE);
      await usageDay(day);

      const reply = await answer('/usage');

      expect(reply).toContain(day);
      expect(reply).toContain(`llamadas reservadas: 3 de ${LIMITS.maxRequestsPerDay}`);
      expect(reply).toContain('tokens de entrada reservados: 6000');
      expect(reply).toContain('tokens de salida reservados: 1500');
      expect(reply).toContain(`costo reservado: 15000 microUSD de ${LIMITS.dailyBudgetMicroUsd} microUSD`);
      expect(reply).toContain(`reserva maxima por llamada: ${LIMITS.maxCostMicroUsdPerCall} microUSD`);
      expect(interpreter.requests).toHaveLength(0);
    });

    it('muestra el limite alcanzado sin llamar al modelo', async () => {
      const day = dateInTimeZone(new Date(), DEFAULT_TIME_ZONE);
      const usage = database.dataSource.getRepository(AiUsageDay);
      await usage.save(
        usage.create({
          day,
          requests: LIMITS.maxRequestsPerDay,
          inputTokens: LIMITS.maxInputTokensPerCall * LIMITS.maxRequestsPerDay,
          outputTokens: LIMITS.maxOutputTokensPerCall * LIMITS.maxRequestsPerDay,
          costMicroUsd: LIMITS.dailyBudgetMicroUsd,
        }),
      );

      const reply = await answer('/usage');

      expect(reply).toContain(`llamadas reservadas: ${LIMITS.maxRequestsPerDay} de ${LIMITS.maxRequestsPerDay}`);
      expect(reply).toContain(
        `costo reservado: ${LIMITS.dailyBudgetMicroUsd} microUSD de ${LIMITS.dailyBudgetMicroUsd} microUSD`,
      );
      expect(interpreter.requests).toHaveLength(0);
    });

    it('empieza el dia nuevo en Caracas sin tocar el dia anterior', async () => {
      await usageDay('2026-01-01');

      const reply = await answer('/usage');

      expect(reply).not.toContain('2026-01-01');
      expect(reply).toContain('llamadas reservadas: 0 de');
      // El dia anterior queda como estaba: /usage no modifica nada.
      const previous = await database.dataSource.getRepository(AiUsageDay).findOneBy({
        day: '2026-01-01',
      });
      expect(previous?.requests).toBe(3);
      expect(previous?.costMicroUsd).toBe(15000);
    });
  });
});
