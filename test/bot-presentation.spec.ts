import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { AccountService } from '../src/accounts/account.service';
import { BudgetService } from '../src/budgets/budget.service';
import { CaptureEvent } from '../src/capture/capture-event.entity';
import { CaptureService } from '../src/capture/capture.service';
import { InferenceBudgetService } from '../src/capture/inference-budget.service';
import { TelegramSettings } from '../src/config/configuration';
import { buildDataSourceOptions } from '../src/data/data-source';
import { TransactionRunner } from '../src/data/transaction.runner';
import { DebtService } from '../src/debts/debt.service';
import { FinancialService } from '../src/financial/financial.service';
import { Movement } from '../src/financial/movement.entity';
import { GoalService } from '../src/savings/goal.service';
import { SavingsService } from '../src/savings/savings.service';
import { TelegramCommands } from '../src/telegram/telegram-commands';
import { TelegramOutbox } from '../src/telegram/telegram-outbox.entity';
import { TelegramService } from '../src/telegram/telegram.service';
import { FakeInterpreter } from './helpers/fake-interpreter';
import { FakeTelegramClient, waitUntil } from './helpers/fake-telegram';

/**
 * Presentacion del bot: lo que ve el usuario nunca lleva identificadores tecnicos.
 * Los ids siguen siendo de la CLI y de la base de datos.
 */

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

/** Un identificador tecnico: el formato de un uuid. */
const UUID = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i;

/** Etiquetas de un dato tecnico: tampoco se muestran. */
const TECHNICAL_LABELS = [
  'sourceKey',
  'accountId',
  'movementId',
  'amountMinor',
  'debtId',
  'paymentId',
  'goalId',
  'budgetId',
  'createdAt',
  'updatedAt',
  'chatId',
  'userId',
  'captureState',
  'sourceText',
];

