import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { Account } from '../../src/accounts/account.entity';
import { AccountService } from '../../src/accounts/account.service';
import { BudgetService } from '../../src/budgets/budget.service';
import { Capture } from '../../src/capture/capture.entity';
import { CaptureService } from '../../src/capture/capture.service';
import { InferenceBudgetService } from '../../src/capture/inference-budget.service';
import { TelegramSettings } from '../../src/config/configuration';
import { backupDatabase, restoreDatabase } from '../../src/data/backup';
import { buildDataSourceOptions } from '../../src/data/data-source';
import { TransactionRunner } from '../../src/data/transaction.runner';
import { Debt } from '../../src/debts/debt.entity';
import { DebtPayment } from '../../src/debts/debt-payment.entity';
import { DebtService } from '../../src/debts/debt.service';
import { ConflictError } from '../../src/domain/errors';
import { FinancialService } from '../../src/financial/financial.service';
import { Movement } from '../../src/financial/movement.entity';
import { GoalService } from '../../src/savings/goal.service';
import { SavingsService } from '../../src/savings/savings.service';
import { Operation } from '../../src/interpreter/operation.schema';
import { TelegramCommands } from '../../src/telegram/telegram-commands';
import { TelegramService } from '../../src/telegram/telegram.service';
import { TelegramMessage, TelegramUpdate } from '../../src/telegram/telegram-update';
import { FakeInterpreter } from '../helpers/fake-interpreter';
import { FakeTelegramClient, waitUntil } from '../helpers/fake-telegram';

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
    ...overrides,
  };
}

/**
 * Suite de extremo a extremo de las deudas: un Telegram simulado y un interpretador
 * simulado sobre una base temporal real. No hace ninguna llamada externa.
 */
