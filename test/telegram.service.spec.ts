import { DataSource, ObjectLiteral, Repository } from 'typeorm';
import { Account } from '../src/accounts/account.entity';
import { AccountService } from '../src/accounts/account.service';
import { Capture } from '../src/capture/capture.entity';
import { CaptureEvent } from '../src/capture/capture-event.entity';
import { CaptureService } from '../src/capture/capture.service';
import { InferenceBudgetService } from '../src/capture/inference-budget.service';
import { TelegramSettings } from '../src/config/configuration';
import { TransactionRunner } from '../src/data/transaction.runner';
import { FinancialService } from '../src/financial/financial.service';
import { Movement } from '../src/financial/movement.entity';
import { TelegramCommands } from '../src/telegram/telegram-commands';
import { POLLING_CURSOR_ID, TelegramCursor } from '../src/telegram/telegram-cursor.entity';
import { TelegramInbox } from '../src/telegram/telegram-inbox.entity';
import { TelegramOutbox, TelegramOutboxState } from '../src/telegram/telegram-outbox.entity';
import { TelegramService } from '../src/telegram/telegram.service';
import { TelegramMessage, TelegramUpdate, telegramEventId } from '../src/telegram/telegram-update';
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

/**
 * Comandos simulados: fallan en las actualizaciones indicadas y anotan las que se
 * procesan de verdad.
 */
function stubCommands(
  shouldFail: (eventId: string) => boolean,
  processed: string[],
): TelegramCommands {
  return {
    answer: async (request: { eventId: string }): Promise<string> => {
      if (shouldFail(request.eventId)) {
        throw new Error('fallo de procesamiento simulado');
      }
      processed.push(request.eventId);
      return 'respuesta simulada';
    },
  } as unknown as TelegramCommands;
}

/** Espera a que la entrega de una actualizacion llegue al estado indicado. */
async function waitForOutboxState(
  repository: Repository<TelegramOutbox>,
  updateId: number,
  state: TelegramOutboxState,
  timeoutMs = 20_000,
): Promise<TelegramOutbox | null> {
  const deadline = Date.now() + timeoutMs;
  let row = await repository.findOneBy({ updateId });
  while (row?.state !== state && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    row = await repository.findOneBy({ updateId });
  }
  return row;
}

