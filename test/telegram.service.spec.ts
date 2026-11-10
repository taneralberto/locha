import { DataSource } from 'typeorm';
import { Account } from '../src/accounts/account.entity';
import { AccountService } from '../src/accounts/account.service';
import { CaptureService } from '../src/capture/capture.service';
import { InferenceBudgetService } from '../src/capture/inference-budget.service';
import { TelegramSettings } from '../src/config/configuration';
import { TransactionRunner } from '../src/data/transaction.runner';
import { FinancialService } from '../src/financial/financial.service';
import { Movement } from '../src/financial/movement.entity';
import { TelegramCommands } from '../src/telegram/telegram-commands';
import { POLLING_CURSOR_ID, TelegramCursor } from '../src/telegram/telegram-cursor.entity';
import { TelegramInbox } from '../src/telegram/telegram-inbox.entity';
import { TelegramOutbox } from '../src/telegram/telegram-outbox.entity';
import { TelegramService } from '../src/telegram/telegram.service';
import { TelegramMessage, TelegramUpdate } from '../src/telegram/telegram-update';
import { FakeInterpreter } from './helpers/fake-interpreter';
import { FakeTelegramClient, waitUntil } from './helpers/fake-telegram';
import { createTempDatabase, TempDatabase } from './helpers/temp-database';

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

/** Actualizacion con mensaje de texto del usuario autorizado. */
function messageUpdate(updateId: number, message: Partial<TelegramMessage> = {}): TelegramUpdate {
  return {
    updateId,
    message: {
      chatId: String(CHAT_ID),
      chatType: 'private',
      userId: String(USER_ID),
      isBot: false,
      text: 'Helado 2 dolares',
      receivedAt: RECEIVED_AT,
      ...message,
    },
  };
}

/** Actualizacion que no es un mensaje (editada, de canal, ...). */
function rawUpdate(updateId: number): TelegramUpdate {
  return { updateId, message: null };
}

function operation(accountId: string) {
  return {
    amount: '2.00',
    currency: 'USD',
    accountId,
    kind: 'expense' as const,
    occurredOn: '2026-11-10',
    description: 'Helado',
  };
}