describe('Flujo completo de deudas', () => {
  let directory: string;
  let databasePath: string;
  let dataSource: DataSource;
  let client: FakeTelegramClient;
  let interpreter: FakeInterpreter;
  let telegram: TelegramService;
  let financial: FinancialService;
  let debts: DebtService;
  let accountId: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'locha-debt-e2e-'));
    databasePath = join(directory, 'locha.sqlite');
    dataSource = await open(databasePath);
    const accounts = new AccountService(dataSource, new TransactionRunner(dataSource));
    accountId = (await accounts.add({ name: 'Efectivo USD', currency: 'USD' })).id;
    client = new FakeTelegramClient();
    interpreter = new FakeInterpreter([]);
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

  /** Servicios de la aplicacion sobre la conexion actual. */
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
    telegram = new TelegramService(dataSource, transactions, commands, client, SETTINGS);
  }

  function update(updateId: number, text: string): TelegramUpdate {
    const message: TelegramMessage = {
      chatId: String(CHAT_ID),
      chatType: 'private',
      userId: String(USER_ID),
      isBot: false,
      text,
      receivedAt: RECEIVED_AT,
    };
    return { updateId, message };
  }

  function enqueue(updateId: number, text: string): void {
    client.enqueue(update(updateId, text));
  }

  /** Espera a que se entregue la respuesta numero `count` y la devuelve. */
  async function delivered(count: number): Promise<string> {
    await waitUntil(() => client.sent.length >= count);
    return client.lastSent?.text ?? '';
  }

  /** Reinicio del proceso: misma base, conexiones y servicios nuevos. */
  async function restart(): Promise<void> {
    await telegram.stop();
    await dataSource.destroy();
    dataSource = await open(databasePath);
    build();
    await telegram.start();
  }

  it('crea una deuda a pagar por lenguaje natural: vista previa, confirmacion y ningun movimiento', async () => {
    interpreter.responses.push({
      amount: '8.00',
      currency: 'USD',
      accountId: null,
      kind: 'debt_create',
      occurredOn: '2026-11-10',
      description: 'dos tortas',
      debt: debtData({ direction: 'payable', counterparty: 'Carmen' }),
    });

    await telegram.start();
    enqueue(1, 'le debo 8$ a Carmen de dos tortas');
    const preview = await delivered(1);

    expect(preview).toContain('Entendi esta deuda:');
    expect(preview).toContain('lo que debo');
    expect(preview).toContain('Carmen');
    expect(preview).toContain('/confirm');
    // Todavia no hay nada escrito: la deuda solo existe en el borrador.
    expect(await dataSource.getRepository(Debt).count()).toBe(0);
    expect(await dataSource.getRepository(Movement).count()).toBe(0);

    enqueue(2, '/confirm');
    const confirmed = await delivered(2);

    expect(confirmed).toContain('Registrado');
    expect(confirmed).toContain('deuda de 8.00 USD con Carmen');
    // El bot no muestra identificadores: el id se comprueba en la base.
    expect(confirmed).not.toMatch(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i);
    expect(await dataSource.getRepository(Debt).count()).toBe(1);
    // Crear una deuda no mueve dinero.
    expect(await dataSource.getRepository(Movement).count()).toBe(0);
    expect((await financial.balances()).find((row) => row.accountId === accountId)?.balance).toBe(0n);
  }, 60_000);

  it('una consulta en lenguaje natural no toca el borrador pendiente', async () => {
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

    await telegram.start();
    enqueue(1, 'le debo 8$ a Carmen');
    await delivered(1);
    enqueue(2, '/confirm');
    await delivered(2);

    // Un borrador nuevo queda pendiente.
    enqueue(3, 'le debo 8$ a Carmen');
    await delivered(3);
    const pending = await dataSource.getRepository(Capture).findOneByOrFail({ chatId: String(CHAT_ID) });

    enqueue(4, 'cuáles son mis deudas');
    const query = await delivered(4);

    expect(query).toContain('Lo que debo');
    expect(query).toContain('Carmen');
    expect(await dataSource.getRepository(Capture).findOneByOrFail({ chatId: String(CHAT_ID) })).toEqual(pending);
    expect(await dataSource.getRepository(Debt).count()).toBe(1);
  }, 60_000);

  it('paga una parte: un gasto, la deuda queda a medias y el resumen lo muestra', async () => {
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
      amount: '3.00',
      currency: 'USD',
      accountId,
      kind: 'debt_settle',
      occurredOn: '2026-11-10',
      description: null,
      debt: debtData({ direction: 'payable', counterparty: 'Carmen', settlementMode: 'partial' }),
    });

    await telegram.start();
    enqueue(1, 'le debo 8$ a Carmen');
    await delivered(1);
    enqueue(2, '/confirm');
    await delivered(2);
    // El id de la deuda se saca de la base: el bot no lo muestra.
    const debtId = (await dataSource.getRepository(Debt).findOneByOrFail({ counterparty: 'Carmen' })).id;

    enqueue(3, 'le pagué 3 dólares a Carmen');
    const preview = await delivered(3);

    expect(preview).toContain('pago parcial');
    expect(preview).toContain('importe: 3.00 USD');
    expect(preview).toContain('pendiente: 8.00 USD');
    expect(preview).not.toContain(debtId);
    expect(await dataSource.getRepository(Movement).count()).toBe(0);

    enqueue(4, '/confirm');
    const confirmed = await delivered(4);

    expect(confirmed).toContain('Registrado: pago de 3.00 USD');
    expect(confirmed).not.toContain('Movimiento: ');
    expect(confirmed).not.toContain(debtId);
    const movements = await dataSource.getRepository(Movement).find();
    expect(movements).toHaveLength(1);
    expect(movements[0]?.kind).toBe('expense');
    expect(movements[0]?.amountMinor).toBe(300n);
    expect(await dataSource.getRepository(DebtPayment).count()).toBe(1);
    expect(await debts.get(debtId)).toMatchObject({ paidMinor: 300n, outstandingMinor: 500n, status: 'partial' });
    expect((await financial.summary()).find((row) => row.currency === 'USD')).toMatchObject({ income: 0n, expense: 300n });
  }, 60_000);

  it('la actualizacion repetida no vuelve a interpretar ni a duplicar el movimiento', async () => {
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
      amount: '3.00',
      currency: 'USD',
      accountId,
      kind: 'debt_settle',
      occurredOn: '2026-11-10',
      description: null,
      debt: debtData({ direction: 'payable', counterparty: 'Carmen', settlementMode: 'partial' }),
    });

    await telegram.start();
    enqueue(1, 'le debo 8$ a Carmen');
    await delivered(1);
    enqueue(2, '/confirm');
    await delivered(2);

    // La misma actualizacion, dos veces.
    enqueue(10, 'le pagué 3 dólares a Carmen');
    enqueue(10, 'le pagué 3 dólares a Carmen');
    await delivered(3);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(client.sent).toHaveLength(3);
    expect(interpreter.requests).toHaveLength(2);

    enqueue(11, '/confirm');
    await delivered(4);

    expect(await dataSource.getRepository(Movement).count()).toBe(1);
    expect(await dataSource.getRepository(DebtPayment).count()).toBe(1);
  }, 60_000);

  it('pago total: pide la cuenta, conserva la autorizacion tras reiniciar y congela el pendiente', async () => {
    interpreter.responses.push({
      amount: '8.00',
      currency: 'USD',
      accountId: null,
      kind: 'debt_create',
      occurredOn: '2026-11-10',
      description: null,
      debt: debtData({ direction: 'payable', counterparty: 'Carmen' }),
    });
    const fullPayment = {
      amount: null,
      currency: 'USD',
      accountId: null,
      kind: 'debt_settle' as const,
      occurredOn: '2026-11-10',
      description: null,
      debt: debtData({ direction: 'payable' as const, counterparty: 'Carmen', settlementMode: 'full' as const }),
    };
    interpreter.responses.push(fullPayment);
    interpreter.responses.push(fullPayment);

    await telegram.start();
    enqueue(1, 'le debo 8$ a Carmen');
    await delivered(1);
    enqueue(2, '/confirm');
    await delivered(2);
    const debtId = (await dataSource.getRepository(Debt).findOneByOrFail({ counterparty: 'Carmen' })).id;

    // El pago total sin cuenta: se pide la cuenta y no se paga nada.
    enqueue(3, 'ya le pagué todo a Carmen');
    const ask = await delivered(3);

    expect(ask).toContain('falta la cuenta');
    expect(ask).toContain('cuentas: Efectivo USD (USD)');
    expect(await dataSource.getRepository(Movement).count()).toBe(0);

    // La aclaracion con la cuenta conserva la autorizacion del pago total.
    enqueue(4, 'Efectivo USD');
    const preview = await delivered(4);

    expect(preview).toContain('pago total');
    expect(preview).toContain('importe: 8.00 USD');
    expect(preview).toContain('pendiente: 8.00 USD');
    expect(preview).toContain('cuenta: Efectivo USD (USD)');
    expect(preview).not.toContain(debtId);

    // El proceso se reinicia: el borrador vivo y su autorizacion siguen en la base.
    await restart();

    enqueue(5, '/confirm');
    const confirmed = await delivered(5);

    expect(confirmed).toContain('Registrado: pago de 8.00 USD');
    const movements = await dataSource.getRepository(Movement).find();
    expect(movements).toHaveLength(1);
    expect(movements[0]?.kind).toBe('expense');
    expect(movements[0]?.amountMinor).toBe(800n);
    expect(await debts.get(debtId)).toMatchObject({ paidMinor: 800n, outstandingMinor: 0n, status: 'paid' });
  }, 90_000);

  it('cobrar lo que me deben es un ingreso', async () => {
    interpreter.responses.push({
      amount: '8.00',
      currency: 'USD',
      accountId: null,
      kind: 'debt_create',
      occurredOn: '2026-11-10',
      description: null,
      debt: debtData({ direction: 'receivable', counterparty: 'Carmen' }),
    });
    interpreter.responses.push({
      amount: '8.00',
      currency: 'USD',
      accountId,
      kind: 'debt_settle',
      occurredOn: '2026-11-10',
      description: null,
      debt: debtData({ direction: 'receivable', counterparty: 'Carmen', settlementMode: 'partial' }),
    });

    await telegram.start();
    enqueue(1, 'Carmen me debe 8$');
    await delivered(1);
    enqueue(2, '/confirm');
    await delivered(2);
    const debtId = (await dataSource.getRepository(Debt).findOneByOrFail({ counterparty: 'Carmen' })).id;

    enqueue(3, 'Carmen me pagó 8 dólares');
    const preview = await delivered(3);
    expect(preview).toContain('lo que me deben');
    expect(preview).toContain('importe: 8.00 USD');

    enqueue(4, '/confirm');
    const confirmed = await delivered(4);

    expect(confirmed).toContain('Registrado: pago de 8.00 USD');
    const movements = await dataSource.getRepository(Movement).find();
    expect(movements).toHaveLength(1);
    expect(movements[0]?.kind).toBe('income');
    expect(movements[0]?.amountMinor).toBe(800n);
    expect(await debts.get(debtId)).toMatchObject({ paidMinor: 800n, outstandingMinor: 0n, status: 'paid' });
  }, 60_000);

  it('el resumen, el presupuesto y las reservas reflejan el pago', async () => {
    const transactions = new TransactionRunner(dataSource);
    const budgets = new BudgetService(transactions, financial);
    const goals = new GoalService(transactions);
    const savings = new SavingsService(transactions, financial, goals);
    await financial.open({
      sourceKey: 'apertura',
      accountId,
      money: { currency: 'USD', minor: 100n },
      occurredOn: '2026-01-01',
    });
    await budgets.create({
      sourceKey: 'presupuesto',
      name: 'Hogar',
      currency: 'USD',
      limitMinor: 500n,
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
    });
    const goal = (await goals.create({ sourceKey: 'meta', name: 'Fondo', currency: 'USD', targetMinor: 100n })).goal;
    await savings.reserve({ sourceKey: 'reserva', goalId: goal.id, accountId, currency: 'USD', amountMinor: 100n });

    interpreter.responses.push({
      amount: '3.00',
      currency: 'USD',
      accountId: null,
      kind: 'debt_create',
      occurredOn: '2026-11-10',
      description: null,
      debt: debtData({ direction: 'payable', counterparty: 'Carmen' }),
    });
    interpreter.responses.push({
      amount: '3.00',
      currency: 'USD',
      accountId,
      kind: 'debt_settle',
      occurredOn: '2026-11-10',
      description: null,
      debt: debtData({ direction: 'payable', counterparty: 'Carmen', settlementMode: 'partial' }),
    });

    await telegram.start();
    enqueue(1, 'le debo 3$ a Carmen');
    await delivered(1);
    enqueue(2, '/confirm');
    await delivered(2);
    enqueue(3, 'le pagué 3 dólares a Carmen');
    await delivered(3);
    enqueue(4, '/confirm');
    const confirmed = await delivered(4);

    // El pago es un gasto: el resumen lo muestra y las reservas quedan en deficit.
    expect(confirmed).toContain('ADVERTENCIA');
    expect(confirmed).toContain('deficit 3.00');
    expect((await financial.summary()).find((row) => row.currency === 'USD')).toMatchObject({ income: 0n, expense: 300n });
    expect((await budgets.status({ on: '2026-11-10' }))[0]).toMatchObject({ spent: 300n, remaining: 200n });
    expect((await savings.status())[0]).toMatchObject({ reserved: 100n, available: -300n, deficit: 300n });

    enqueue(5, '/summary 2026-11');
    const summary = await delivered(5);
    expect(summary).toContain('gastos 3.00');

    enqueue(6, '/budgets 2026-11-10');
    const budget = await delivered(6);
    expect(budget).toContain('gastado 3.00');

    enqueue(7, '/savings');
    const reserves = await delivered(7);
    expect(reserves).toContain('deficit 3.00');
  }, 90_000);

  it('el pendiente congelado caduca: si cambia por fuera, la confirmacion se rechaza sin escribir', async () => {
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
      amount: '3.00',
      currency: 'USD',
      accountId,
      kind: 'debt_settle',
      occurredOn: '2026-11-10',
      description: null,
      debt: debtData({ direction: 'payable', counterparty: 'Carmen', settlementMode: 'partial' }),
    });

    await telegram.start();
    enqueue(1, 'le debo 8$ a Carmen');
    await delivered(1);
    enqueue(2, '/confirm');
    await delivered(2);
    const debtId = (await dataSource.getRepository(Debt).findOneByOrFail({ counterparty: 'Carmen' })).id;

    enqueue(3, 'le pagué 3 dólares a Carmen');
    await delivered(3);

    // Otro pago, fuera del bot, cambia el pendiente que estaba congelado.
    await debts.settle({
      sourceKey: 'pago-fuera',
      debtId,
      accountId,
      money: { currency: 'USD', minor: 100n },
      occurredOn: '2026-11-10',
      expectedOutstandingMinor: 800n,
    });

    enqueue(4, '/confirm');
    const rejected = await delivered(4);

    expect(rejected).toContain('No se pudo registrar la operacion');
    expect(rejected).toContain('el pendiente de la deuda cambio');
    expect(await dataSource.getRepository(Movement).count()).toBe(1);

    // El pago se vuelve a preparar con el pendiente nuevo.
    interpreter.responses.push({
      amount: '3.00',
      currency: 'USD',
      accountId,
      kind: 'debt_settle',
      occurredOn: '2026-11-10',
      description: null,
      debt: debtData({ direction: 'payable', counterparty: 'Carmen', settlementMode: 'partial' }),
    });
    enqueue(5, 'le pagué 3 dólares a Carmen');
    const preview = await delivered(5);
    expect(preview).toContain('pendiente: 7.00 USD');

    enqueue(6, '/confirm');
    const confirmed = await delivered(6);
    expect(confirmed).toContain('Registrado: pago de 3.00 USD');
    expect(await dataSource.getRepository(Movement).count()).toBe(2);
    expect(await debts.get(debtId)).toMatchObject({ paidMinor: 400n, outstandingMinor: 400n, status: 'partial' });
  }, 90_000);

  it('el movimiento de un pago no se edita; anularlo reabre la deuda y el replay no duplica', async () => {
    const debt = (
      await debts.create({
        sourceKey: 'deuda',
        direction: 'payable',
        counterparty: 'Carmen',
        money: { currency: 'USD', minor: 800n },
        occurredOn: '2026-11-01',
      })
    ).debt;
    const input = {
      sourceKey: 'pago',
      debtId: debt.id,
      accountId,
      money: { currency: 'USD' as const, minor: 300n },
      occurredOn: '2026-11-05',
      expectedOutstandingMinor: 800n,
    };
    const payment = await debts.settle(input);

    await expect(
      financial.editMovement({
        sourceKey: 'editar',
        movementId: payment.movement.id,
        expectedRevision: 0,
        amountMinor: 500n,
        occurredOn: '2026-11-05',
        reason: 'Importe',
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    await financial.voidMovement({
      sourceKey: 'anular',
      movementId: payment.movement.id,
      expectedRevision: 0,
      reason: 'Pago incorrecto',
    });
    const reopened = await debts.get(debt.id);
    expect(reopened).toMatchObject({ paidMinor: 0n, outstandingMinor: 800n, status: 'open' });
    expect(reopened.payments[0]).toMatchObject({ voided: true });

    // El replay de la clave devuelve el pago anulado y no crea un sustituto.
    const replay = await debts.settle(input);
    expect(replay.created).toBe(false);
    expect(replay.payment.id).toBe(payment.payment.id);
    expect(await dataSource.getRepository(Movement).count()).toBe(1);

    // Un pago nuevo con otra clave si se registra.
    const again = await debts.settle({ ...input, sourceKey: 'pago-nuevo' });
    expect(again.created).toBe(true);
    expect(await dataSource.getRepository(Movement).count()).toBe(2);
    expect(await debts.get(debt.id)).toMatchObject({ paidMinor: 300n, outstandingMinor: 500n, status: 'partial' });
  }, 60_000);

  it('la copia de seguridad y la restauracion conservan deudas, historial y cuentas', async () => {
    const debt = (
      await debts.create({
        sourceKey: 'deuda',
        direction: 'receivable',
        counterparty: 'Vecino',
        money: { currency: 'USD', minor: 800n },
        occurredOn: '2026-11-01',
      })
    ).debt;
    const payment = await debts.settle({
      sourceKey: 'cobro',
      debtId: debt.id,
      accountId,
      money: { currency: 'USD', minor: 800n },
      occurredOn: '2026-11-05',
      expectedOutstandingMinor: 800n,
    });

    await telegram.stop();
    await dataSource.destroy();

    const backupPath = join(directory, 'copia.sqlite');
    await backupDatabase(databasePath, backupPath);
    const restoredPath = join(directory, 'restaurada.sqlite');
    await restoreDatabase(backupPath, restoredPath);

    const restored = await open(restoredPath);
    const restoredDebts = new DebtService(
      new TransactionRunner(restored),
      new FinancialService(new TransactionRunner(restored)),
    );
    const view = await restoredDebts.get(debt.id);

    expect(view.debt.sourceKey).toBe('deuda');
    expect(view.paidMinor).toBe(800n);
    expect(view.status).toBe('paid');
    expect(view.payments[0]?.payment.id).toBe(payment.payment.id);
    expect(view.payments[0]?.movement.id).toBe(payment.movement.id);
    expect(view.payments[0]?.movement.accountId).toBe(accountId);
    expect(await restored.getRepository(Account).count()).toBe(1);
    expect(await restored.getRepository(Movement).count()).toBe(1);
    await restored.destroy();
  }, 60_000);
});
