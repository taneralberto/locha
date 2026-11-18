import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { AccountService } from '../src/accounts/account.service';
import { BudgetService } from '../src/budgets/budget.service';
import { Capture } from '../src/capture/capture.entity';
import { CaptureEvent } from '../src/capture/capture-event.entity';
import { CaptureService } from '../src/capture/capture.service';
import { InferenceBudgetService } from '../src/capture/inference-budget.service';
import { TelegramSettings } from '../src/config/configuration';
import { buildDataSourceOptions } from '../src/data/data-source';
import { TransactionRunner } from '../src/data/transaction.runner';
import { Debt } from '../src/debts/debt.entity';
import { DebtPayment } from '../src/debts/debt-payment.entity';
import { DebtService } from '../src/debts/debt.service';
import { FinancialService } from '../src/financial/financial.service';
import { Movement } from '../src/financial/movement.entity';
import { GoalService } from '../src/savings/goal.service';
import { SavingsService } from '../src/savings/savings.service';
import { Operation } from '../src/interpreter/operation.schema';
import { TelegramCommands } from '../src/telegram/telegram-commands';
import { TelegramOutbox } from '../src/telegram/telegram-outbox.entity';
import { TelegramService } from '../src/telegram/telegram.service';
import { TelegramMessage, TelegramUpdate } from '../src/telegram/telegram-update';
import { FakeInterpreter } from './helpers/fake-interpreter';
import { FakeTelegramClient, waitUntil } from './helpers/fake-telegram';

const USER_ID = 111;
const CHAT_ID = 111;
const RECEIVED_AT = '2026-11-10T20:00:00.000Z';

const SETTINGS: TelegramSettings = {
  enabled: true,
  partial: false,
  botToken: 'token-de-prueba',
  allowedUserId: USER_ID,
  allowedChatId: CHAT_ID,
  timeoutMs: 1_000,
  maxResponseBytes: 65_536,
  pollTimeoutSeconds: 1,
};

const LIMITS = {
  maxRequestsPerDay: 100,
  maxInputTokensPerCall: 2000,
  maxOutputTokensPerCall: 500,
  maxCostMicroUsdPerCall: 5000,
  dailyBudgetMicroUsd: 200000,
};

function debtData(overrides: Partial<NonNullable<Operation['debt']>> = {}) {
  return {
    direction: null,
    counterparty: null,
    debtId: null,
    settlementMode: null,
    status: null,
    queryDetail: null,
    ...overrides,
  };
}

