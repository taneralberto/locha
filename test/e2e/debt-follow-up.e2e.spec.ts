import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { AccountService } from '../../src/accounts/account.service';
import { BudgetService } from '../../src/budgets/budget.service';
import { Capture } from '../../src/capture/capture.entity';
import { CaptureService } from '../../src/capture/capture.service';
import { InferenceBudgetService } from '../../src/capture/inference-budget.service';
import { TelegramSettings } from '../../src/config/configuration';
import { buildDataSourceOptions } from '../../src/data/data-source';
import { TransactionRunner } from '../../src/data/transaction.runner';
import { DebtService } from '../../src/debts/debt.service';
import { FinancialService } from '../../src/financial/financial.service';
import { Movement } from '../../src/financial/movement.entity';
import { GoalService } from '../../src/savings/goal.service';
import { SavingsService } from '../../src/savings/savings.service';
import { TelegramCommands } from '../../src/telegram/telegram-commands';
import { TelegramService } from '../../src/telegram/telegram.service';
import { TelegramMessage, TelegramUpdate } from '../../src/telegram/telegram-update';
import { FakeFollowUpInterpreter } from '../helpers/fake-follow-up-interpreter';
import { FakeInterpreter } from '../helpers/fake-interpreter';
import { FakeTelegramClient, waitUntil } from '../helpers/fake-telegram';

const USER_ID = 111;
const CHAT_ID = 111;

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

/**
 * La ventana del historial vive una hora: las marcas de tiempo tienen que ser
 * **actuales**, como las de un chat de verdad.
 */
function now(): string {
  return new Date().toISOString();
}

/** La consulta de deudas que el modelo normal devuelve para una pregunta completa. */
function debtQueryOperation(counterparty: string | null) {
  return {
    amount: null,
    currency: counterparty === null ? null : ('USD' as const),
    accountId: null,
    kind: 'debt_query' as const,
    occurredOn: null,
    description: null,
    debt: {
      direction: 'payable' as const,
      counterparty,
      debtId: null,
      settlementMode: null,
      status: null,
      queryDetail: null,
    },
  };
}

/** El modelo normal enruta la pregunta contextual: la resuelve otra llamada. */
function followUpOperation() {
  return {
    amount: null,
    currency: null,
    accountId: null,
    kind: 'debt_follow_up' as const,
    occurredOn: null,
    description: null,
    debt: null,
  };
}

/** La consulta general de deudas: los dos grupos, sin filtros. */
function generalQueryOperation() {
  return {
    amount: null,
    currency: null,
    accountId: null,
    kind: 'debt_query' as const,
    occurredOn: null,
    description: null,
    debt: {
      direction: null,
      counterparty: null,
      debtId: null,
      settlementMode: null,
      status: null,
      queryDetail: null,
    },
  };
}

/** La respuesta del modelo contextual: un grupo por direccion, sin persona. */
function groupAnswer(direction: 'payable' | 'receivable') {
  return {
    kind: 'debt_group' as const,
    direction,
    counterparty: null,
    currency: null,
    status: null,
    queryDetail: null,
  };
}

/**
 * Suite de extremo a extremo de la consulta de seguimiento: un Telegram simulado con
 * las horas de ahora, un interpretador simulado y una base temporal real. No hace
 * ninguna llamada externa.
 */