describe('TelegramService', () => {
  let database: TempDatabase;
  let account: Account;
  let client: FakeTelegramClient;
  let telegram: TelegramService;

  beforeEach(async () => {
    database = await createTempDatabase();
    const accounts = new AccountService(database.dataSource, database.transactions);
    account = await accounts.add({ name: 'Efectivo', currency: 'USD' });
    client = new FakeTelegramClient();
    telegram = buildService(database, client, new FakeInterpreter([]));
  });

  afterEach(async () => {
    await telegram.stop();
    await database.cleanup();
  });

  function buildCommands(
    target: TempDatabase,
    interpreter: FakeInterpreter,
  ): TelegramCommands {
    const transactions = new TransactionRunner(target.dataSource);
    const financial = new FinancialService(transactions);
    const capture = new CaptureService(
      target.dataSource,
      transactions,
      financial,
      interpreter,
      new InferenceBudgetService(target.dataSource, transactions, LIMITS),
    );
    return new TelegramCommands(
      capture,
      financial,
      new AccountService(target.dataSource, transactions),
    );
  }

  function buildService(
    target: TempDatabase,
    telegramClient: FakeTelegramClient,
    interpreter: FakeInterpreter,
    settings: TelegramSettings = SETTINGS,
  ): TelegramService {
    const transactions = new TransactionRunner(target.dataSource);
    return new TelegramService(
      target.dataSource,
      transactions,
      buildCommands(target, interpreter),
      telegramClient,
      settings,
    );
  }

  it('ignora lo que no viene del chat privado y del usuario autorizados', async () => {
    client.enqueue(messageUpdate(1, { chatType: 'group' }));
    client.enqueue(messageUpdate(2, { userId: '999' }));
    client.enqueue(rawUpdate(3));
    client.enqueue(messageUpdate(4, { text: null }));
    client.enqueue(messageUpdate(5, { isBot: true }));

    await telegram.start();
    await waitUntil(() => client.offsets.length >= 2);

    expect(await database.dataSource.getRepository(TelegramInbox).count()).toBe(0);
    expect(await database.dataSource.getRepository(TelegramOutbox).count()).toBe(0);
    expect(client.sent).toHaveLength(0);

    // El cursor avanza igualmente: las actualizaciones ignoradas no se vuelven a pedir.
    const cursor = await database.dataSource.getRepository(TelegramCursor).findOneBy({
      id: POLLING_CURSOR_ID,
    });
    expect(cursor?.lastUpdateId).toBe(5);
  });

  it('responde al mensaje autorizado y guarda la bandeja de entrada y de salida', async () => {
    const interpreter = new FakeInterpreter([operation(account.id)]);
    telegram = buildService(database, client, interpreter);

    client.enqueue(messageUpdate(10));
    await telegram.start();

    await waitUntil(() => client.sent.length === 1);
    expect(client.lastSent?.text).toContain('2.00 USD');
    expect(client.lastSent?.chatId).toBe(String(CHAT_ID));

    const inbox = await database.dataSource.getRepository(TelegramInbox).findOneBy({
      updateId: 10,
    });
    expect(inbox?.state).toBe('done');
    expect(inbox?.text).toBeNull();
    expect(inbox?.userId).toBe(String(USER_ID));

    const outbox = await database.dataSource.getRepository(TelegramOutbox).findOneBy({
      updateId: 10,
    });
    expect(outbox?.state).toBe('sent');
  });

  it('no procesa dos veces la misma actualizacion', async () => {
    const interpreter = new FakeInterpreter([operation(account.id), operation(account.id)]);
    telegram = buildService(database, client, interpreter);

    client.enqueue(messageUpdate(20));
    client.enqueue(messageUpdate(20));
    await telegram.start();

    await waitUntil(() => client.sent.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(client.sent).toHaveLength(1);
    expect(interpreter.requests).toHaveLength(1);
    expect(await database.dataSource.getRepository(Movement).count()).toBe(0);
  });

  it('reintenta el envio cuando falla y entrega la respuesta una sola vez', async () => {
    client.pendingSendFailures = 2;
    client.enqueue(messageUpdate(30, { text: '/help' }));

    await telegram.start();

    await waitUntil(() => client.sent.length === 1, 20_000);
    expect(client.lastSent?.text).toContain('/summary');

    const outbox = await database.dataSource.getRepository(TelegramOutbox).findOneBy({
      updateId: 30,
    });
    expect(outbox?.state).toBe('sent');
    expect(outbox?.attempts).toBe(2);
  });

  it('respeta el retraso entre reintentos: no insiste de inmediato', async () => {
    client.pendingSendFailures = 50;
    client.enqueue(messageUpdate(31, { text: '/help' }));

    await telegram.start();
    await waitUntil(() => client.sendAttempts.length >= 3, 20_000);

    const attempts = client.sendAttempts;
    const gaps = attempts.slice(1).map((value, index) => value - (attempts[index] ?? value));
    // El retraso minimo es de un segundo: no puede haber diez intentos seguidos.
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(900);
  });

  it('no pierde la respuesta despues de muchos fallos', async () => {
    client.pendingSendFailures = 12;
    client.enqueue(messageUpdate(32, { text: '/help' }));

    await telegram.start();
    const outbox = database.dataSource.getRepository(TelegramOutbox);
    let attempts = 0;
    while (attempts < 12) {
      await waitUntil(() => client.sendAttempts.length > attempts, 20_000);
      attempts = client.sendAttempts.length;
      // Se adelanta el reloj para probar muchos intentos sin esperar minutos.
      await outbox.update({ updateId: 32 }, { nextAttemptAt: 0 });
    }

    await waitUntil(() => client.sent.length === 1, 20_000);
    expect(client.sendAttempts.length).toBeGreaterThan(10);
    const stored = await outbox.findOneBy({ updateId: 32 });
    expect(stored?.state).toBe('sent');
  });

  it('el retraso de reintento sobrevive a un reinicio', async () => {
    client.pendingSendFailures = 1;
    client.enqueue(messageUpdate(33, { text: '/help' }));

    await telegram.start();
    await waitUntil(() => client.sendAttempts.length >= 1, 20_000);
    await telegram.stop();

    const outbox = database.dataSource.getRepository(TelegramOutbox);
    const stored = await outbox.findOneBy({ updateId: 33 });
    expect(stored?.state).toBe('pending');

    // Se retrasa el reintento mas alla de lo que dura la prueba.
    await outbox.update({ updateId: 33 }, { nextAttemptAt: Date.now() + 30_000 });

    const restarted = buildService(database, client, new FakeInterpreter([]));
    await restarted.start();
    await waitUntil(() => client.offsets.length >= 2, 20_000);

    // El proceso nuevo respeta el retraso guardado: no manda nada.
    expect(client.sendAttempts).toHaveLength(1);
    expect((await outbox.findOneBy({ updateId: 33 }))?.state).toBe('pending');
    await restarted.stop();
  });

  it('el apagado cancela el envio en vuelo y espera a que termine', async () => {
    client.hangOnSend = true;
    client.enqueue(messageUpdate(34, { text: '/help' }));

    await telegram.start();
    await waitUntil(() => client.sendAttempts.length === 1, 20_000);

    await telegram.stop();

    expect(client.sendAborted).toBe(true);
  });

  it('un fallo al guardar una actualizacion corta el lote y no deja pasar el cursor', async () => {
    const failing = new Proxy(database.dataSource, {
      get(target, property) {
        if (property === 'transaction') {
          return async (): Promise<never> => {
            throw new Error('fallo de escritura simulado');
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as DataSource;
    const interpreter = new FakeInterpreter([operation(account.id)]);
    const commands = buildCommands(database, interpreter);
    telegram = new TelegramService(
      failing,
      new TransactionRunner(failing),
      commands,
      client,
      SETTINGS,
    );

    client.enqueue(messageUpdate(35, { text: 'Helado 2 dolares' }));
    client.enqueue(messageUpdate(36, { chatType: 'group' }));
    await telegram.start();
    await waitUntil(() => client.offsets.length >= 2, 20_000);

    const cursor = await database.dataSource.getRepository(TelegramCursor).findOneBy({
      id: POLLING_CURSOR_ID,
    });
    // El cursor no pasa de la actualizacion que no se pudo atender.
    expect(cursor?.lastUpdateId ?? 0).toBeLessThanOrEqual(35);
    expect(await database.dataSource.getRepository(TelegramInbox).count()).toBe(0);
    expect(interpreter.requests).toHaveLength(0);
    expect(client.sent).toHaveLength(0);
  });

  it('descarta lo pendiente que ya no esta autorizado, sin interpretar ni responder', async () => {
    const inbox = database.dataSource.getRepository(TelegramInbox);
    await inbox.save(
      inbox.create({
        updateId: 37,
        chatId: '999',
        userId: '999',
        text: 'Helado 2 dolares',
        receivedAt: RECEIVED_AT,
        state: 'accepted',
      }),
    );
    const outbox = database.dataSource.getRepository(TelegramOutbox);
    await outbox.save(
      outbox.create({
        updateId: 38,
        chatId: '999',
        userId: '999',
        text: 'Respuesta vieja',
        state: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
      }),
    );

    const interpreter = new FakeInterpreter([operation(account.id)]);
    telegram = buildService(database, client, interpreter);
    await telegram.start();
    await waitUntil(() => client.offsets.length >= 2, 20_000);

    const storedInbox = await inbox.findOneBy({ updateId: 37 });
    expect(storedInbox?.state).toBe('discarded');
    expect(storedInbox?.text).toBeNull();

    const storedOutbox = await outbox.findOneBy({ updateId: 38 });
    expect(storedOutbox?.state).toBe('discarded');
    expect(interpreter.requests).toHaveLength(0);
    expect(client.sent).toHaveLength(0);
  });

  it('retoma lo que quedo a medias antes de volver a consultar a Telegram', async () => {
    const inbox = database.dataSource.getRepository(TelegramInbox);
    await inbox.save(
      inbox.create({
        updateId: 40,
        chatId: String(CHAT_ID),
        userId: String(USER_ID),
        text: 'Helado 2 dolares',
        receivedAt: RECEIVED_AT,
        state: 'accepted',
      }),
    );
    const cursor = database.dataSource.getRepository(TelegramCursor);
    await cursor.save(cursor.create({ id: POLLING_CURSOR_ID, lastUpdateId: 40 }));

    const interpreter = new FakeInterpreter([operation(account.id)]);
    telegram = buildService(database, client, interpreter);

    await telegram.start();

    await waitUntil(() => client.sent.length === 1);
    expect(interpreter.requests).toHaveLength(1);
    // El cursor no retrocede: la actualizacion retomada ya estaba aceptada.
    expect(client.offsets[0]).toBe(41);
  });

  it('no consulta a Telegram si el bot no esta configurado', async () => {
    const service = buildService(database, client, new FakeInterpreter([]), {
      ...SETTINGS,
      enabled: false,
    });

    await service.start();

    expect(service.enabled).toBe(false);
    expect(client.offsets).toHaveLength(0);
  });

  it('se detiene al cerrar el modulo', async () => {
    await telegram.start();
    await waitUntil(() => client.offsets.length >= 1);

    await telegram.onModuleDestroy();
    const consulted = client.offsets.length;

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.offsets).toHaveLength(consulted);
  });
});
