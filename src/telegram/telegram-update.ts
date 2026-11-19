import { z } from 'zod';

/**
 * Forma de la actualizacion de Telegram que el bot entiende. Es la unica definicion
 * del formato: lo que no encaja se ignora, nunca se procesa a medias.
 */
const TelegramUserSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean().optional(),
});

const TelegramChatSchema = z.object({
  id: z.number().int(),
  type: z.string(),
});

const TelegramMessageSchema = z.object({
  date: z.number().int().optional(),
  chat: TelegramChatSchema,
  from: TelegramUserSchema.optional(),
  text: z.string().optional(),
});

/**
 * El mensaje del bot al que pertenece una pulsacion. Solo se usa su `message_id`
 * (unico dentro del chat) y su chat: el texto no viaja. El id tiene que ser
 * positivo: un id invalido no identifica ninguna entrega.
 */
const TelegramCallbackMessageSchema = z.object({
  message_id: z.number().int().positive(),
  date: z.number().int().optional(),
  chat: TelegramChatSchema,
  from: TelegramUserSchema.optional(),
});

const TelegramCallbackQuerySchema = z.object({
  id: z.string(),
  from: TelegramUserSchema,
  message: TelegramCallbackMessageSchema.optional(),
  inline_message_id: z.string().optional(),
  data: z.string(),
});

const TelegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: TelegramMessageSchema.optional(),
  callback_query: TelegramCallbackQuerySchema.optional(),
});

export interface TelegramMessage {
  chatId: string;
  chatType: string;
  /** Usuario que escribio el mensaje. `null` si el mensaje no tiene autor. */
  userId: string | null;
  /** `true` si el mensaje viene de un bot. */
  isBot: boolean;
  /** Texto del mensaje. `null` si el mensaje no es de texto. */
  text: string | null;
  /** Marca de tiempo del mensaje en ISO. */
  receivedAt: string;
}

export interface TelegramUpdate {
  updateId: number;
  /** Mensaje de la actualizacion. `null` si no es un mensaje (editado, canal, ...). */
  message: TelegramMessage | null;
  /**
   * Pulsacion de un boton. `null` si la actualizacion no es una pulsacion. No la
   * decide el texto: es una estructura propia, con su id de mensaje.
   */
  callback?: TelegramCallback | null;
}

/**
 * Una pulsacion de boton. Solo se acepta si viene de un **mensaje accesible** del
 * bot (no de un mensaje inline): sin mensaje no hay entrega que comprobar.
 */
export interface TelegramCallback {
  /** Identificador de la pulsacion: sirve para confirmarla. */
  callbackId: string;
  /** Datos del boton pulsado. */
  data: string;
  /** Conversacion donde se pulso. */
  chatId: string;
  chatType: string;
  /** Usuario que pulso. `null` si la pulsacion no tiene autor. */
  userId: string | null;
  /** `true` si la pulsacion viene de un bot. */
  isBot: boolean;
  /** Id del mensaje del bot. Es unico **dentro del chat**, no global. */
  messageId: number | null;
  /**
   * `true` si la pulsacion no viene de un mensaje accesible: un mensaje inline, un
   * mensaje sin id o un mensaje con una fecha imposible (`date: 0`). Sin mensaje
   * accesible no hay entrega que comprobar y la pulsacion no se enruta.
   */
  inline: boolean;
  /** Marca de tiempo de la pulsacion en ISO. */
  receivedAt: string;
}

/**
 * Identidad del evento en Telegram: el `update_id` con su prefijo. Es la clave que
 * usa la captura para ligar un evento a su borrador, y la que permite saber de que
 * actualizacion salio un borrador.
 */
export function telegramEventId(updateId: number): string {
  return `telegram:${updateId}`;
}

/**
 * Traduce una actualizacion cruda de Telegram. Devuelve `null` si la actualizacion no
 * tiene forma reconocible: en ese caso se ignora con seguridad, sin guardar nada.
 */
export function parseTelegramUpdate(raw: unknown, now: Date = new Date()): TelegramUpdate | null {
  const parsed = TelegramUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const callback = parsed.data.callback_query;
  if (callback) {
    const message = callback.message;
    const date = message?.date;
    const receivedAt = toIsoInstant(date, now);
    if (receivedAt === null) {
      // Una fecha fuera de rango no invalida el resto del lote: se salta esta entrada.
      return null;
    }
    const chat = message?.chat;
    // Un mensaje inline, sin id o con una fecha imposible (`date: 0`) no es un
    // mensaje accesible: la pulsacion no se puede enrutar a ninguna entrega.
    const accessible = message !== undefined && (date === undefined || date > 0);
    return {
      updateId: parsed.data.update_id,
      message: null,
      callback: {
        callbackId: callback.id,
        data: callback.data,
        chatId: chat ? String(chat.id) : '',
        chatType: chat?.type ?? '',
        userId: callback.from ? String(callback.from.id) : null,
        isBot: callback.from.is_bot === true,
        messageId: message?.message_id ?? null,
        inline: callback.inline_message_id !== undefined || !accessible,
        receivedAt,
      },
    };
  }
  const message = parsed.data.message;
  if (!message) {
    return { updateId: parsed.data.update_id, message: null };
  }
  const receivedAt = toIsoInstant(message.date, now);
  if (receivedAt === null) {
    // Una fecha fuera de rango no invalida el resto del lote: se salta esta entrada.
    return null;
  }
  return {
    updateId: parsed.data.update_id,
    message: {
      chatId: String(message.chat.id),
      chatType: message.chat.type,
      userId: message.from ? String(message.from.id) : null,
      isBot: message.from?.is_bot === true,
      text: typeof message.text === 'string' ? message.text : null,
      receivedAt,
    },
  };
}

/** Rango de fechas que acepta `Date` (en milisegundos desde epoch). */
const MAX_INSTANT_MS = 8.64e15;

/**
 * Instante del mensaje en ISO. Una fecha fuera del rango de `Date` (por ejemplo un
 * numero enorme) no se inventa: se devuelve `null` y la actualizacion se descarta.
 */
function toIsoInstant(seconds: number | undefined, now: Date): string | null {
  if (seconds === undefined) {
    return now.toISOString();
  }
  const milliseconds = seconds * 1000;
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > MAX_INSTANT_MS) {
    return null;
  }
  const instant = new Date(milliseconds);
  if (Number.isNaN(instant.getTime())) {
    return null;
  }
  return instant.toISOString();
}
