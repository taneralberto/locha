import { TelegramSettings } from '../config/configuration';
import { boundedFetch, BoundedFetchError, BoundedFetchOptions } from '../http/bounded-fetch';
import { inlineKeyboard, TelegramButtonRows } from './telegram-buttons';
import { parseTelegramUpdate, TelegramUpdate } from './telegram-update';

const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';

/** Tipos de actualizacion que el bot pide a Telegram. */
const ALLOWED_UPDATES = ['message', 'callback_query'] as const;

/**
 * Plazo propio de la confirmacion de una pulsacion: es una llamada corta y no debe
 * esperar como el sondeo largo.
 */
const ACK_TIMEOUT_MS = 2_000;

export type TelegramFailure = 'timeout' | 'network' | 'http' | 'invalid' | 'cancelled';

/**
 * Fallo de la API de Telegram. El motivo no incluye la URL (donde viaja la
 * credencial) ni el contenido de la respuesta.
 */
export class TelegramError extends Error {
  constructor(
    readonly reason: TelegramFailure,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

/**
 * Cliente de la API de Telegram. La implementacion real habla por HTTPS con la API
 * oficial; las pruebas pueden sustituirla por un doble.
 */
export abstract class TelegramClient {
  /**
   * Devuelve las actualizaciones posteriores a `offset`. `timeoutSeconds` es la
   * espera maxima del long polling en el lado de Telegram. `signal` cancela la
   * consulta en vuelo (por ejemplo, al apagar el bot).
   */
  abstract getUpdates(
    offset: number,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]>;

  /**
   * Envia un mensaje de texto a un chat y devuelve el **id del mensaje** que creo
   * Telegram. Ese id es unico dentro del chat: es la evidencia de que una pulsacion
   * viene de este mensaje y no de otro.
   */
  abstract sendMessage(
    chatId: string,
    text: string,
    options?: { buttons?: TelegramButtonRows; signal?: AbortSignal },
  ): Promise<number>;

  /**
   * Confirma una pulsacion de boton. Es una alerta breve de Telegram: **no** envia
   * ningun texto al chat.
   */
  abstract answerCallbackQuery(
    callbackId: string,
    text: string | null,
    showAlert: boolean,
    signal?: AbortSignal,
  ): Promise<void>;
}

/**
 * Cliente real de la API de Telegram. Toda llamada esta acotada en tiempo y en
 * tamano, y la credencial solo viaja en la URL: nunca se registra.
 */
export class TelegramApiClient extends TelegramClient {
  constructor(
    private readonly settings: TelegramSettings,
    private readonly baseUrl: string = TELEGRAM_API_BASE_URL,
  ) {
    super();
  }

  async getUpdates(
    offset: number,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    const envelope = await this.call(
      'getUpdates',
      {
        offset: String(offset),
        timeout: String(timeoutSeconds),
        // Solo se piden los dos tipos de actualizacion que el bot entiende: mensajes y
        // pulsaciones de boton.
        allowed_updates: JSON.stringify(ALLOWED_UPDATES),
      },
      undefined,
      signal,
    );
    const result = envelope.result;
    if (!Array.isArray(result)) {
      throw new TelegramError('invalid', 'La respuesta de Telegram no tiene la forma esperada.');
    }
    const updates: TelegramUpdate[] = [];
    for (const raw of result) {
      // Una actualizacion con una forma inesperada se salta: no invalida el resto.
      const update = parseTelegramUpdate(raw);
      if (update) {
        updates.push(update);
      }
    }
    return updates;
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: { buttons?: TelegramButtonRows; signal?: AbortSignal },
  ): Promise<number> {
    const buttons = options?.buttons ?? [];
    const body: Record<string, unknown> = { chat_id: chatIdForApi(chatId), text };
    if (buttons.length > 0) {
      body['reply_markup'] = inlineKeyboard(buttons);
    }
    const envelope = await this.call(
      'sendMessage',
      undefined,
      JSON.stringify(body),
      options?.signal,
    );
    // La API responde 200 incluso cuando no envia: hay que comprobar el sobre.
    const result = envelope.result;
    if (typeof result !== 'object' || result === null) {
      throw new TelegramError('invalid', 'Telegram no confirmo el envio del mensaje.');
    }
    const messageId = (result as { message_id?: unknown }).message_id;
    if (typeof messageId !== 'number' || !Number.isInteger(messageId)) {
      throw new TelegramError('invalid', 'Telegram no confirmo el envio del mensaje.');
    }
    return messageId;
  }

  async answerCallbackQuery(
    callbackId: string,
    text: string | null,
    showAlert: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const envelope = await this.call(
      'answerCallbackQuery',
      {
        callback_query_id: callbackId,
        ...(text === null ? {} : { text }),
        show_alert: showAlert ? 'true' : 'false',
      },
      undefined,
      signal,
      // La confirmacion de una pulsacion tiene su propio plazo corto: no espera
      // como el sondeo.
      ACK_TIMEOUT_MS,
    );
    if (envelope.result !== true) {
      throw new TelegramError('invalid', 'Telegram no confirmo la pulsacion.');
    }
  }

  private async call(
    method: string,
    query?: Record<string, string>,
    body?: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; result?: unknown }> {
    const url = new URL(`${this.baseUrl}/bot${this.settings.botToken}/${method}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    try {
      const options: BoundedFetchOptions = {
        url: url.toString(),
        method: body === undefined ? 'GET' : 'POST',
        timeoutMs: timeoutMs ?? this.effectiveTimeoutMs(),
        maxResponseBytes: this.settings.maxResponseBytes,
      };
      if (body !== undefined) {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = body;
      }
      if (signal) {
        options.signal = signal;
      }
      const response = await boundedFetch(options);
      return parseEnvelope(response.text);
    } catch (error) {
      throw toTelegramError(error);
    }
  }

  /**
   * El plazo de la llamada debe ser mayor que la espera del long polling: si no, se
   * cortaria la consulta antes de que Telegram conteste.
   */
  private effectiveTimeoutMs(): number {
    return Math.max(this.settings.timeoutMs, (this.settings.pollTimeoutSeconds + 1) * 1000);
  }
}

/**
 * Sobre de la API de Telegram. La API responde 200 con `ok: true` cuando la
 * operacion se hizo: un `ok: false` o un cuerpo que no es JSON son un fallo.
 */
function parseEnvelope(payload: string): { ok: boolean; result?: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new TelegramError('invalid', 'La respuesta de Telegram no es JSON valido.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new TelegramError('invalid', 'La respuesta de Telegram no tiene la forma esperada.');
  }
  const envelope = parsed as { ok?: unknown; result?: unknown };
  if (envelope.ok !== true) {
    throw new TelegramError('invalid', 'Telegram no confirmo la operacion.');
  }
  return { ok: true, result: envelope.result };
}

/** El id del chat se envia como numero cuando es numerico (la API lo espera asi). */
function chatIdForApi(chatId: string): string | number {
  return /^-?\d+$/.test(chatId) ? Number(chatId) : chatId;
}

function toTelegramError(error: unknown): TelegramError {
  if (error instanceof TelegramError) {
    return error;
  }
  if (error instanceof BoundedFetchError) {
    if (error.reason === 'timeout') {
      return new TelegramError('timeout', 'Telegram no respondio a tiempo.');
    }
    if (error.reason === 'cancelled') {
      return new TelegramError('cancelled', 'La llamada a Telegram fue cancelada.');
    }
    if (error.reason === 'http') {
      return new TelegramError('http', `Telegram respondio con estado ${error.status}.`, error.status);
    }
    if (error.reason === 'too_large') {
      return new TelegramError('invalid', 'La respuesta de Telegram excede el limite permitido.');
    }
  }
  return new TelegramError('network', 'No se pudo completar la llamada a Telegram.');
}
