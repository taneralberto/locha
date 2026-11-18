import { DataSource, ObjectLiteral, Repository } from 'typeorm';
import { Account } from '../src/accounts/account.entity';
import { AccountService } from '../src/accounts/account.service';
import { BudgetService } from '../src/budgets/budget.service';
import { GoalService } from '../src/savings/goal.service';
import { SavingsService } from '../src/savings/savings.service';
import { CaptureService } from '../src/capture/capture.service';
import { InferenceBudgetService } from '../src/capture/inference-budget.service';
import { TelegramSettings } from '../src/config/configuration';
import { TransactionRunner } from '../src/data/transaction.runner';
import { DebtService } from '../src/debts/debt.service';
import { FinancialService } from '../src/financial/financial.service';
import { TelegramCommands } from '../src/telegram/telegram-commands';
import { TelegramHistory } from '../src/telegram/telegram-history.entity';
import { TELEGRAM_HISTORY_WINDOW_MS } from '../src/telegram/telegram-history.store';
import { TelegramInbox } from '../src/telegram/telegram-inbox.entity';
import { TelegramOutbox } from '../src/telegram/telegram-outbox.entity';
import { TelegramService } from '../src/telegram/telegram.service';
import { TelegramMessage, TelegramUpdate } from '../src/telegram/telegram-update';
import { FakeInterpreter } from './helpers/fake-interpreter';
import { FakeTelegramClient, waitUntil } from './helpers/fake-telegram';
import { createTempDatabase, openDatabase, TempDatabase } from './helpers/temp-database';

const USER_ID = 111;
const CHAT_ID = 111;

/**
 * El historial vive en una ventana de una hora: la marca de tiempo del mensaje tiene
 * que ser **actual**. Las fixtures viejas de otros archivos usan una fecha fija y ya
 * estan fuera de la ventana.
 */
function now(): string {
  return new Date().toISOString();
}

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
 * Espera a que se cumpla una condicion asincrona. Cuenta intentos (no el reloj):
 * sirve tambien con la fecha falseada en las pruebas de desfase.
 */
async function waitForCondition(
  check: () => Promise<boolean>,
  attempts = 200,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('La condicion no se cumplio dentro del tiempo esperado.');
}

/** Actualizacion con mensaje de texto del usuario autorizado. */function messageUpdate(updateId: number, message: Partial<TelegramMessage> = {}): TelegramUpdate {
  return {
    updateId,
    message: {
      chatId: String(CHAT_ID),
      chatType: 'private',
      userId: String(USER_ID),
      isBot: false,
      text: 'Helado 2 dolares',
      receivedAt: now(),
      ...message,
    },
  };
}

function operation(accountId: string) {
  return {
    amount: '2.00',
    currency: 'USD',
    accountId,
    kind: 'expense' as const,
    occurredOn: '2026-11-10',
    description: 'Helado',
    debt: null,
  };
}

