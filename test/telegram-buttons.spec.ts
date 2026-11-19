import { CaptureService } from '../src/capture/capture.service';
import { InferenceBudgetService } from '../src/capture/inference-budget.service';
import { TelegramSettings } from '../src/config/configuration';
import { TransactionRunner } from '../src/data/transaction.runner';
import { DebtService } from '../src/debts/debt.service';
import { FinancialService } from '../src/financial/financial.service';
import { TelegramButtonRows } from '../src/telegram/telegram-buttons';
import {
  parseButtons,
  serializeButtons,
  TelegramButtonError,
  validateButton,
} from '../src/telegram/telegram-buttons';
import { CallbackRequest, TelegramCommands } from '../src/telegram/telegram-commands';
import { POLLING_CURSOR_ID, TelegramCursor } from '../src/telegram/telegram-cursor.entity';
import { TelegramHistory } from '../src/telegram/telegram-history.entity';
import { TelegramInbox } from '../src/telegram/telegram-inbox.entity';
import { TelegramOutbox } from '../src/telegram/telegram-outbox.entity';
import { TelegramService } from '../src/telegram/telegram.service';
import { parseTelegramUpdate, TelegramCallback, TelegramMessage, TelegramUpdate } from '../src/telegram/telegram-update';
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

const BUTTONS: TelegramButtonRows = [
  [{ text: 'Si', data: 'accion:si' }, { text: 'No', data: 'accion:no' }],
  [{ text: 'Ver', data: 'accion:ver' }],
];

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

/** Actualizacion con una pulsacion de boton. */
function callbackUpdate(updateId: number, callback: Partial<TelegramCallback> = {}): TelegramUpdate {
  return {
    updateId,
    message: null,
    callback: {
      callbackId: `cb-${updateId}`,
      data: 'accion:si',
      chatId: String(CHAT_ID),
      chatType: 'private',
      userId: String(USER_ID),
      isBot: false,
      messageId: 1001,
      inline: false,
      receivedAt: RECEIVED_AT,
      ...callback,
    },
  };
}

/**
 * Comandos simulados: la respuesta de texto lleva botones y las pulsaciones quedan
 * anotadas para comprobar que se enrutaron.
 */
function buttonCommands(
  routed: CallbackRequest[],
  text = 'respuesta con botones',
): TelegramCommands {
  return {
    answer: async (): Promise<string> => text,
    answerDelivery: async (): Promise<{ text: string; buttons: TelegramButtonRows }> => ({
      text,
      buttons: BUTTONS,
    }),
    answerCallback: async (request: CallbackRequest): Promise<Record<string, never>> => {
      routed.push(request);
      return {};
    },
  } as unknown as TelegramCommands;
}

