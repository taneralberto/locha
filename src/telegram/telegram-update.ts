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

const TelegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: TelegramMessageSchema.optional(),
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
