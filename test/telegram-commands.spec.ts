import { AccountService } from '../src/accounts/account.service';
import { AiUsageDay } from '../src/capture/ai-usage.entity';
import { CaptureService } from '../src/capture/capture.service';
import { DEFAULT_TIME_ZONE, InferenceBudgetService } from '../src/capture/inference-budget.service';
import { TransactionRunner } from '../src/data/transaction.runner';
import { dateInTimeZone } from '../src/domain/date';
import { FinancialService } from '../src/financial/financial.service';
import { TelegramCommands } from '../src/telegram/telegram-commands';
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

  beforeEach(async () => {
    database = await createTempDatabase();
    const transactions = new TransactionRunner(database.dataSource);
    financial = new FinancialService(transactions);
    accounts = new AccountService(database.dataSource, transactions);
    interpreter = new FakeInterpreter([]);
    const capture = new CaptureService(
      database.dataSource,
      transactions,
      financial,
      interpreter,
      new InferenceBudgetService(transactions, LIMITS),
    );
    commands = new TelegramCommands(
      capture,
      financial,
      accounts,
      new InferenceBudgetService(transactions, LIMITS),
      LIMITS,
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

  it('manda /confirm y /cancel a la captura', async () => {
    interpreter.responses.push(
      {
        amount: '2.00',
        currency: 'USD',
        accountId: 'cuenta-1',
        kind: 'expense',
        occurredOn: '2026-11-10',
        description: 'Helado',
      },
      {
        amount: '2.00',
        currency: 'USD',
        accountId: 'cuenta-1',
        kind: 'expense',
        occurredOn: '2026-11-10',
        description: 'Helado',
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
