import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { AccountService } from '../../src/accounts/account.service';
import { CaptureService } from '../../src/capture/capture.service';
import { InferenceBudgetService } from '../../src/capture/inference-budget.service';
import { TelegramSettings } from '../../src/config/configuration';
import { backupDatabase, restoreDatabase } from '../../src/data/backup';
import { buildDataSourceOptions } from '../../src/data/data-source';
import { TransactionRunner } from '../../src/data/transaction.runner';
import { FinancialService } from '../../src/financial/financial.service';
import { Movement } from '../../src/financial/movement.entity';
import { TelegramCommands } from '../../src/telegram/telegram-commands';
import { TelegramInbox } from '../../src/telegram/telegram-inbox.entity';
import { TelegramOutbox } from '../../src/telegram/telegram-outbox.entity';
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

/**
 * Suite de extremo a extremo del bot: un Telegram simulado y un interpretador
 * simulado. No hace ninguna llamada externa ni usa credenciales reales.
 */
describe('Flujo completo del bot de Telegram', () => {
  let directory: string;
  let databasePath: string;
  let dataSource: DataSource;
  let client: FakeTelegramClient;
  let interpreter: FakeInterpreter;
  let telegram: TelegramService;
  let financial: FinancialService;
  let accountId: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'locha-e2e-'));
    databasePath = join(directory, 'locha.sqlite');
    dataSource = await open(databasePath);
    const accounts = new AccountService(dataSource, new TransactionRunner(dataSource));
    const account = await accounts.add({ name: 'Efectivo', currency: 'USD' });
    accountId = account.id;
    client = new FakeTelegramClient();
    interpreter = new FakeInterpreter([]);
    financial = new FinancialService(new TransactionRunner(dataSource));
    telegram = buildService(dataSource, client, interpreter);
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
      new InferenceBudgetService(source, transactions, LIMITS),
    );
    const commands = new TelegramCommands(
      capture,
      financialService,
      new AccountService(source, transactions),
    );
    return new TelegramService(source, transactions, commands, telegramClient, SETTINGS);
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

  it('registra una operacion, la confirma y responde con el resumen del mes', async () => {
    interpreter.responses.push({
      amount: '2.00',
      currency: 'USD',
      accountId,
      kind: 'expense',
      occurredOn: '2026-11-10',
      description: 'Helado',
    });

    await telegram.start();

    client.enqueue(update(1, 'Helado 2 dolares'));
    await waitUntil(() => client.sent.length === 1);
    expect(client.lastSent?.text).toContain('2.00 USD');
    expect(client.lastSent?.text).toContain('/confirm');

    client.enqueue(update(2, '/confirm'));
    await waitUntil(() => client.sent.length === 2);
    expect(client.lastSent?.text).toContain('Registrado');
    expect(client.lastSent?.text).toContain('Movimiento: ');

    const movements = await dataSource.getRepository(Movement).find();
    expect(movements).toHaveLength(1);
    expect(movements[0]?.amountMinor).toBe(200n);
    expect(movements[0]?.sourceKey).toMatch(/^capture:/);

    client.enqueue(update(3, '/summary 2026-11'));
    await waitUntil(() => client.sent.length === 3);
    expect(client.lastSent?.text).toContain('gastos 2.00');
    expect(client.lastSent?.text).toContain('no son el saldo');
  });

  it('no duplica el movimiento cuando Telegram repite la actualizacion', async () => {
    interpreter.responses.push(
      {
        amount: '2.00',
        currency: 'USD',
        accountId,
        kind: 'expense',
        occurredOn: '2026-11-10',
        description: 'Helado',
      },
      {
        amount: '2.00',
        currency: 'USD',
        accountId,
        kind: 'expense',
        occurredOn: '2026-11-10',
        description: 'Helado',
      },
    );

    await telegram.start();

    client.enqueue(update(10, 'Helado 2 dolares'));
    client.enqueue(update(10, 'Helado 2 dolares'));
    await waitUntil(() => client.sent.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(client.sent).toHaveLength(1);
    expect(interpreter.requests).toHaveLength(1);
    expect(await dataSource.getRepository(Movement).count()).toBe(0);
  });

  it('no guarda nada de un usuario que no esta autorizado', async () => {
    await telegram.start();

    client.enqueue(update(20, 'Helado 2 dolares', { userId: '999' }));
    client.enqueue(update(21, 'Helado 2 dolares', { chatType: 'group' }));
    await waitUntil(() => client.offsets.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await dataSource.getRepository(TelegramInbox).count()).toBe(0);
    expect(await dataSource.getRepository(TelegramOutbox).count()).toBe(0);
    expect(await dataSource.getRepository(Movement).count()).toBe(0);
    expect(client.sent).toHaveLength(0);
    expect(interpreter.requests).toHaveLength(0);
  });

  it('descarta lo pendiente de un chat que ya no esta autorizado', async () => {
    // Trabajo pendiente de antes de cambiar la lista de autorizados.
    const inbox = dataSource.getRepository(TelegramInbox);
    await inbox.save(
      inbox.create({
        updateId: 25,
        chatId: '999',
        userId: '999',
        text: 'Helado 2 dolares',
        receivedAt: RECEIVED_AT,
        state: 'accepted',
      }),
    );
    const outbox = dataSource.getRepository(TelegramOutbox);
    await outbox.save(
      outbox.create({
        updateId: 26,
        chatId: '999',
        userId: '999',
        text: 'Respuesta de antes',
        state: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
      }),
    );

    await telegram.start();
    await waitUntil(() => client.offsets.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const storedInbox = await inbox.findOneBy({ updateId: 25 });
    expect(storedInbox?.state).toBe('discarded');
    expect(storedInbox?.text).toBeNull();

    const storedOutbox = await outbox.findOneBy({ updateId: 26 });
    expect(storedOutbox?.state).toBe('discarded');
    // Ni una llamada al modelo ni una respuesta.
    expect(interpreter.requests).toHaveLength(0);
    expect(client.sent).toHaveLength(0);
  });

  it('retoma el trabajo pendiente despues de un reinicio', async () => {
    interpreter.responses.push({
      amount: '2.00',
      currency: 'USD',
      accountId,
      kind: 'expense',
      occurredOn: '2026-11-10',
      description: 'Helado',
    });

    // Se acepta la actualizacion pero no se procesa: el proceso se interrumpe.
    const inbox = dataSource.getRepository(TelegramInbox);
    await inbox.save(
      inbox.create({
        updateId: 30,
        chatId: String(CHAT_ID),
        userId: String(USER_ID),
        text: 'Helado 2 dolares',
        receivedAt: RECEIVED_AT,
        state: 'accepted',
      }),
    );

    await telegram.start();

    await waitUntil(() => client.sent.length === 1);
    expect(interpreter.requests).toHaveLength(1);
    expect(client.lastSent?.text).toContain('/confirm');
  });

  it('reintenta la entrega cuando el envio falla', async () => {
    client.pendingSendFailures = 2;
    client.enqueue(update(40, '/help'));

    await telegram.start();

    await waitUntil(() => client.sent.length === 1, 20_000);
    expect(client.sent).toHaveLength(1);
    const outbox = await dataSource.getRepository(TelegramOutbox).findOneBy({ updateId: 40 });
    expect(outbox?.state).toBe('sent');
    expect(outbox?.attempts).toBe(2);
  });

  it('conserva los datos, copia la base y la restaura con los mismos totales', async () => {
    interpreter.responses.push({
      amount: '2.00',
      currency: 'USD',
      accountId,
      kind: 'expense',
      occurredOn: '2026-11-10',
      description: 'Helado',
    });

    await telegram.start();
    client.enqueue(update(50, 'Helado 2 dolares'));
    await waitUntil(() => client.sent.length === 1);
    client.enqueue(update(51, '/confirm'));
    await waitUntil(() => client.sent.length === 2);

    const original = await financial.summary();
    await telegram.stop();
    await dataSource.destroy();

    const backupPath = join(directory, 'copia.sqlite');
    await backupDatabase(databasePath, backupPath);
    const restoredPath = join(directory, 'restaurada.sqlite');
    await restoreDatabase(backupPath, restoredPath);

    const restored = await open(restoredPath);
    const restoredFinancial = new FinancialService(new TransactionRunner(restored));
    const copia = await restoredFinancial.summary();

    expect(copia).toEqual(original);
    expect(await restored.getRepository(Movement).count()).toBe(1);
    await restored.destroy();
  });
});