describe('Consulta de seguimiento por el chat', () => {
  let directory: string;
  let databasePath: string;
  let dataSource: DataSource;
  let client: FakeTelegramClient;
  let interpreter: FakeInterpreter;
  let followUp: FakeFollowUpInterpreter;
  let telegram: TelegramService;
  let financial: FinancialService;
  let debts: DebtService;
  let accountId: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'locha-followup-e2e-'));
    databasePath = join(directory, 'locha.sqlite');
    dataSource = await open(databasePath);
    const accounts = new AccountService(dataSource, new TransactionRunner(dataSource));
    accountId = (await accounts.add({ name: 'Efectivo USD', currency: 'USD' })).id;
    client = new FakeTelegramClient();
    interpreter = new FakeInterpreter([]);
    followUp = new FakeFollowUpInterpreter([]);
    build();
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

  function build(): void {
    const transactions = new TransactionRunner(dataSource);
    financial = new FinancialService(transactions);
    debts = new DebtService(transactions, financial);
    const capture = new CaptureService(
      dataSource,
      transactions,
      financial,
      interpreter,
      new InferenceBudgetService(transactions, LIMITS),
      new DebtService(transactions, financial),
      followUp,
    );
    const commands = new TelegramCommands(
      capture,
      financial,
      new AccountService(dataSource, transactions),
      new InferenceBudgetService(transactions, LIMITS),
      LIMITS,
      new BudgetService(transactions, financial),
      new SavingsService(transactions, financial, new GoalService(transactions)),
      new DebtService(transactions, financial),
    );
    telegram = new TelegramService(dataSource, transactions, commands, capture, client, SETTINGS);
  }

  function update(updateId: number, text: string): TelegramUpdate {
    const message: TelegramMessage = {
      chatId: String(CHAT_ID),
      chatType: 'private',
      userId: String(USER_ID),
      isBot: false,
      text,
      receivedAt: now(),
    };
    return { updateId, message };
  }

  function enqueue(updateId: number, text: string): void {
    client.enqueue(update(updateId, text));
  }

  /** Espera a que se entregue la respuesta numero `count` y la devuelve. */
  async function delivered(count: number): Promise<string> {
    await waitUntil(() => client.sent.length >= count, 20_000);
    return client.lastSent?.text ?? '';
  }

  /** Luis debe 10.00 USD y Carmen debe 4.00 USD. Devuelve el id de la deuda de Luis. */
  async function seedDebts(): Promise<string> {
    const luis = await debts.create({
      sourceKey: 'deuda-luis',
      direction: 'payable',
      counterparty: 'Luis',
      money: { currency: 'USD', minor: 1000n },
      occurredOn: '2026-11-10',
    });
    await debts.create({
      sourceKey: 'deuda-carmen',
      direction: 'payable',
      counterparty: 'Carmen',
      money: { currency: 'USD', minor: 400n },
      occurredOn: '2026-11-10',
    });
    return luis.debt.id;
  }

  it('responde la pregunta contextual con la deuda actual y solo con los turnos anteriores', async () => {
    const luisId = await seedDebts();

    interpreter.responses.push(debtQueryOperation('Luis'));
    // La segunda pregunta es contextual: la resuelve la llamada de seguimiento.
    interpreter.responses.push(followUpOperation());
    // La tercera sustituye la persona: conserva el tipo de pregunta del intercambio.
    interpreter.responses.push(followUpOperation());
    followUp.responses.push({
      kind: 'debt_query',
      direction: 'payable',
      counterparty: 'Luis',
      currency: 'USD',
      status: null,
      queryDetail: true,
    });
    followUp.responses.push({
      kind: 'debt_query',
      direction: 'payable',
      counterparty: 'Carmen',
      currency: 'USD',
      status: null,
      queryDetail: true,
    });

    await telegram.start();

    // 1. Una pregunta completa: la responde el camino normal.
    enqueue(1, '¿qué le debo a Luis?');
    const first = await delivered(1);
    expect(first).toContain('Luis');
    expect(first).toContain('$10');

    // 2. Fuera del chat se le pagan 3.00 a Luis: el pendiente ahora es 7.00, pero el
    // chat sigue diciendo 10.
    await debts.settle({
      sourceKey: 'pago-luis',
      debtId: luisId,
      accountId,
      money: { currency: 'USD', minor: 300n },
      occurredOn: '2026-11-12',
      expectedOutstandingMinor: 1000n,
    });

    // 3. La pregunta de seguimiento: depende del turno anterior.
    enqueue(2, '¿y cuánto le debía inicialmente?');
    const second = await delivered(2);
    expect(second).toContain('Luis');
    expect(second).toContain('Monto inicial: $10');
    expect(second).toContain('Le he pagado: $3');
    // El pendiente sale de la base de datos, no del chat.
    expect(second).toContain('Me falta por pagar: $7');
    expect(second).not.toContain('$10 pendiente');

    // 4. La persona se sustituye y el tipo de pregunta se conserva: el detalle de
    // Carmen, sin Luis.
    enqueue(3, '¿y Carmen?');
    const third = await delivered(3);
    expect(third).toContain('Carmen');
    expect(third).toContain('Monto inicial: $4');
    expect(third).toContain('Me falta por pagar: $4');
    expect(third).not.toContain('Luis');

    // La ventana que llego a la consulta de seguimiento: solo turnos anteriores.
    expect(followUp.requests).toHaveLength(2);
    const firstWindow = followUp.requests[0]!;
    expect(firstWindow.text).toBe('¿y cuánto le debía inicialmente?');
    expect(firstWindow.history).toEqual([
      { role: 'user', text: '¿qué le debo a Luis?' },
      { role: 'bot', text: first },
    ]);
    // El mensaje actual no se repite dentro de la ventana.
    expect(firstWindow.history.some((turn) => turn.text === '¿y cuánto le debía inicialmente?')).toBe(
      false,
    );

    const secondWindow = followUp.requests[1]!;
    expect(secondWindow.text).toBe('¿y Carmen?');
    expect(secondWindow.history.map((turn) => [turn.role, turn.text])).toEqual([
      ['user', '¿qué le debo a Luis?'],
      ['bot', first],
      ['user', '¿y cuánto le debía inicialmente?'],
      ['bot', second],
    ]);

    // Todo fue lectura: no hay movimientos nuevos ni borrador vivo.
    expect(await dataSource.getRepository(Movement).count()).toBe(1); // Solo el pago.
    expect(await dataSource.getRepository(Capture).count()).toBe(0);
  }, 60_000);

  it('un refinamiento del listado se resuelve con la ventana y responde solo un lado', async () => {
    // Datos ficticios: Rita y Nico son lo que debo, Sonia lo que me deben y Beto ya
    // esta saldada (no es pendiente).
    await debts.create({
      sourceKey: 'deuda-rita',
      direction: 'payable',
      counterparty: 'Rita',
      money: { currency: 'USD', minor: 1200n },
      occurredOn: '2026-11-08',
    });
    await debts.create({
      sourceKey: 'deuda-nico',
      direction: 'payable',
      counterparty: 'Nico',
      money: { currency: 'USD', minor: 500n },
      occurredOn: '2026-11-09',
    });
    await debts.create({
      sourceKey: 'deuda-sonia',
      direction: 'receivable',
      counterparty: 'Sonia',
      money: { currency: 'USD', minor: 800n },
      occurredOn: '2026-11-10',
    });
    const beto = (
      await debts.create({
        sourceKey: 'deuda-beto',
        direction: 'payable',
        counterparty: 'Beto',
        money: { currency: 'USD', minor: 300n },
        occurredOn: '2026-11-07',
      })
    ).debt;
    await debts.settle({
      sourceKey: 'pago-beto',
      debtId: beto.id,
      accountId,
      money: { currency: 'USD', minor: 300n },
      occurredOn: '2026-11-10',
      expectedOutstandingMinor: 300n,
    });

    // 1. La consulta general: la resuelve el modelo normal.
    interpreter.responses.push(generalQueryOperation());
    // 2. y 3. Los refinamientos: van a la via contextual, con la ventana.
    interpreter.responses.push(followUpOperation());
    interpreter.responses.push(followUpOperation());
    followUp.responses.push(groupAnswer('payable'));
    followUp.responses.push(groupAnswer('receivable'));

    await telegram.start();

    enqueue(1, 'cuáles son mis deudas?');
    const first = await delivered(1);
    expect(first).toContain('Lo que debo');
    expect(first).toContain('Lo que me deben');
    expect(first).toContain('Rita');
    expect(first).toContain('Nico');
    expect(first).toContain('Sonia');

    const movementsBefore = await dataSource.getRepository(Movement).count();

    // El refinamiento: una frase fragmentaria, sin signos de interrogacion.
    enqueue(2, 'Lo que debo nada más');
    const second = await delivered(2);
    expect(second).toContain('Lo que debo');
    expect(second).toContain('Rita');
    expect(second).toContain('Nico');
    expect(second).toContain('$12');
    expect(second).toContain('$5');
    // Solo el lado pedido: no hay seccion de cobros.
    expect(second).not.toContain('Lo que me deben');
    expect(second).not.toContain('Sonia');
    // La saldada no se lista: el grupo son las pendientes.
    expect(second).not.toContain('Beto');
    // Y no aparecen importes de otras unidades.
    expect(second).not.toContain('$7');

    // El refinamiento en sentido contrario, con otras palabras.
    enqueue(3, 'de esas, solo las que tengo por cobrar');
    const third = await delivered(3);
    expect(third).toContain('Lo que me deben');
    expect(third).toContain('Sonia');
    expect(third).toContain('$8');
    expect(third).not.toContain('Lo que debo');
    expect(third).not.toContain('Rita');
    expect(third).not.toContain('Nico');

    // La ventana que llega al modelo contextual: los turnos anteriores.
    expect(followUp.requests).toHaveLength(2);
    const window = followUp.requests[0]!.history;
    expect(window.map((turn) => turn.text)).toContain('cuáles son mis deudas?');
    expect(window.map((turn) => turn.text)).toContain(first);
    expect(followUp.requests[0]!.text).toBe('Lo que debo nada más');
    // El mensaje actual no se repite dentro de la ventana.
    expect(window.some((turn) => turn.text === 'Lo que debo nada más')).toBe(false);

    // Todo fue lectura: sin movimientos nuevos y sin borrador vivo.
    expect(await dataSource.getRepository(Movement).count()).toBe(movementsBefore);
    expect(await dataSource.getRepository(Capture).count()).toBe(0);
  }, 60_000);

  it('una pregunta sin un intercambio con foco claro pide la persona y no lista ni selecciona', async () => {
    await seedDebts();

    // La primera pregunta no tiene foco: son todas las deudas.
    interpreter.responses.push(debtQueryOperation(null));
    // La segunda es un pronombre sin referente claro: se pide la persona.
    interpreter.responses.push(followUpOperation());
    followUp.responses.push({
      kind: 'clarify',
      direction: null,
      counterparty: null,
      currency: null,
      status: null,
      queryDetail: null,
    });

    await telegram.start();

    enqueue(1, '¿cuáles son mis deudas?');
    const first = await delivered(1);
    expect(first).toContain('Lo que debo');
    expect(first).toContain('Luis');
    expect(first).toContain('Carmen');

    enqueue(2, '¿y cuánto le debo?');
    const second = await delivered(2);

    // No se sabe de quien es: se pregunta, sin listar y sin seleccionar a nadie.
    expect(second).toContain('No se sabe de quien es esa pregunta');
    expect(second).not.toContain('Lo que debo');
    expect(second).not.toContain('Carmen');
    expect(second).not.toContain('$7');
    expect(second).not.toContain('$4');

    // La ventana que recibe la consulta es la del intercambio sin foco.
    expect(followUp.requests).toHaveLength(1);
    expect(followUp.requests[0]?.history).toEqual([
      { role: 'user', text: '¿cuáles son mis deudas?' },
      { role: 'bot', text: first },
    ]);

    // Sigue siendo una lectura: nada registrado y ningun borrador.
    expect(await dataSource.getRepository(Movement).count()).toBe(0);
    expect(await dataSource.getRepository(Capture).count()).toBe(0);
  }, 60_000);
});