describe('Telegram: botones inline y pulsaciones', () => {
  it('los datos del boton caben en 1..64 bytes UTF-8 y el error no los imprime', () => {
    expect(validateButton({ text: 'Si', data: 'a' }).data).toBe('a');
    expect(validateButton({ text: 'Si', data: 'x'.repeat(64) }).data).toHaveLength(64);
    expect(() => validateButton({ text: 'Si', data: '' })).toThrow(TelegramButtonError);
    expect(() => validateButton({ text: 'Si', data: 'x'.repeat(65) })).toThrow(TelegramButtonError);
    expect(() => validateButton({ text: ' ', data: 'a' })).toThrow(TelegramButtonError);
    // El error no lleva los datos del boton: pueden contener algo que no debe salir.
    try {
      validateButton({ text: 'Si', data: 'secreto-del-boton' });
    } catch (error) {
      expect((error as Error).message).not.toContain('secreto-del-boton');
    }
    // Los emojis cuentan por bytes, no por caracteres.
    expect(() => validateButton({ text: 'Si', data: '😀'.repeat(17) })).toThrow(TelegramButtonError);
  });

  it('el teclado se serializa y se lee; uno roto se trata como sin teclado', () => {
    const markup = serializeButtons(BUTTONS);
    expect(parseButtons(markup)).toEqual(BUTTONS);
    expect(serializeButtons([])).toBeNull();
    expect(parseButtons(null)).toBeNull();
    expect(parseButtons('{no es json')).toBeNull();
    expect(parseButtons('[[{"text":"Si"}]]')).toBeNull();
  });

  let database: TempDatabase;
  let client: FakeTelegramClient;
  let telegram: TelegramService;
  let routed: CallbackRequest[];

  beforeEach(async () => {
    database = await createTempDatabase();
    client = new FakeTelegramClient();
    routed = [];
    telegram = buildService(database, client);
  });

  afterEach(async () => {
    await telegram.stop();
    await database.cleanup();
  });

  function buildService(target: TempDatabase, telegramClient: FakeTelegramClient): TelegramService {
    const transactions = new TransactionRunner(target.dataSource);
    const financial = new FinancialService(transactions);
    const capture = new CaptureService(
      target.dataSource,
      transactions,
      financial,
      new FakeInterpreter([]),
      new InferenceBudgetService(transactions, LIMITS),
      new DebtService(transactions, financial),
    );
    return new TelegramService(
      target.dataSource,
      transactions,
      buttonCommands(routed),
      capture,
      telegramClient,
      SETTINGS,
    );
  }

  it('el texto sale igual que antes y con su teclado inline', async () => {
    client.enqueue(messageUpdate(10));
    await telegram.start();
    await waitUntil(() => client.sent.length === 1);

    expect(client.lastSent?.text).toBe('respuesta con botones');
    expect(client.lastSent?.buttons).toEqual(BUTTONS);

    const outbox = await database.dataSource.getRepository(TelegramOutbox).findOneBy({ updateId: 10 });
    expect(outbox?.state).toBe('sent');
    // El teclado viaja con el texto y el id del mensaje se guarda con el estado.
    expect(JSON.parse(outbox?.markup ?? '[]')).toEqual(BUTTONS);
    expect(outbox?.messageId).toBe(1001);
  });

  it('la pulsacion de un boton exacto de una entrega enviada se enruta', async () => {
    client.enqueue(messageUpdate(10));
    await telegram.start();
    await waitUntil(() => client.sent.length === 1);

    client.enqueue(callbackUpdate(11));
    await waitUntil(() => routed.length === 1);

    expect(routed[0]).toMatchObject({
      data: 'accion:si',
      chatId: String(CHAT_ID),
      userId: String(USER_ID),
      updateId: 11,
      deliveryUpdateId: 10,
      messageId: 1001,
    });
    // La pulsacion se confirma con una alerta breve, sin mandar texto al chat.
    expect(client.acks).toHaveLength(1);
    expect(client.acks[0]).toMatchObject({ callbackId: 'cb-11' });
    expect(client.sent).toHaveLength(1);
  });

  it('una pulsacion sin entrega exacta no se enruta', async () => {
    client.enqueue(messageUpdate(10));
    await telegram.start();
    await waitUntil(() => client.sent.length === 1);

    // Un messageId que no es el de la entrega.
    client.enqueue(callbackUpdate(11, { messageId: 9999 }));
    // Una pulsacion inventada: los datos no son de ningun boton de ese teclado.
    client.enqueue(callbackUpdate(12, { data: 'accion:inventada' }));
    await waitUntil(() => client.acks.length === 2);

    expect(routed).toHaveLength(0);
    expect(client.acks.every((ack) => ack.text !== null)).toBe(true);
    expect(client.sent).toHaveLength(1);
    const inbox = await database.dataSource.getRepository(TelegramInbox).findOneBy({ updateId: 11 });
    expect(inbox?.state).toBe('done');
    expect(inbox?.callback).toBeNull();
  });

  it('una pulsacion no autorizada se ignora y no se guarda', async () => {
    client.enqueue(callbackUpdate(20, { userId: '999' }));
    client.enqueue(callbackUpdate(21, { isBot: true }));
    client.enqueue(callbackUpdate(22, { inline: true }));
    client.enqueue(callbackUpdate(23, { messageId: null }));
    await telegram.start();
    await waitUntil(() => client.offsets.length >= 2);

    const inbox = await database.dataSource.getRepository(TelegramInbox).find();
    expect(inbox).toHaveLength(0);
    expect(routed).toHaveLength(0);
    const cursor = await database.dataSource.getRepository(TelegramCursor).findOneBy({
      id: POLLING_CURSOR_ID,
    });
    expect(cursor?.lastUpdateId).toBe(23);
  });

  it('la pulsacion no se graba como texto de usuario ni entra al historial', async () => {
    // Con un mensaje dentro de la ventana del historial, para poder comprobar que
    // el mensaje **si** se guarda y la pulsacion no.
    const ahora = new Date().toISOString();
    client.enqueue(messageUpdate(10, { receivedAt: ahora }));
    await telegram.start();
    await waitUntil(() => client.sent.length === 1);
    client.enqueue(callbackUpdate(11, { receivedAt: ahora }));
    await waitUntil(() => routed.length === 1);

    // La fila se conserva con su contexto, pero su carga se borra: no queda texto.
    const inbox = await database.dataSource.getRepository(TelegramInbox).findOneBy({ updateId: 11 });
    expect(inbox).not.toBeNull();
    expect(inbox?.text).toBeNull();
    expect(inbox?.callback).toBeNull();
    expect(inbox?.state).toBe('done');
    const history = await database.dataSource.getRepository(TelegramHistory).find();
    expect(history.filter((entry) => entry.updateId === 11)).toHaveLength(0);
    expect(history.filter((entry) => entry.updateId === 10 && entry.role === 'user')).toHaveLength(1);
  });

  it('la misma pulsacion repetida no duplica la entrega', async () => {
    client.enqueue(messageUpdate(10));
    await telegram.start();
    await waitUntil(() => client.sent.length === 1);
    client.enqueue(callbackUpdate(11));
    await waitUntil(() => routed.length === 1);
    client.enqueue(callbackUpdate(11));
    await waitUntil(() => client.offsets.length >= 3);

    const outbox = await database.dataSource.getRepository(TelegramOutbox).find();
    expect(outbox.filter((row) => row.updateId === 11)).toHaveLength(0);
    expect(routed).toHaveLength(1);
  });

  it('una pulsacion pendiente se procesa despues de reiniciar', async () => {
    // Una entrega ya enviada con su boton y la pulsacion pendiente en la bandeja.
    await database.dataSource.getRepository(TelegramOutbox).save(
      database.dataSource.getRepository(TelegramOutbox).create({
        updateId: 10,
        chatId: String(CHAT_ID),
        userId: String(USER_ID),
        text: 'respuesta con botones',
        markup: JSON.stringify(BUTTONS),
        messageId: 1001,
        state: 'sent',
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
      }),
    );
    await database.dataSource.getRepository(TelegramInbox).save(
      database.dataSource.getRepository(TelegramInbox).create({
        updateId: 11,
        chatId: String(CHAT_ID),
        userId: String(USER_ID),
        text: null,
        callback: JSON.stringify({ callbackId: 'cb-11', data: 'accion:si', messageId: 1001 }),
        receivedAt: RECEIVED_AT,
        state: 'accepted',
      }),
    );

    await telegram.start();
    await waitUntil(() => routed.length === 1);
    expect(routed[0]).toMatchObject({ updateId: 11, deliveryUpdateId: 10, messageId: 1001 });
  });

  it('una fila con pulsacion rota no entra por el camino de texto', async () => {
    // Una fila corrupta: la pulsacion no se puede leer pero el texto si.
    await database.dataSource.getRepository(TelegramInbox).save(
      database.dataSource.getRepository(TelegramInbox).create({
        updateId: 30,
        chatId: String(CHAT_ID),
        userId: String(USER_ID),
        text: 'Helado 2 dolares',
        callback: '{no es json',
        receivedAt: RECEIVED_AT,
        state: 'accepted',
      }),
    );
    await telegram.start();
    await waitUntil(() => client.offsets.length >= 2);

    // No se responde como si fuera un mensaje: la pulsacion se descarta.
    expect(client.sent).toHaveLength(0);
    expect(routed).toHaveLength(0);
    expect(client.acks).toHaveLength(0);
    const inbox = await database.dataSource.getRepository(TelegramInbox).findOneBy({ updateId: 30 });
    expect(inbox?.state).toBe('done');
    expect(inbox?.callback).toBeNull();
  });

  it('una pulsacion con datos invalidos no se enruta', async () => {
    for (const [updateId, payload] of [
      [31, { callbackId: 'cb-31', data: '', messageId: 1001 }],
      [32, { callbackId: 'cb-32', data: 'x'.repeat(65), messageId: 1001 }],
      [33, { callbackId: 'cb-33', data: 'accion:si', messageId: 0 }],
      [34, { callbackId: 'cb-34', data: 'accion:si', messageId: -3 }],
      [35, { callbackId: '', data: 'accion:si', messageId: 1001 }],
    ] as const) {
      await database.dataSource.getRepository(TelegramInbox).save(
        database.dataSource.getRepository(TelegramInbox).create({
          updateId,
          chatId: String(CHAT_ID),
          userId: String(USER_ID),
          text: null,
          callback: JSON.stringify(payload),
          receivedAt: RECEIVED_AT,
          state: 'accepted',
        }),
      );
    }
    await telegram.start();
    await waitUntil(() => client.offsets.length >= 2);

    expect(routed).toHaveLength(0);
    expect(client.acks).toHaveLength(0);
    expect(client.sent).toHaveLength(0);
  });

  it('una pulsacion con mensaje inaccesible (date 0) no se enruta', async () => {
    // El mensaje del bot no tiene una fecha creible: no es una entrega real y la
    // pulsacion no llega ni a enrutarse.
    const parsed = parseTelegramUpdate({
      update_id: 36,
      callback_query: {
        id: 'cb-36',
        from: { id: USER_ID, is_bot: false },
        data: 'accion:si',
        message: { message_id: 1001, date: 0, chat: { id: CHAT_ID, type: 'private' } },
      },
    });
    expect(parsed?.callback?.inline).toBe(true);
    expect(parsed?.callback?.messageId).toBe(1001);

    client.enqueue(callbackUpdate(36, { inline: true }));
    await telegram.start();
    await waitUntil(() => client.offsets.length >= 2);

    expect(routed).toHaveLength(0);
    expect(client.acks).toHaveLength(0);
    const inbox = await database.dataSource.getRepository(TelegramInbox).find();
    expect(inbox).toHaveLength(0);
  });

  it('una pulsacion sin entrega inequivoca no se enruta', async () => {
    // Dos entregas enviadas con el mismo id de mensaje: no hay entrega unica.
    for (const updateId of [40, 41]) {
      await database.dataSource.getRepository(TelegramOutbox).save(
        database.dataSource.getRepository(TelegramOutbox).create({
          updateId,
          chatId: String(CHAT_ID),
          userId: String(USER_ID),
          text: 'respuesta con botones',
          markup: JSON.stringify(BUTTONS),
          messageId: 1001,
          state: 'sent',
          attempts: 0,
          nextAttemptAt: 0,
          lastError: null,
        }),
      );
    }
    client.enqueue(callbackUpdate(42));
    await telegram.start();
    await waitUntil(() => client.acks.length === 1);

    expect(routed).toHaveLength(0);
    expect(client.acks[0]?.text).toContain('no esta disponible');
  });

  it('el ack se manda despues de cerrar la fila de la pulsacion', async () => {
    let estadoAlConfirmar: string | undefined;
    client.onAck = async () => {
      const inbox = await database.dataSource.getRepository(TelegramInbox).findOneBy({ updateId: 11 });
      estadoAlConfirmar = inbox?.state;
    };
    client.enqueue(messageUpdate(10));
    await telegram.start();
    await waitUntil(() => client.sent.length === 1);
    client.enqueue(callbackUpdate(11, { messageId: 9999 }));
    await waitUntil(() => client.acks.length === 1);

    // La fila ya estaba cerrada cuando se confirmo la pulsacion.
    expect(estadoAlConfirmar).toBe('done');
    client.onAck = undefined;
  });

  it('una pulsacion que llega antes de guardar la entrega espera y se procesa despues', async () => {
    // La escritura de la entrega falla: Telegram ya la confirmo, pero el `sent` aun no
    // esta guardado.
    await database.dataSource.query(
      "CREATE TRIGGER injected BEFORE INSERT ON telegram_history BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    try {
      client.enqueue(messageUpdate(10));
      await telegram.start();
      await waitUntil(() => client.sent.length === 1);

      // La pulsacion llega con la entrega aun sin guardar: no se enruta ni se
      // confirma, y la fila sigue viva.
      client.enqueue(callbackUpdate(11));
      await waitUntil(() => client.offsets.length >= 3);
      expect(routed).toHaveLength(0);
      expect(client.acks).toHaveLength(0);
      const pendiente = await database.dataSource.getRepository(TelegramInbox).findOneBy({
        updateId: 11,
      });
      expect(pendiente?.state).toBe('accepted');

      // Se libera la escritura: la entrega se guarda y la pulsacion se procesa una vez.
      await database.dataSource.query('DROP TRIGGER IF EXISTS injected');
      await waitUntil(() => routed.length === 1, 30_000);
      await waitUntil(() => client.acks.length === 1, 30_000);
      expect(routed[0]).toMatchObject({ updateId: 11, deliveryUpdateId: 10, messageId: 1001 });
      // El mensaje no se reenvia: solo se guarda lo que ya habia salido.
      expect(client.sent).toHaveLength(1);
      const entrega = await database.dataSource.getRepository(TelegramOutbox).findOneBy({
        updateId: 10,
      });
      expect(entrega?.state).toBe('sent');
      expect(entrega?.messageId).toBe(1001);
    } finally {
      await database.dataSource.query('DROP TRIGGER IF EXISTS injected');
    }
  });
});