describe('Historial temporal de Telegram', () => {
  let database: TempDatabase;
  let account: Account;
  let client: FakeTelegramClient;
  let telegram: TelegramService;

  beforeEach(async () => {
    database = await createTempDatabase();
    const accounts = new AccountService(database.dataSource, database.transactions);
    account = await accounts.add({ name: 'Efectivo', currency: 'USD' });
    client = new FakeTelegramClient();
    telegram = buildService(database, client, new FakeInterpreter([operation(account.id)]));
  });

  afterEach(async () => {
    await telegram.stop();
    await database.cleanup();
  });

  function buildService(
    target: TempDatabase,
    telegramClient: FakeTelegramClient,
    interpreter: FakeInterpreter,
    settings: TelegramSettings = SETTINGS,
  ): TelegramService {
    const transactions = new TransactionRunner(target.dataSource);
    const financial = new FinancialService(transactions);
    const capture = new CaptureService(
      target.dataSource,
      transactions,
      financial,
      interpreter,
      new InferenceBudgetService(transactions, LIMITS),
      new DebtService(transactions, financial),
    );
    const commands = new TelegramCommands(
      capture,
      financial,
      new AccountService(target.dataSource, transactions),
      new InferenceBudgetService(transactions, LIMITS),
      LIMITS,
      new BudgetService(transactions, financial),
      new SavingsService(transactions, financial, new GoalService(transactions)),
      new DebtService(transactions, financial),
    );
    return new TelegramService(
      target.dataSource,
      transactions,
      commands,
      capture,
      telegramClient,
      settings,
    );
  }

  /** Filas del historial, en el orden de la tabla. */
  function historyRows(source: DataSource = database.dataSource): Promise<TelegramHistory[]> {
    return source.getRepository(TelegramHistory).find();
  }

  it('guarda el texto del usuario con la hora del mensaje de Telegram', async () => {
    const receivedAt = now();
    client.enqueue(messageUpdate(10, { receivedAt, text: 'Helado 2 dolares' }));

    await telegram.start();
    await waitUntil(() => client.sent.length === 1);

    const rows = await historyRows();
    const user = rows.find((row) => row.role === 'user');
    expect(user?.updateId).toBe(10);
    expect(user?.text).toBe('Helado 2 dolares');
    expect(user?.chatId).toBe(String(CHAT_ID));
    expect(user?.userId).toBe(String(USER_ID));
    // La hora es la del mensaje de Telegram, no la del momento en que se guardo.
    expect(user?.sentAt).toBe(Date.parse(receivedAt));
  });

  it('guarda la respuesta exacta que se entrego', async () => {
    client.enqueue(messageUpdate(11));

    await telegram.start();
    await waitUntil(() => client.sent.length === 1);

    const rows = await historyRows();
    const bot = rows.find((row) => row.role === 'bot');
    expect(bot?.updateId).toBe(11);
    // Exactamente lo que salio al chat, ni una palabra mas ni una menos.
    expect(bot?.text).toBe(client.sent[0]?.text);
    expect(bot?.chatId).toBe(String(CHAT_ID));
    expect(bot?.userId).toBe(String(USER_ID));
  });

  it('no guarda la respuesta que nunca se entrego', async () => {
    // El envio falla siempre: la respuesta no sale y no se guarda.
    client.pendingSendFailures = 50;
    client.enqueue(messageUpdate(12));

    await telegram.start();
    await waitUntil(() => client.sendAttempts.length >= 2, 20_000);

    const rows = await historyRows();
    expect(rows.filter((row) => row.role === 'bot')).toHaveLength(0);
    expect(rows.filter((row) => row.role === 'user')).toHaveLength(1);
  });

  it('no guarda dos veces la misma actualizacion', async () => {
    client.enqueue(messageUpdate(13));
    client.enqueue(messageUpdate(13));

    await telegram.start();
    await waitUntil(() => client.sent.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const rows = await historyRows();
    expect(rows.filter((row) => row.role === 'user')).toHaveLength(1);
    expect(rows.filter((row) => row.role === 'bot')).toHaveLength(1);
  });

  it('no duplica la respuesta cuando el envio falla y se reintenta', async () => {
    client.pendingSendFailures = 1;
    client.enqueue(messageUpdate(14));

    await telegram.start();
    await waitUntil(() => client.sent.length === 1, 20_000);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const rows = await historyRows();
    expect(rows.filter((row) => row.role === 'bot')).toHaveLength(1);
    expect(rows.find((row) => row.role === 'bot')?.text).toBe(client.sent[0]?.text);
  });

  it('guarda el texto entero, sin el recorte de la bandeja de entrada', async () => {
    // 3000 emojis: 6000 unidades UTF-16, mas que el tope de la bandeja de entrada.
    const text = '🍨'.repeat(3_000);
    const interpreter = new FakeInterpreter([operation(account.id)]);
    telegram = buildService(database, client, interpreter);
    client.enqueue(messageUpdate(15, { text }));

    await telegram.start();
    await waitUntil(() => client.sent.length === 1);

    const rows = await historyRows();
    const user = rows.find((row) => row.role === 'user');
    // El historial guarda el mensaje completo.
    expect(user?.text).toBe(text);
    expect(user?.text?.length).toBe(6_000);
    // La bandeja de entrada sigue con su tope: ahi el texto si se recorta, y es el
    // texto recortado el que llega al interprete.
    expect(interpreter.requests[0]?.text.length).toBe(4_096);
    // Y al terminar de procesarse, la bandeja de entrada queda sin texto.
    const inbox = await database.dataSource.getRepository(TelegramInbox).findOneBy({ updateId: 15 });
    expect(inbox?.state).toBe('done');
    expect(inbox?.text).toBeNull();
  });

  it('no guarda nada de un chat o de un usuario que no esta autorizado', async () => {
    client.enqueue(messageUpdate(16, { userId: '999' }));
    client.enqueue(messageUpdate(17, { chatType: 'group' }));
    client.enqueue(messageUpdate(18, { isBot: true }));

    await telegram.start();
    await waitUntil(() => client.offsets.length >= 2, 20_000);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await historyRows()).toHaveLength(0);
  });

  it('el historial sobrevive a un reinicio sobre la misma base', async () => {
    client.enqueue(messageUpdate(19));
    await telegram.start();
    await waitUntil(() => client.sent.length === 1);

    await telegram.stop();
    await database.close();

    const reopened = await openDatabase(database.path);
    try {
      const rows = await historyRows(reopened);
      expect(rows.filter((row) => row.role === 'user')).toHaveLength(1);
      expect(rows.filter((row) => row.role === 'bot')).toHaveLength(1);
      expect(rows.find((row) => row.role === 'bot')?.text).toBe(client.sent[0]?.text);
    } finally {
      await reopened.destroy();
    }
  });

  it('la revocacion purga el historial del chat que ya no esta autorizado', async () => {
    client.enqueue(messageUpdate(20));
    await telegram.start();
    await waitUntil(() => client.sent.length === 1);
    expect(await historyRows()).toHaveLength(2);
    await telegram.stop();

    const revokedClient = new FakeTelegramClient();
    const revoked = buildService(database, revokedClient, new FakeInterpreter([]), {
      ...SETTINGS,
      allowedChatId: 222,
    });
    await revoked.start();
    await waitUntil(() => revokedClient.offsets.length >= 2, 20_000);

    // El historial del chat revocado no se queda guardado.
    expect(await historyRows()).toHaveLength(0);
    await revoked.stop();
  });

  it('la purga del ciclo borra lo que se salio de la ventana', async () => {
    const repository = database.dataSource.getRepository(TelegramHistory);
    const expired = Date.now() - TELEGRAM_HISTORY_WINDOW_MS - 1_000;
    await repository.save(
      repository.create({
        updateId: 21,
        role: 'user',
        chatId: String(CHAT_ID),
        userId: String(USER_ID),
        text: 'Mensaje viejo',
        sentAt: expired,
      }),
    );

    await telegram.start();
    await waitUntil(() => client.offsets.length >= 2, 20_000);

    const rows = await historyRows();
    expect(rows).toHaveLength(0);
  });

  it('la lectura excluye la actualizacion actual, las siguientes y otros chats', async () => {
    const repository = database.dataSource.getRepository(TelegramHistory);
    const moment = Date.now();
    await repository.save([
      repository.create({
        updateId: 30,
        role: 'user',
        chatId: String(CHAT_ID),
        userId: String(USER_ID),
        text: 'Primero',
        sentAt: moment - 3_000,
      }),
      repository.create({
        updateId: 31,
        role: 'bot',
        chatId: String(CHAT_ID),
        userId: String(USER_ID),
        text: 'Respuesta',
        sentAt: moment - 2_000,
      }),
      repository.create({
        updateId: 32,
        role: 'user',
        chatId: '999',
        userId: '999',
        text: 'Otro chat',
        sentAt: moment - 1_500,
      }),
      repository.create({
        updateId: 33,
        role: 'user',
        chatId: String(CHAT_ID),
        userId: String(USER_ID),
        text: 'Siguiente',
        sentAt: moment - 1_000,
      }),
    ]);

    const entries = await telegram.readHistory({
      chatId: String(CHAT_ID),
      userId: String(USER_ID),
      beforeUpdateId: 33,
    });

    // Ni la actualizacion 33 (la actual), ni la 32 (otro chat): solo lo anterior.
    expect(entries.map((entry) => [entry.updateId, entry.role, entry.text])).toEqual([
      [30, 'user', 'Primero'],
      [31, 'bot', 'Respuesta'],
    ]);
  });

  it('la lectura aplica la ventana aunque la purga falle', async () => {
    const repository = database.dataSource.getRepository(TelegramHistory);
    const moment = Date.now();
    await repository.save([
      repository.create({
        updateId: 40,
        role: 'user',
        chatId: String(CHAT_ID),
        userId: String(USER_ID),
        text: 'Viejo',
        sentAt: moment - TELEGRAM_HISTORY_WINDOW_MS - 1_000,
      }),
      repository.create({
        updateId: 41,
        role: 'user',
        chatId: String(CHAT_ID),
        userId: String(USER_ID),
        text: 'Reciente',
        sentAt: moment - 1_000,
      }),
    ]);

    // La purga falla: lo que quedo en la base no se ve igual.
    const store = telegram['history'];
    const spy = jest.spyOn(store, 'purge').mockRejectedValue(new Error('fallo de purga simulado'));
    try {
      await telegram.start();
      await waitUntil(() => client.offsets.length >= 2, 20_000);

      const entries = await telegram.readHistory({
        chatId: String(CHAT_ID),
        userId: String(USER_ID),
        beforeUpdateId: 50,
      });
      expect(entries.map((entry) => entry.text)).toEqual(['Reciente']);
      // La fila vieja sigue en la base: la purga no pudo hacerse.
      expect(await historyRows()).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('no lee el historial de un par chat/usuario que ya no esta autorizado', async () => {
    client.enqueue(messageUpdate(60));
    await telegram.start();
    await waitUntil(() => client.sent.length === 1);
    await telegram.stop();
    expect(await historyRows()).toHaveLength(2);

    // El mismo chat pasa a ser de otro usuario y la purga falla: lo viejo sigue en la
    // base, pero ya no se puede leer.
    const revokedClient = new FakeTelegramClient();
    const revoked = buildService(database, revokedClient, new FakeInterpreter([]), {
      ...SETTINGS,
      allowedUserId: 999,
    });
    const store = revoked['history'];
    const spy = jest.spyOn(store, 'purge').mockRejectedValue(new Error('fallo de purga simulado'));
    try {
      await revoked.start();
      await waitUntil(() => revokedClient.offsets.length >= 2, 20_000);

      // Lo revocado no se lee: ni el par viejo ni el nuevo.
      expect(
        await revoked.readHistory({
          chatId: String(CHAT_ID),
          userId: String(USER_ID),
          beforeUpdateId: 100,
        }),
      ).toEqual([]);
      expect(
        await revoked.readHistory({ chatId: String(CHAT_ID), userId: '999', beforeUpdateId: 100 }),
      ).toEqual([]);
      // Y las filas siguen en la base: la purga no pudo hacerse.
      expect(await historyRows()).toHaveLength(2);
    } finally {
      spy.mockRestore();
      await revoked.stop();
    }
  });

  it('no lee nada con el bot apagado', async () => {
    const repository = database.dataSource.getRepository(TelegramHistory);
    await repository.save(
      repository.create({
        updateId: 61,
        role: 'user',
        chatId: String(CHAT_ID),
        userId: String(USER_ID),
        text: 'Mensaje',
        sentAt: Date.now() - 1_000,
      }),
    );

    const off = buildService(database, client, new FakeInterpreter([]), { ...SETTINGS, enabled: false });
    expect(
      await off.readHistory({
        chatId: String(CHAT_ID),
        userId: String(USER_ID),
        beforeUpdateId: 100,
      }),
    ).toEqual([]);
  });

  it('cabecea una fecha futura al instante de la aceptacion', async () => {
    const before = Date.now();
    // El reloj de Telegram va dos horas por delante.
    client.enqueue(
      messageUpdate(70, { receivedAt: new Date(before + 2 * 60 * 60 * 1000).toISOString() }),
    );

    await telegram.start();
    await waitUntil(() => client.sent.length === 1);

    const user = (await historyRows()).find((row) => row.role === 'user');
    // El mensaje no se pierde, pero el historial no lo retiene mas alla de ahora.
    expect(user?.sentAt).toBeGreaterThanOrEqual(before);
    expect(user?.sentAt).toBeLessThanOrEqual(Date.now());
  });

  it('no guarda un mensaje de mas de una hora', async () => {
    client.enqueue(
      messageUpdate(71, {
        receivedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      }),
    );

    await telegram.start();
    await waitUntil(() => client.sent.length === 1);

    expect((await historyRows()).filter((row) => row.role === 'user')).toHaveLength(0);
  });

  it('la lectura excluye un instante futuro aunque el reloj retroceda', async () => {
    const repository = database.dataSource.getRepository(TelegramHistory);
    await repository.save(
      repository.create({
        updateId: 72,
        role: 'user',
        chatId: String(CHAT_ID),
        userId: String(USER_ID),
        text: 'Futuro',
        sentAt: Date.now() + 2 * 60 * 60 * 1000,
      }),
    );

    const entries = await telegram.readHistory({
      chatId: String(CHAT_ID),
      userId: String(USER_ID),
      beforeUpdateId: 100,
    });
    expect(entries).toEqual([]);
  });

  it('no pierde la respuesta entregada si el reloj retrocede entre el ack y el commit', async () => {
    // Solo se falsea la fecha: los temporizadores siguen siendo reales.
    jest.useFakeTimers({
      doNotFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'setImmediate',
        'clearImmediate',
        'nextTick',
      ],
    });
    const base = Date.now();
    jest.setSystemTime(base);
    try {
      // El reloj retrocede 1 ms justo al marcar la entrega como enviada: el instante
      // de la confirmacion es un milisegundo "futuro" para la escritura.
      const original = Repository.prototype.update;
      const spy = jest
        .spyOn(Repository.prototype, 'update')
        .mockImplementation(function (
          this: Repository<ObjectLiteral>,
          criteria: unknown,
          partialEntity: unknown,
        ) {
          if (this.target === TelegramOutbox) {
            jest.setSystemTime(base - 1);
          }
          return original.call(this, criteria as never, partialEntity as never);
        });

      try {
        const interpreter = new FakeInterpreter([operation(account.id)]);
        telegram = buildService(database, client, interpreter);
        client.enqueue(messageUpdate(90));

        await telegram.start();
        await waitUntil(() => client.sent.length === 1, 20_000);
        const outbox = database.dataSource.getRepository(TelegramOutbox);
        await waitForCondition(async () => {
          const row = await outbox.findOneBy({ updateId: 90 });
          return row?.state === 'sent';
        });

        // La entrega quedo guardada y la respuesta **no** se perdio: esta en el
        // historial con el instante original de la confirmacion.
        expect((await outbox.findOneBy({ updateId: 90 }))?.state).toBe('sent');
        const bot = (await historyRows()).find((row) => row.role === 'bot');
        expect(bot?.text).toBe(client.sent[0]?.text);
        expect(bot?.sentAt).toBe(base);

        // Con el reloj todavia atrasado, la lectura la oculta (limite superior).
        expect(
          await telegram.readHistory({
            chatId: String(CHAT_ID),
            userId: String(USER_ID),
            beforeUpdateId: 100,
          }),
        ).toEqual([]);

        // Cuando el reloj se recupera, la respuesta vuelve a verse.
        jest.setSystemTime(base);
        const entries = await telegram.readHistory({
          chatId: String(CHAT_ID),
          userId: String(USER_ID),
          beforeUpdateId: 100,
        });
        const botEntry = entries.find((entry) => entry.role === 'bot');
        expect(botEntry?.text).toBe(client.sent[0]?.text);
        expect(botEntry?.sentAt).toBe(base);
      } finally {
        spy.mockRestore();
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('no reenvia una respuesta entregada cuando falla la escritura', async () => {    // La escritura de la respuesta del bot falla (un trigger la bloquea).
    await database.dataSource.query(
      `CREATE TRIGGER bloquea_bot BEFORE INSERT ON telegram_history WHEN NEW.role = 'bot'
       BEGIN SELECT RAISE(ABORT, 'bloqueado'); END`,
    );
    const interpreter = new FakeInterpreter([operation(account.id), operation(account.id)]);
    telegram = buildService(database, client, interpreter);
    client.enqueue(messageUpdate(80));
    client.enqueue(messageUpdate(81));

    await telegram.start();
    await waitUntil(() => client.sent.length === 1, 20_000);
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    // El mensaje salio una vez y **no** se reenvia, aunque la escritura siga fallando.
    expect(client.sent).toHaveLength(1);
    // La entrega sigue sin guardar: la fila no pasa a 'sent'.
    const outbox = database.dataSource.getRepository(TelegramOutbox);
    expect((await outbox.findOneBy({ updateId: 80 }))?.state).toBe('pending');
    // Y el chat espera: la segunda respuesta no se adelanta.
    expect(client.sent).toHaveLength(1);

    // Se levanta el bloqueo: la entrega se guarda (sin reenviar) y la siguiente sale.
    await database.dataSource.query('DROP TRIGGER bloquea_bot');
    await waitUntil(() => client.sent.length === 2, 20_000);

    expect((await outbox.findOneBy({ updateId: 80 }))?.state).toBe('sent');
    const bot = (await historyRows()).find((row) => row.role === 'bot');
    // La restauracion es exacta: lo guardado es lo que salio al chat.
    expect(bot?.text).toBe(client.sent[0]?.text);
    expect(bot?.updateId).toBe(80);
  });
});