describe('TelegramService', () => {
  let database: TempDatabase;
  let account: Account;
  let client: FakeTelegramClient;
  let telegram: TelegramService;
  /** Servicios que arranca una prueba y hay que detener al terminarla. */
  const extra: TelegramService[] = [];

  beforeEach(async () => {
    database = await createTempDatabase();
    const accounts = new AccountService(database.dataSource, database.transactions);
    account = await accounts.add({ name: 'Efectivo', currency: 'USD' });
    client = new FakeTelegramClient();
    telegram = buildService(database, client, new FakeInterpreter([]));
  });

  afterEach(async () => {
    for (const service of extra) {
      await service.stop();
    }
    extra.length = 0;
    await telegram.stop();
    await database.cleanup();
  });

  /** Captura de prueba sobre la base temporal. */
  function buildCapture(responses: number): CaptureService {
    const transactions = database.transactions;
    const financial = new FinancialService(transactions);
    return new CaptureService(
      database.dataSource,
      transactions,
      financial,
      new FakeInterpreter(Array.from({ length: responses }, () => operation(account.id))),
      new InferenceBudgetService(transactions, LIMITS),
    );
  }

  /**
   * Fila de la bandeja de entrada de una actualizacion ya procesada. Es la procedencia
   * durable de un borrador: de ella sale el usuario que lo creo.
   */
  async function seedInbox(updateId: number, userId: string): Promise<void> {
    const inbox = database.dataSource.getRepository(TelegramInbox);
    await inbox.save(
      inbox.create({
        updateId,
        chatId: String(CHAT_ID),
        userId,
        text: 'Helado 2 dolares',
        receivedAt: RECEIVED_AT,
        state: 'done',
      }),
    );
  }

  /** Espera a que la bandeja de entrada tenga la actualizacion. */
  async function waitForInbox(
    updateId: number,
    timeoutMs = 20_000,
  ): Promise<TelegramInbox | null> {
    const deadline = Date.now() + timeoutMs;
    const inbox = database.dataSource.getRepository(TelegramInbox);
    let row = await inbox.findOneBy({ updateId });
    while (!row && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      row = await inbox.findOneBy({ updateId });
    }
    return row;
  }

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
      new InferenceBudgetService(transactions, LIMITS),
    );
    return new TelegramCommands(
      capture,
      financial,
      new AccountService(target.dataSource, transactions),
      new InferenceBudgetService(transactions, LIMITS),
      LIMITS,
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

  describe('procesamiento que falla', () => {
    it('conserva la actualizacion que no se pudo procesar y no procesa las siguientes de su chat', async () => {
      const processed: string[] = [];
      telegram = new TelegramService(
        database.dataSource,
        database.transactions,
        stubCommands((eventId) => eventId === 'telegram:10', processed),
        client,
        SETTINGS,
      );

      // Una respuesta que ya estaba lista: se entrega aunque el chat se bloquee.
      const outbox = database.dataSource.getRepository(TelegramOutbox);
      await outbox.save(
        outbox.create({
          updateId: 1,
          chatId: String(CHAT_ID),
          userId: String(USER_ID),
          text: 'Respuesta anterior',
          state: 'pending',
          attempts: 0,
          nextAttemptAt: 0,
          lastError: null,
        }),
      );

      client.enqueue(messageUpdate(10));
      client.enqueue(messageUpdate(11, { text: '/confirm' }));
      client.enqueue(messageUpdate(12, { text: 'en la cuenta Efectivo' }));

      await telegram.start();
      await waitUntil(() => client.sent.length === 1, 20_000);

      // Lo que ya estaba listo se entrega.
      expect(client.lastSent?.text).toBe('Respuesta anterior');

      // Las tres actualizaciones quedan aceptadas y ninguna se procesa.
      const inbox = database.dataSource.getRepository(TelegramInbox);
      expect((await inbox.findOneBy({ updateId: 10 }))?.state).toBe('accepted');
      expect((await inbox.findOneBy({ updateId: 11 }))?.state).toBe('accepted');
      expect((await inbox.findOneBy({ updateId: 12 }))?.state).toBe('accepted');
      expect(processed).toEqual([]);

      // El sondeo sigue: un chat bloqueado no atasca el bot.
      await waitUntil(() => client.offsets.length >= 3, 20_000);
      expect(processed).toEqual([]);
    });

    it('recupera lo pendiente en orden cuando el procesamiento vuelve a funcionar', async () => {
      const processed: string[] = [];
      let failures = 1;
      telegram = new TelegramService(
        database.dataSource,
        database.transactions,
        stubCommands((eventId) => {
          if (eventId !== 'telegram:10' || failures === 0) {
            return false;
          }
          failures -= 1;
          return true;
        }, processed),
        client,
        SETTINGS,
      );

      client.enqueue(messageUpdate(10));
      client.enqueue(messageUpdate(11, { text: '/confirm' }));
      client.enqueue(messageUpdate(12, { text: 'en la cuenta Efectivo' }));

      await telegram.start();
      await waitUntil(() => processed.length === 3, 20_000);

      expect(processed).toEqual(['telegram:10', 'telegram:11', 'telegram:12']);
    });

    it('espera entre reintentos aunque el sondeo funcione', async () => {
      const attempts: number[] = [];
      telegram = new TelegramService(
        database.dataSource,
        database.transactions,
        {
          answer: async (): Promise<string> => {
            attempts.push(Date.now());
            throw new Error('fallo de procesamiento simulado');
          },
        } as unknown as TelegramCommands,
        client,
        SETTINGS,
      );

      client.enqueue(messageUpdate(10));
      await telegram.start();
      await waitUntil(() => attempts.length >= 2, 20_000);

      // El sondeo no falla, pero el reintento de procesamiento respeta su espera.
      expect(client.offsets.length).toBeGreaterThan(1);
      const gap = (attempts[1] ?? 0) - (attempts[0] ?? 0);
      expect(gap).toBeGreaterThanOrEqual(900);
    });
  });

  describe('orden durable del pendiente', () => {
    it('no procesa un /confirm nuevo mientras no se puede leer lo pendiente', async () => {
      const interpreter = new FakeInterpreter([
        operation(account.id),
        { ...operation(account.id), amount: '5.00' },
      ]);
      telegram = buildService(database, client, interpreter);

      // Un borrador de 2 dolares.
      client.enqueue(messageUpdate(9));
      await telegram.start();
      await waitUntil(() => client.sent.length === 1, 20_000);

      // A partir de aqui la bandeja de entrada no se puede leer.
      let failures = 3;
      const original = Repository.prototype.find;
      const spy = jest.spyOn(Repository.prototype, 'find').mockImplementation(function (
        this: Repository<ObjectLiteral>,
        ...args: unknown[]
      ): Promise<unknown[]> {
        if (this.target === TelegramInbox && failures > 0) {
          failures -= 1;
          return Promise.reject(new Error('fallo de lectura simulado'));
        }
        return (original as (...rest: unknown[]) => Promise<unknown[]>).apply(this, args);
      });

      try {
        // La correccion (10) y la confirmacion (11) se aceptan, pero no se procesan.
        client.enqueue(messageUpdate(10, { text: 'Era 5 dolares' }));
        client.enqueue(messageUpdate(11, { text: '/confirm' }));
        await waitForInbox(10);
        await waitForInbox(11);

        // Sin la lectura no se sabe que hay pendiente: el /confirm no puede aplicar
        // el borrador viejo de 2 dolares.
        expect(await database.dataSource.getRepository(Movement).count()).toBe(0);
        expect(interpreter.requests).toHaveLength(1);
        expect(client.sent).toHaveLength(1);

        // Al recuperarse, lo pendiente se procesa en orden: la correccion primero.
        failures = 0;
        const movements = database.dataSource.getRepository(Movement);
        const deadline = Date.now() + 20_000;
        let registered = await movements.find();
        while (registered.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          registered = await movements.find();
        }

        expect(registered).toHaveLength(1);
        expect(registered[0]?.amountMinor).toBe(500n);
      } finally {
        spy.mockRestore();
      }
    });

    it('con la lectura de la bandeja de entrada fallando no se procesa nada nuevo', async () => {
      const interpreter = new FakeInterpreter([operation(account.id)]);
      telegram = buildService(database, client, interpreter);

      const original = Repository.prototype.find;
      const spy = jest.spyOn(Repository.prototype, 'find').mockImplementation(function (
        this: Repository<ObjectLiteral>,
        ...args: unknown[]
      ): Promise<unknown[]> {
        if (this.target === TelegramInbox) {
          return Promise.reject(new Error('fallo de lectura simulado'));
        }
        return (original as (...rest: unknown[]) => Promise<unknown[]>).apply(this, args);
      });

      try {
        client.enqueue(messageUpdate(10));
        client.enqueue(messageUpdate(11, { text: '/confirm' }));
        await telegram.start();
        await waitForInbox(11);
        await new Promise((resolve) => setTimeout(resolve, 2_000));

        // Nada se interpreta y nada se registra.
        expect(interpreter.requests).toHaveLength(0);
        expect(await database.dataSource.getRepository(Movement).count()).toBe(0);
        expect(client.sent).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('si la limpieza de lo revocado falla no se confirma ningun borrador', async () => {
      // Un borrador vivo del usuario 111.
      await buildCapture(1).handle({
        eventId: telegramEventId(50),
        chatId: String(CHAT_ID),
        text: 'Helado 2 dolares',
        receivedAt: RECEIVED_AT,
      });
      await seedInbox(50, String(USER_ID));

      // La limpieza revienta al cancelar el borrador revocado.
      const original = Repository.prototype.update;
      const spy = jest.spyOn(Repository.prototype, 'update').mockImplementation(function (
        this: Repository<ObjectLiteral>,
        criteria: unknown,
        partialEntity: unknown,
      ) {
        if (this.target === Capture) {
          return Promise.reject(new Error('fallo de escritura simulado'));
        }
        return original.call(this, criteria as never, partialEntity as never);
      });

      try {
        // El chat sigue autorizado, pero ahora es otro usuario: el borrador esta revocado.
        const withNewUser = buildService(database, client, new FakeInterpreter([]), {
          ...SETTINGS,
          allowedUserId: 999,
        });
        extra.push(withNewUser);
        client.enqueue(messageUpdate(60, { text: '/confirm', userId: '999' }));
        await withNewUser.start();
        await waitUntil(() => client.offsets.length >= 2, 20_000);
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Sin limpieza no se procesa nada: el /confirm no registra el borrador.
        expect(await database.dataSource.getRepository(Movement).count()).toBe(0);
        expect(client.sent).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('entrega por chat', () => {
    it('no adelanta las respuestas de un chat cuya entrega anterior esta retrasada', async () => {
      const outbox = database.dataSource.getRepository(TelegramOutbox);
      await outbox.save(
        outbox.create({
          updateId: 20,
          chatId: String(CHAT_ID),
          userId: String(USER_ID),
          text: 'primera',
          state: 'pending',
          attempts: 0,
          nextAttemptAt: Date.now() + 60_000,
          lastError: null,
        }),
      );
      await outbox.save(
        outbox.create({
          updateId: 21,
          chatId: String(CHAT_ID),
          userId: String(USER_ID),
          text: 'segunda',
          state: 'pending',
          attempts: 0,
          nextAttemptAt: 0,
          lastError: null,
        }),
      );

      await telegram.start();
      // Varias vueltas del ciclo sin que la primera pueda salir.
      await waitUntil(() => client.offsets.length >= 3, 20_000);
      expect(client.sent).toHaveLength(0);

      // Cuando la primera puede salir, las dos salen en orden.
      await outbox.update({ updateId: 20 }, { nextAttemptAt: 0 });
      await waitUntil(() => client.sent.length === 2, 20_000);
      expect(client.sent.map((message) => message.text)).toEqual(['primera', 'segunda']);
    });

    it('no adelanta las respuestas de un chat cuya entrega anterior falla de forma transitoria', async () => {
      client.pendingSendFailures = 1;
      const outbox = database.dataSource.getRepository(TelegramOutbox);
      await outbox.save(
        outbox.create({
          updateId: 22,
          chatId: String(CHAT_ID),
          userId: String(USER_ID),
          text: 'primera',
          state: 'pending',
          attempts: 0,
          nextAttemptAt: 0,
          lastError: null,
        }),
      );
      await outbox.save(
        outbox.create({
          updateId: 23,
          chatId: String(CHAT_ID),
          userId: String(USER_ID),
          text: 'segunda',
          state: 'pending',
          attempts: 0,
          nextAttemptAt: 0,
          lastError: null,
        }),
      );

      await telegram.start();
      await waitUntil(() => client.sent.length === 2, 20_000);

      // La que fallo se reintenta y sale antes que la siguiente.
      expect(client.sent.map((message) => message.text)).toEqual(['primera', 'segunda']);
      expect(client.sendAttempts.length).toBeGreaterThanOrEqual(3);
      expect((await outbox.findOneBy({ updateId: 22 }))?.state).toBe('sent');
    });

    it('un fallo puntual de la bandeja de salida no para el ciclo', async () => {
      const original = Repository.prototype.update;
      let failed = false;
      const spy = jest
        .spyOn(Repository.prototype, 'update')
        .mockImplementation(function (
          this: Repository<ObjectLiteral>,
          criteria: unknown,
          partialEntity: unknown,
        ) {
          if (!failed && this.target === TelegramOutbox) {
            failed = true;
            return Promise.reject(new Error('fallo de escritura simulado'));
          }
          return original.call(this, criteria as never, partialEntity as never);
        });

      try {
        client.enqueue(messageUpdate(30, { text: '/help' }));
        await telegram.start();

        // El ciclo sigue y la entrega se completa cuando la base vuelve a responder.
        const outbox = database.dataSource.getRepository(TelegramOutbox);
        const row = await waitForOutboxState(outbox, 30, 'sent');
        expect(failed).toBe(true);
        expect(row?.state).toBe('sent');
        expect(client.offsets.length).toBeGreaterThan(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('reproduce la respuesta cuando solo falla la creacion de la bandeja de salida', async () => {
      const interpreter = new FakeInterpreter([operation(account.id)]);
      telegram = buildService(database, client, interpreter);

      const original = Repository.prototype.save;
      let failed = false;
      const spy = jest
        .spyOn(Repository.prototype, 'save')
        .mockImplementation(function (this: Repository<ObjectLiteral>, entity: unknown) {
          if (!failed && this.target === TelegramOutbox) {
            failed = true;
            return Promise.reject(new Error('fallo de escritura simulado'));
          }
          return original.call(this, entity as never);
        });

      try {
        client.enqueue(messageUpdate(40));
        await telegram.start();
        await waitUntil(() => client.sent.length === 1, 20_000);
      } finally {
        spy.mockRestore();
      }

      // La inferencia no se repite: se reproduce la respuesta guardada.
      expect(interpreter.requests).toHaveLength(1);
      expect(client.lastSent?.text).toContain('2.00 USD');
      expect(await database.dataSource.getRepository(Movement).count()).toBe(0);
    });
  });

  describe('revocacion de un chat', () => {
    it('descarta el trabajo pendiente y cancela el borrador de un chat revocado', async () => {
      const capture = buildCapture(3);
      await capture.handle({
        eventId: telegramEventId(50),
        chatId: String(CHAT_ID),
        text: 'Helado 2 dolares',
        receivedAt: RECEIVED_AT,
      });
      await capture.handle({
        eventId: telegramEventId(51),
        chatId: String(CHAT_ID),
        text: '/confirm',
        receivedAt: RECEIVED_AT,
      });
      await capture.handle({
        eventId: telegramEventId(52),
        chatId: String(CHAT_ID),
        text: 'Cafe 2 dolares',
        receivedAt: RECEIVED_AT,
      });
      await seedInbox(50, String(USER_ID));
      await seedInbox(51, String(USER_ID));
      await seedInbox(52, String(USER_ID));

      const outbox = database.dataSource.getRepository(TelegramOutbox);
      await outbox.save(
        outbox.create({
          updateId: 50,
          chatId: String(CHAT_ID),
          userId: String(USER_ID),
          text: 'Respuesta pendiente',
          state: 'pending',
          attempts: 2,
          nextAttemptAt: Date.now() + 60_000,
          lastError: null,
        }),
      );

      const revoked = buildService(database, client, new FakeInterpreter([]), {
        ...SETTINGS,
        allowedChatId: 222,
      });
      extra.push(revoked);
      await revoked.start();
      await waitUntil(() => client.offsets.length >= 2, 20_000);

      const pending = await outbox.findOneBy({ updateId: 50 });
      expect(pending?.state).toBe('discarded');
      expect(pending?.text).toBe('');
      expect(pending?.lastError).toBe('not_allowed');
      expect(pending?.nextAttemptAt).toBe(0);

      const captures = await database.dataSource.getRepository(Capture).find();
      const cancelled = captures.find((row) => row.state === 'cancelled');
      expect(cancelled?.sourceText).toBeNull();
      expect(captures.filter((row) => row.state === 'awaiting_confirmation')).toHaveLength(0);
      // El borrador ya registrado no se toca.
      expect(captures.filter((row) => row.state === 'registered')).toHaveLength(1);

      // Lo ya registrado no se toca: ni el movimiento ni el historial de eventos.
      expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
      const events = await database.dataSource.getRepository(CaptureEvent).find();
      expect(events.filter((row) => row.state === 'completed')).toHaveLength(3);
    });

    it('un chat reautorizado con otro usuario no puede confirmar el borrador revocado', async () => {
      // El borrador lo creo el usuario 111.
      const capture = buildCapture(1);
      await capture.handle({
        eventId: telegramEventId(50),
        chatId: String(CHAT_ID),
        text: 'Helado 2 dolares',
        receivedAt: RECEIVED_AT,
      });
      await seedInbox(50, String(USER_ID));

      // El chat sigue autorizado, pero ahora es otro usuario.
      const withNewUser = buildService(database, client, new FakeInterpreter([]), {
        ...SETTINGS,
        allowedUserId: 999,
      });
      extra.push(withNewUser);
      await withNewUser.start();
      await waitUntil(() => client.offsets.length >= 2, 20_000);

      // El borrador del usuario revocado queda cancelado.
      const captures = await database.dataSource.getRepository(Capture).find();
      const cancelled = captures.find((row) => row.state === 'cancelled');
      expect(cancelled?.sourceText).toBeNull();
      expect(captures.filter((row) => row.state === 'awaiting_confirmation')).toHaveLength(0);

      // El /confirm del usuario vigente no registra el borrador del otro.
      client.enqueue(messageUpdate(60, { text: '/confirm', userId: '999' }));
      await waitUntil(() => client.sent.length === 1, 20_000);

      expect(client.lastSent?.text).toContain('No hay ninguna operacion pendiente');
      expect(await database.dataSource.getRepository(Movement).count()).toBe(0);
    });

    it('no cancela el borrador nuevo del usuario vigente por las filas historicas de otro', async () => {
      // Filas historicas de otro usuario del mismo chat.
      await seedInbox(50, String(USER_ID));
      // El borrador vivo es del usuario vigente.
      const capture = buildCapture(1);
      await capture.handle({
        eventId: telegramEventId(60),
        chatId: String(CHAT_ID),
        text: 'Helado 2 dolares',
        receivedAt: RECEIVED_AT,
      });
      await seedInbox(60, '999');

      const withNewUser = buildService(database, client, new FakeInterpreter([]), {
        ...SETTINGS,
        allowedUserId: 999,
      });
      extra.push(withNewUser);
      await withNewUser.start();
      await waitUntil(() => client.offsets.length >= 2, 20_000);

      const captures = await database.dataSource.getRepository(Capture).find();
      const live = captures.find((row) => row.state === 'awaiting_confirmation');
      expect(live?.sourceText).not.toBeNull();
      expect(captures.filter((row) => row.state === 'cancelled')).toHaveLength(0);
    });
  });

  it('retoma lo pendiente en orden tras un reinicio y no duplica el movimiento', async () => {
    const interpreter = new FakeInterpreter([operation(account.id)]);
    const inbox = database.dataSource.getRepository(TelegramInbox);
    await inbox.save(
      inbox.create({
        updateId: 70,
        chatId: String(CHAT_ID),
        userId: String(USER_ID),
        text: 'Helado 2 dolares',
        receivedAt: RECEIVED_AT,
        state: 'accepted',
      }),
    );
    await inbox.save(
      inbox.create({
        updateId: 71,
        chatId: String(CHAT_ID),
        userId: String(USER_ID),
        text: '/confirm',
        receivedAt: RECEIVED_AT,
        state: 'accepted',
      }),
    );
    const cursor = database.dataSource.getRepository(TelegramCursor);
    await cursor.save(cursor.create({ id: POLLING_CURSOR_ID, lastUpdateId: 70 }));

    telegram = buildService(database, client, interpreter);
    await telegram.start();

    await waitUntil(() => client.sent.length === 2, 20_000);
    expect(client.sent[0]?.text).toContain('2.00 USD');
    expect(client.sent[1]?.text).toContain('Registrado');
    expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
  });
});