describe('Presentacion del bot sin identificadores tecnicos', () => {
  let directory: string;
  let databasePath: string;
  let dataSource: DataSource;
  let client: FakeTelegramClient;
  let interpreter: FakeInterpreter;
  let telegram: TelegramService;
  let commands: TelegramCommands;
  let financial: FinancialService;
  let debts: DebtService;
  let goals: GoalService;
  let savings: SavingsService;
  let budgets: BudgetService;
  let accounts: AccountService;
  let accountId: string;
  /** Todos los identificadores de la base de datos: ninguno puede salir al chat. */
  let technicalIds: string[] = [];
  let event: number;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'locha-presentacion-'));
    databasePath = join(directory, 'locha.sqlite');
    dataSource = await open(databasePath);
    const transactions = new TransactionRunner(dataSource);
    financial = new FinancialService(transactions);
    accounts = new AccountService(dataSource, transactions);
    goals = new GoalService(transactions);
    savings = new SavingsService(transactions, financial, goals);
    budgets = new BudgetService(transactions, financial);
    debts = new DebtService(transactions, financial);
    client = new FakeTelegramClient();
    interpreter = new FakeInterpreter([]);
    telegram = buildService();
    accountId = (await accounts.add({ name: 'Efectivo', currency: 'USD' })).id;
    await seed();
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

  function buildService(): TelegramService {
    const transactions = new TransactionRunner(dataSource);
    const financialService = new FinancialService(transactions);
    const capture = new CaptureService(
      dataSource,
      transactions,
      financialService,
      interpreter,
      new InferenceBudgetService(transactions, LIMITS),
      new DebtService(transactions, financialService),
    );
    commands = new TelegramCommands(
      capture,
      financialService,
      new AccountService(dataSource, transactions),
      new InferenceBudgetService(transactions, LIMITS),
      LIMITS,
      new BudgetService(transactions, financialService),
      new SavingsService(transactions, financialService, new GoalService(transactions)),
      new DebtService(transactions, financialService),
    );
    return new TelegramService(dataSource, transactions, commands, client, SETTINGS);
  }

  /** Datos de los cuatro dominios: cuentas, movimientos, deudas, metas y presupuestos. */
  async function seed(): Promise<void> {
    await financial.open({
      sourceKey: 'apertura',
      accountId,
      money: { currency: 'USD', minor: 100000n },
      occurredOn: '2026-11-01',
    });
    const movement = (
      await financial.register({
        sourceKey: 'movimiento',
        accountId,
        kind: 'expense',
        money: { currency: 'USD', minor: 1250n },
        occurredOn: '2026-11-10',
        description: 'Helado',
      })
    ).movement;
    await financial.editMovement({
      sourceKey: 'revision',
      movementId: movement.id,
      expectedRevision: 0,
      amountMinor: 1500n,
      occurredOn: '2026-11-10',
      category: 'Comidas',
      reason: 'Importe corregido',
    });
    await financial.reconcile({
      sourceKey: 'conciliacion',
      accountId,
      currency: 'USD',
      targetMinor: 98500n,
      occurredOn: '2026-11-10',
      reason: 'Conteo de caja',
    });
    await budgets.create({
      sourceKey: 'presupuesto',
      name: 'Noviembre',
      currency: 'USD',
      limitMinor: 10000n,
      startsOn: '2026-11-01',
      endsOn: '2026-11-30',
    });
    const goal = (
      await goals.create({ sourceKey: 'meta', name: 'Fondo', currency: 'USD', targetMinor: 5000n })
    ).goal;
    await savings.reserve({ sourceKey: 'reserva', goalId: goal.id, accountId, currency: 'USD', amountMinor: 1000n });
    const debt = (
      await debts.create({
        sourceKey: 'deuda',
        direction: 'payable',
        counterparty: 'Carmen',
        money: { currency: 'USD', minor: 10000n },
        occurredOn: '2026-11-01',
      })
    ).debt;
    await debts.settle({
      sourceKey: 'pago',
      debtId: debt.id,
      accountId,
      money: { currency: 'USD', minor: 3000n },
      occurredOn: '2026-11-05',
      expectedOutstandingMinor: 10000n,
    });

    const movements = await dataSource.getRepository(Movement).find();
    const listed = await accounts.list();
    technicalIds = [
      accountId,
      ...listed.map((account) => account.id),
      ...movements.map((row) => row.id),
      debt.id,
      goal.id,
      ...(await dataSource.getRepository(TelegramOutbox).find()).map((row) => row.id),
    ];
  }

  function answer(text: string, eventId = `telegram:presentacion:${event++}`): Promise<string> {
    return commands.answer({ text, eventId, chatId: String(CHAT_ID), receivedAt: RECEIVED_AT });
  }

  /** Ningun identificador tecnico ni etiqueta tecnica puede salir en la respuesta. */
  function expectClean(reply: string): void {
    for (const id of technicalIds) {
      expect(reply).not.toContain(id);
    }
    expect(reply).not.toMatch(UUID);
    for (const label of TECHNICAL_LABELS) {
      expect(reply).not.toContain(label);
    }
    expect(reply).not.toContain('":');
    expect(reply).not.toContain('": "');
  }

  it('ninguna consulta muestra identificadores: cuentas, saldos, presupuestos, metas, deudas y movimientos', async () => {
    const replies = await Promise.all([
      answer('/help'),
      answer('/accounts'),
      answer('/balances'),
      answer('/balances 2026-11-10'),
      answer('/budgets 2026-11-10'),
      answer('/goals'),
      answer('/goals Fondo'),
      answer('/savings'),
      answer('/debts'),
      answer('/debts Carmen'),
      answer('/recent'),
      answer('/movement'),
      answer('/movement ultimo'),
      answer('/history'),
      answer('/reconciliations'),
      answer('/reconciliations Efectivo'),
      answer('/summary 2026-11'),
      answer('/usage'),
    ]);
    for (const reply of replies) {
      expectClean(reply);
    }
    // Las respuestas siguen siendo utiles: muestran nombres, fechas e importes.
    expect(replies[1]).toContain('Efectivo');
    expect(replies[6]).toContain('Fondo');
    expect(replies[8]).toContain('Carmen');
    expect(replies[11]).toContain('Original:');
    expect(replies[15]).toContain('Conteo de caja');
  });

  it('la captura no muestra ids: resumen previo, registro, error y advertencia', async () => {
    interpreter.responses.push({
      amount: '2.00',
      currency: 'USD',
      accountId,
      kind: 'expense',
      occurredOn: '2026-11-10',
      description: 'Helado',
      debt: null,
    });
    const preview = await answer('Helado 2 dolares');
    expectClean(preview);
    expect(preview).toContain('Efectivo');

    const registered = await answer('/confirm', 'telegram:presentacion:confirm');
    expectClean(registered);
    expect(registered).toContain('Registrado');
    expect(registered).not.toContain('Movimiento:');

    // Un error de dominio no muestra el id de la cuenta que no existe.
    interpreter.responses.push({
      amount: '2.00',
      currency: 'USD',
      accountId: '00000000-0000-4000-8000-000000000000',
      kind: 'expense',
      occurredOn: '2026-11-10',
      description: null,
      debt: null,
    });
    const failed = await answer('Gaste 2 dolares', 'telegram:presentacion:error');
    expectClean(failed);
    expect(failed).toContain('falta la cuenta');
  });

  it('las deudas se crean y se pagan sin ids, y la lista de eleccion no los enseña', async () => {
    interpreter.responses.push({
      amount: '8.00',
      currency: 'USD',
      accountId: null,
      kind: 'debt_create',
      occurredOn: '2026-11-10',
      description: null,
      debt: {
        direction: 'payable',
        counterparty: 'Carmen',
        debtId: null,
        settlementMode: null,
        status: null,
      },
    });
    const preview = await answer('le debo 8$ a Carmen');
    expectClean(preview);

    const registered = await answer('/confirm', 'telegram:presentacion:deuda');
    expectClean(registered);
    expect(registered).toContain('deuda de 8.00 USD con Carmen');

    const debtsReply = await answer('/debts Carmen');
    expectClean(debtsReply);
    expect(debtsReply).toContain('Carmen');
  });

  it('una respuesta durable vieja (con ids y JSON) nunca se envia tal cual', async () => {
    const events = dataSource.getRepository(CaptureEvent);
    const stored = await events.save(
      events.create({
        eventId: 'telegram:presentacion:viejo',
        chatId: String(CHAT_ID),
        state: 'completed',
        reply: [
          `Movimiento: ${technicalIds[0]}`,
          'Original: {"id":"' + technicalIds[0] + '","sourceKey":"capture:chat-1:event-1","amountMinor":1250}',
        ].join('\n'),
        captureState: 'registered',
        movementId: technicalIds[0] ?? null,
      }),
    );
    expect(stored.reply).toContain('sourceKey');

    const reply = await answer('/confirm', 'telegram:presentacion:viejo');
    expectClean(reply);
  });

  it('el error de dominio con una clave no enseña la clave y no deja la respuesta vacia', async () => {
    const key = `capture:${'a'.repeat(64)}`;
    const events = dataSource.getRepository(CaptureEvent);
    await events.save(
      events.create({
        eventId: 'telegram:presentacion:clave',
        chatId: String(CHAT_ID),
        state: 'completed',
        reply: `No se pudo registrar la operacion: La clave "${key}" ya existe con otro contenido.`,
        captureState: 'awaiting_details',
        movementId: null,
      }),
    );

    const reply = await answer('/confirm', 'telegram:presentacion:clave');

    expect(reply).not.toContain(key);
    expect(reply).not.toMatch(/[0-9a-f]{64}/);
    expect(reply).toContain('Ya existe una operacion con esa clave');
    expect(reply.trim().length).toBeGreaterThan(0);
  });

  it('una clave con espacios entre comillas no se muestra, ni en el replay ni en la bandeja de salida', async () => {
    const key = 'manual key with spaces';
    const text = `Registrado: gasto de 2.00 USD con la clave sourceKey: "${key}" en la cuenta Efectivo.`;
    const events = dataSource.getRepository(CaptureEvent);
    await events.save(
      events.create({
        eventId: 'telegram:presentacion:clave-espacios',
        chatId: String(CHAT_ID),
        state: 'completed',
        reply: text,
        captureState: 'registered',
        movementId: null,
      }),
    );

    const reply = await answer('/confirm', 'telegram:presentacion:clave-espacios');

    expect(reply).not.toContain(key);
    expect(reply).not.toContain('key with spaces');
    // El importe y el nombre de la cuenta se conservan.
    expect(reply).toContain('Registrado: gasto de 2.00 USD');
    expect(reply).toContain('en la cuenta Efectivo.');
    // La fila durable guarda el texto original: no se reescribe.
    const stored = await events.findOneByOrFail({ eventId: 'telegram:presentacion:clave-espacios' });
    expect(stored.reply).toBe(text);

    // La misma clave en una respuesta pendiente de la bandeja de salida.
    const outbox = dataSource.getRepository(TelegramOutbox);
    await outbox.save(
      outbox.create({
        updateId: 902,
        chatId: String(CHAT_ID),
        userId: String(USER_ID),
        text,
        state: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
      }),
    );

    await telegram.start();
    await waitUntil(() => client.sent.length === 1);

    const sent = client.sent[0]?.text ?? '';
    expect(sent).not.toContain(key);
    expect(sent).not.toContain('key with spaces');
    expect(sent).toContain('Registrado: gasto de 2.00 USD');
    const pending = await outbox.findOneByOrFail({ updateId: 902 });
    expect(pending.text).toBe(text);
  });

  it('el error de clave con comillas dentro se cuenta entero y no deja parte de la clave', async () => {
    const key = 'manual-"private"-123';
    const events = dataSource.getRepository(CaptureEvent);
    await events.save(
      events.create({
        eventId: 'telegram:presentacion:clave-comillas',
        chatId: String(CHAT_ID),
        state: 'completed',
        reply: `No se pudo registrar la operacion: La clave "${key}" ya existe con otro contenido.`,
        captureState: 'awaiting_details',
        movementId: null,
      }),
    );

    const reply = await answer('/confirm', 'telegram:presentacion:clave-comillas');

    expect(reply).not.toContain('private');
    expect(reply).not.toContain('manual');
    expect(reply).toContain('Ya existe una operacion con esa clave');
  });

  it('el error de clave con comillas escapadas y con salto de linea no deja la clave a la vista', async () => {
    const events = dataSource.getRepository(CaptureEvent);
    await events.save(
      events.create({
        eventId: 'telegram:presentacion:clave-linea',
        chatId: String(CHAT_ID),
        state: 'completed',
        reply:
          'No se pudo registrar la operacion: La clave "secreto\nprivado del dia" ya existe con otro contenido.',
        captureState: 'awaiting_details',
        movementId: null,
      }),
    );

    const reply = await answer('/confirm', 'telegram:presentacion:clave-linea');

    expect(reply).not.toContain('secreto');
    expect(reply).not.toContain('privado del dia');
    expect(reply).toContain('Ya existe una operacion con esa clave');
  });

  it('una clave entre comillas sin cerrar se quita entera, no a medias', async () => {
    const events = dataSource.getRepository(CaptureEvent);
    await events.save(
      events.create({
        eventId: 'telegram:presentacion:clave-rota',
        chatId: String(CHAT_ID),
        state: 'completed',
        reply: 'Registrado: gasto de 2.00 USD con la clave sourceKey: "sin cerrar',
        captureState: 'registered',
        movementId: null,
      }),
    );

    const reply = await answer('/confirm', 'telegram:presentacion:clave-rota');

    expect(reply).not.toContain('sin cerrar');
    expect(reply).toContain('Registrado: gasto de 2.00 USD');
  });

  it('una clave de la aplicacion incrustada en una respuesta vieja se quita entera', async () => {
    const key = `ledger:${technicalIds[0]}:fee`;
    const outbox = dataSource.getRepository(TelegramOutbox);
    await outbox.save(
      outbox.create({
        updateId: 901,
        chatId: String(CHAT_ID),
        userId: String(USER_ID),
        text: `Registrado: gasto de 2.00 USD con la clave ${key} en la cuenta Efectivo.`,
        state: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
      }),
    );

    await telegram.start();
    await waitUntil(() => client.sent.length === 1);

    const sent = client.sent[0]?.text ?? '';
    expect(sent).not.toContain(key);
    expect(sent).not.toContain(technicalIds[0] as string);
    expect(sent).toContain('Registrado: gasto de 2.00 USD');
    expect(sent).toContain('en la cuenta Efectivo.');
  });

  it('el texto del usuario con llaves se conserva tal cual', async () => {
    interpreter.responses.push({
      amount: '2.00',
      currency: 'USD',
      accountId,
      kind: 'expense',
      occurredOn: '2026-11-10',
      description: 'Caja {id: local}',
      debt: null,
    });

    const preview = await answer('Caja {id: local}');

    expect(preview).toContain('Caja {id: local}');
    expect(preview).not.toMatch(UUID);
  });

  it('una respuesta que solo es un identificador no se envia vacia', async () => {
    const events = dataSource.getRepository(CaptureEvent);
    await events.save(
      events.create({
        eventId: 'telegram:presentacion:solo-id',
        chatId: String(CHAT_ID),
        state: 'completed',
        reply: `Movimiento: ${technicalIds[0]}`,
        captureState: 'registered',
        movementId: technicalIds[0] ?? null,
      }),
    );

    const reply = await answer('/confirm', 'telegram:presentacion:solo-id');

    expect(reply.trim().length).toBeGreaterThan(0);
    expect(reply).not.toMatch(UUID);
  });

  it('una respuesta pendiente en la bandeja de salida no envia ids ni JSON', async () => {
    const outbox = dataSource.getRepository(TelegramOutbox);
    await outbox.save(
      outbox.create({
        updateId: 900,
        chatId: String(CHAT_ID),
        userId: String(USER_ID),
        text: `Registrado: gasto de 2.00 USD.\nMovimiento: ${technicalIds[0]}`,
        state: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
      }),
    );

    await telegram.start();
    await waitUntil(() => client.sent.length === 1);

    expect(client.sent[0]?.text).not.toContain(technicalIds[0] as string);
    expect(client.sent[0]?.text).not.toMatch(UUID);
    expect(client.sent[0]?.text).toContain('Registrado: gasto de 2.00 USD');
  });
});