describe('Telegram de deudas (unidad 2)', () => {
  let directory: string;
  let databasePath: string;
  let dataSource: DataSource;
  let client: FakeTelegramClient;
  let interpreter: FakeInterpreter;
  let telegram: TelegramService;
  let commands: TelegramCommands;
  let financial: FinancialService;
  let debts: DebtService;
  let accountId: string;
  let event: number;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'locha-debt-tg-'));
    databasePath = join(directory, 'locha.sqlite');
    dataSource = await open(databasePath);
    const transactions = new TransactionRunner(dataSource);
    const accounts = new AccountService(dataSource, transactions);
    accountId = (await accounts.add({ name: 'Efectivo', currency: 'USD' })).id;
    client = new FakeTelegramClient();
    interpreter = new FakeInterpreter([]);
    financial = new FinancialService(transactions);
    debts = new DebtService(transactions, financial);
    telegram = buildService(dataSource, client, interpreter);
    event = 0;
  });

  afterEach(async () => {
    await telegram.stop();
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
    rmSync(directory, { recursive: true, force: true });
  });

  async function open(path: string): Promise<DataSource> {
    const source = new DataSource(buildDataSourceOptions(path));
    await source.initialize();
    await source.runMigrations();
    return source;
  }

  function buildService(
    source: DataSource,
    telegramClient: FakeTelegramClient,
    operationInterpreter: FakeInterpreter,
  ): TelegramService {
    const transactions = new TransactionRunner(source);
    const financialService = new FinancialService(transactions);
    const capture = new CaptureService(
      source,
      transactions,
      financialService,
      operationInterpreter,
      new InferenceBudgetService(transactions, LIMITS),
      new DebtService(transactions, financialService),
    );
    commands = new TelegramCommands(
      capture,
      financialService,
      new AccountService(source, transactions),
      new InferenceBudgetService(transactions, LIMITS),
      LIMITS,
      new BudgetService(transactions, financialService),
      new SavingsService(transactions, financialService, new GoalService(transactions)),
      new DebtService(transactions, financialService),
    );
    return new TelegramService(source, transactions, commands, capture, telegramClient, SETTINGS);
  }

  function answer(text: string, eventId = `telegram:deuda:${event++}`): Promise<string> {
    return commands.answer({ text, eventId, chatId: String(CHAT_ID), receivedAt: RECEIVED_AT });
  }

  function update(updateId: number, text: string, message: Partial<TelegramMessage> = {}): TelegramUpdate {
    return {
      updateId,
      message: {
        chatId: String(CHAT_ID),
        chatType: 'private',
        userId: String(USER_ID),
        isBot: false,
        text,
        receivedAt: RECEIVED_AT,
        ...message,
      },
    };
  }

  it('/debts y /debts [persona] son deterministas, no llaman al modelo y no tocan el pendiente', async () => {
    const debt = (
      await debts.create({
        sourceKey: 'deuda',
        direction: 'payable',
        counterparty: 'Carmen',
        money: { currency: 'USD', minor: 1000n },
        occurredOn: '2026-11-01',
      })
    ).debt;
    const receivable = (
      await debts.create({
        sourceKey: 'cobro',
        direction: 'receivable',
        counterparty: 'Vecino',
        money: { currency: 'USD', minor: 2500n },
        occurredOn: '2026-11-01',
      })
    ).debt;

    const list = await answer('/debts');

    expect(list).toContain('Lo que debo');
    expect(list).toContain('Lo que me deben');
    expect(list).toContain('Carmen');
    expect(list).not.toContain(debt.id);
    expect(list).not.toContain(receivable.id);
    expect(list).toContain('pendiente 10.00');
    expect(list).toContain('pendiente 25.00');
    expect(list).toContain('lo que debo: 10.00 USD');
    expect(list).toContain('lo que me deben: 25.00 USD');
    expect(interpreter.requests).toHaveLength(0);

    // Por persona: se muestran todas sus deudas, sin ids.
    const one = await answer('/debts Carmen');
    expect(one).toContain('Carmen');
    expect(one).not.toContain(receivable.id);
    expect(one).not.toContain(debt.id);
    // El id escrito sigue funcionando, pero no se muestra.
    const byId = await answer(`/debts ${debt.id}`);
    expect(byId).toContain('Carmen');
    expect(byId).not.toContain(debt.id);

    const missing = await answer('/debts no-existe');
    expect(missing).toContain('No hay ninguna deuda');
    expect(missing).not.toContain('no-existe');

    expect(await dataSource.getRepository(Capture).count()).toBe(0);
    expect(await dataSource.getRepository(Movement).count()).toBe(0);
  });

  it('la ayuda menciona /debts y las deudas por lenguaje natural', async () => {
    const help = await answer('/help');

    expect(help).toContain('/debts');
    expect(help).toContain('Las deudas se crean y se pagan escribiendo en lenguaje natural');
  });

  it('crea una deuda por el bot y la respuesta durable no lleva identificadores', async () => {
    interpreter.responses.push({
      amount: '8.00',
      currency: 'USD',
      accountId: null,
      kind: 'debt_create',
      occurredOn: '2026-11-10',
      description: 'dos tortas',
      debt: debtData({ direction: 'payable', counterparty: 'Carmen' }),
    });

    const preview = await answer('le debo 8$ a Carmen de dos tortas');
    expect(preview).toContain('Carmen');
    expect(preview).toContain('/confirm');

    const confirmed = await answer('/confirm', 'telegram:deuda:confirm');
    expect(confirmed).toContain('Registrado');
    expect(confirmed).toContain('deuda de 8.00 USD con Carmen');
    expect(confirmed).not.toContain('Deuda:');
    expect(await dataSource.getRepository(Debt).count()).toBe(1);
    expect(await dataSource.getRepository(Movement).count()).toBe(0);
  });

  it('un pago de deuda registra el movimiento y avisa de las reservas, como cualquier captura', async () => {
    const transactions = new TransactionRunner(dataSource);
    const goals = new GoalService(transactions);
    const savings = new SavingsService(transactions, financial, goals);
    await financial.open({
      sourceKey: 'open',
      accountId,
      money: { currency: 'USD', minor: 100n },
      occurredOn: '2020-01-01',
    });
    const goal = (await goals.create({ sourceKey: 'goal', name: 'Fondo', currency: 'USD', targetMinor: 100n })).goal;
    await savings.reserve({ sourceKey: 'reserve', goalId: goal.id, accountId, currency: 'USD', amountMinor: 100n });
    const debt = (
      await debts.create({
        sourceKey: 'deuda',
        direction: 'payable',
        counterparty: 'Carmen',
        money: { currency: 'USD', minor: 1000n },
        occurredOn: '2026-11-01',
      })
    ).debt;

    interpreter.responses.push({
      amount: '2.00',
      currency: 'USD',
      accountId,
      kind: 'debt_settle',
      occurredOn: '2026-11-10',
      description: null,
      debt: debtData({
        direction: 'payable',
        counterparty: 'Carmen',
        settlementMode: 'partial',
      }),
    });

    const preview = await answer('le pagué 2 dólares a Carmen');
    expect(preview).toContain('Carmen');
    expect(preview).not.toContain(debt.id);

    const confirmed = await answer('/confirm', 'telegram:deuda:pago');
    expect(confirmed).toContain('Registrado');
    expect(confirmed).toContain('pago de 2.00 USD de la deuda con Carmen');
    expect(confirmed).not.toContain('Pago:');
    expect(confirmed).not.toContain('Movimiento:');
    expect(confirmed).not.toContain(debt.id);
    expect(confirmed).toContain('ADVERTENCIA');

    // La advertencia es diagnostico de entrega: el reply durable no la lleva.
    const stored = await dataSource.getRepository(CaptureEvent).findOneByOrFail({ eventId: 'telegram:deuda:pago' });
    expect(stored.reply).not.toContain('ADVERTENCIA');
    expect(stored.movementId).not.toBeNull();
    expect(await dataSource.getRepository(Movement).count()).toBe(1);
    expect(await dataSource.getRepository(DebtPayment).count()).toBe(1);
  });

  it('una consulta por lenguaje natural no toca el borrador pendiente', async () => {
    await debts.create({
      sourceKey: 'deuda',
      direction: 'payable',
      counterparty: 'Carmen',
      money: { currency: 'USD', minor: 1000n },
      occurredOn: '2026-11-01',
    });
    interpreter.responses.push({
      amount: '8.00',
      currency: 'USD',
      accountId: null,
      kind: 'debt_create',
      occurredOn: '2026-11-10',
      description: null,
      debt: debtData({ direction: 'payable', counterparty: 'Carmen' }),
    });
    interpreter.responses.push({
      amount: null,
      currency: null,
      accountId: null,
      kind: 'debt_query',
      occurredOn: null,
      description: null,
      debt: debtData({ direction: 'payable', counterparty: 'Carmen' }),
    });

    await answer('le debo 8$ a Carmen');
    const before = await dataSource.getRepository(Capture).findOneByOrFail({ chatId: String(CHAT_ID) });

    const query = await answer('qué le debo a Carmen');

    expect(query).toContain('Lo que debo');
    expect(query).toContain('Carmen');
    expect(await dataSource.getRepository(Capture).findOneByOrFail({ chatId: String(CHAT_ID) })).toEqual(before);
    expect(await dataSource.getRepository(Debt).count()).toBe(1);
  });

  it('el bot responde la consulta en lenguaje natural con la lista breve', async () => {
    const debt = (
      await debts.create({
        sourceKey: 'deuda',
        direction: 'payable',
        counterparty: 'Carmen',
        money: { currency: 'USD', minor: 700n },
        occurredOn: '2026-11-01',
      })
    ).debt;
    const receivable = (
      await debts.create({
        sourceKey: 'cobro',
        direction: 'receivable',
        counterparty: 'Ana',
        money: { currency: 'USDT', minor: 1123456n },
        occurredOn: '2026-11-01',
      })
    ).debt;
    interpreter.responses.push({
      amount: null,
      currency: null,
      accountId: null,
      kind: 'debt_query',
      occurredOn: null,
      description: null,
      debt: debtData(),
    });

    await telegram.start();
    client.enqueue(update(10, 'cuáles son mis deudas'));
    await waitUntil(() => client.sent.length === 1);

    // El mensaje que ve el usuario: la lista breve, con la linea en blanco entre los
    // grupos y sin ningun identificador tecnico.
    const sent = client.lastSent?.text ?? '';
    expect(sent).toBe(
      ['Lo que debo:', '• Carmen — $7', '', 'Lo que me deben:', '• Ana — 1.123456 USDT'].join('\n'),
    );
    expect(sent).not.toContain(debt.id);
    expect(sent).not.toContain(receivable.id);
    expect(await dataSource.getRepository(Debt).count()).toBe(2);
  });

  it('el bot no pierde el nombre ni el importe de una persona que se llama Clave', async () => {
    const debt = (
      await debts.create({
        sourceKey: 'deuda',
        direction: 'payable',
        counterparty: 'Clave',
        money: { currency: 'USD', minor: 500n },
        occurredOn: '2026-11-01',
      })
    ).debt;
    interpreter.responses.push({
      amount: null,
      currency: null,
      accountId: null,
      kind: 'debt_query',
      occurredOn: null,
      description: null,
      debt: debtData(),
    });

    await telegram.start();
    client.enqueue(update(12, 'cuáles son mis deudas'));
    await waitUntil(() => client.sent.length === 1);

    // El sanitizer de Telegram quita lo que va detras de un "clave:" o un "key:":
    // por eso la viñeta usa un separador visual y no un dos puntos.
    const sent = client.lastSent?.text ?? '';
    expect(sent).toBe('Lo que debo:\n• Clave — $5');
    expect(sent).toContain('Clave');
    expect(sent).toContain('$5');
    expect(sent).not.toContain(debt.id);
  });

  it('el bot responde el detalle de una deuda con el monto inicial y los abonos', async () => {
    const debt = (
      await debts.create({
        sourceKey: 'deuda',
        direction: 'payable',
        counterparty: 'Carmen',
        money: { currency: 'USD', minor: 800n },
        occurredOn: '2026-11-01',
      })
    ).debt;
    await debts.settle({
      sourceKey: 'pago',
      debtId: debt.id,
      accountId,
      money: { currency: 'USD', minor: 300n },
      occurredOn: '2026-11-05',
      expectedOutstandingMinor: 800n,
    });
    interpreter.responses.push({
      amount: null,
      currency: null,
      accountId: null,
      kind: 'debt_query',
      occurredOn: null,
      description: null,
      debt: debtData({ direction: 'payable', counterparty: 'Carmen', queryDetail: true }),
    });

    await telegram.start();
    client.enqueue(update(11, 'cuánto le he pagado a Carmen'));
    await waitUntil(() => client.sent.length === 1);

    const sent = client.lastSent?.text ?? '';
    expect(sent).toContain('Monto inicial: $8');
    expect(sent).toContain('Le he pagado: $3');
    expect(sent).toContain('Me falta por pagar: $5');
    expect(sent).not.toContain(debt.id);
  });

  it('el bot registra la deuda una sola vez cuando Telegram repite la actualizacion', async () => {
    interpreter.responses.push({
      amount: '8.00',
      currency: 'USD',
      accountId: null,
      kind: 'debt_create',
      occurredOn: '2026-11-10',
      description: null,
      debt: debtData({ direction: 'payable', counterparty: 'Carmen' }),
    });

    await telegram.start();
    client.enqueue(update(10, 'le debo 8$ a Carmen'));
    await waitUntil(() => client.sent.length === 1);
    client.enqueue(update(10, 'le debo 8$ a Carmen'));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await dataSource.getRepository(Debt).count()).toBe(0);
    expect(await dataSource.getRepository(CaptureEvent).count()).toBe(1);

    const outbox = await dataSource.getRepository(TelegramOutbox).findOneByOrFail({ updateId: 10 });
    expect(outbox.text).toContain('/confirm');
  });

  it('un usuario no autorizado no confirma la deuda del chat', async () => {
    interpreter.responses.push({
      amount: '8.00',
      currency: 'USD',
      accountId: null,
      kind: 'debt_create',
      occurredOn: '2026-11-10',
      description: null,
      debt: debtData({ direction: 'payable', counterparty: 'Carmen' }),
    });

    await telegram.start();
    client.enqueue(update(10, 'le debo 8$ a Carmen'));
    await waitUntil(() => client.sent.length === 1);

    // Otro usuario del mismo chat no esta autorizado: su mensaje se descarta.
    client.enqueue(update(11, '/confirm', { userId: '999' }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await dataSource.getRepository(Debt).count()).toBe(0);
    const draft = await dataSource.getRepository(Capture).findOneByOrFail({ chatId: String(CHAT_ID) });
    expect(draft.state).toBe('awaiting_confirmation');

    // El usuario autorizado si confirma su borrador.
    client.enqueue(update(12, '/confirm'));
    await waitUntil(() => client.sent.length === 2);

    expect(await dataSource.getRepository(Debt).count()).toBe(1);
  });
});
