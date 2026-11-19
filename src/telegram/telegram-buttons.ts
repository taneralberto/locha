/**
 * Botones inline de una respuesta de Telegram.
 *
 * Los **datos** del callback (`callback_data`) son opacos: no son una autoridad sobre
 * el objetivo de la pulsacion. La autoridad la tiene el transporte, que comprueba que
 * el boton pulsado es exactamente uno de una entrega ya enviada al mismo chat.
 */

/** Un boton inline: su texto visible y los datos del callback. */
export interface TelegramButton {
  /** Texto visible del boton. */
  text: string;
  /** Datos del callback: de 1 a 64 bytes UTF-8. */
  data: string;
}

/** Botones por filas: cada fila es una linea del teclado. */
export type TelegramButtonRows = TelegramButton[][];

/** Limite de Telegram para `callback_data`: de 1 a 64 bytes UTF-8. */
export const MAX_CALLBACK_DATA_BYTES = 64;

/**
 * Un boton que no cabe en el contrato de Telegram. El mensaje **no** incluye los
 * datos del boton: pueden llevar algo que no debe salir en un registro.
 */
export class TelegramButtonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramButtonError';
  }
}

/**
 * `true` si los datos de un callback caben en el contrato de Telegram: de 1 a 64
 * bytes UTF-8. Es la misma regla que usa el boton al salir, y la que se comprueba al
 * leer una pulsacion guardada.
 */
export function isValidCallbackData(data: unknown): data is string {
  if (typeof data !== 'string') {
    return false;
  }
  const bytes = Buffer.byteLength(data, 'utf8');
  return bytes >= 1 && bytes <= MAX_CALLBACK_DATA_BYTES;
}

/**
 * Valida un boton: el texto no vacio y los datos de 1 a 64 bytes UTF-8. Devuelve el
 * boton ya validado.
 */
export function validateButton(button: TelegramButton): TelegramButton {
  if (typeof button.text !== 'string' || button.text.trim().length === 0) {
    throw new TelegramButtonError('El boton necesita un texto.');
  }
  if (!isValidCallbackData(button.data)) {
    throw new TelegramButtonError(
      `Los datos del boton deben ocupar de 1 a ${MAX_CALLBACK_DATA_BYTES} bytes.`,
    );
  }
  return { text: button.text, data: button.data };
}

/** Valida todas las filas del teclado. */
export function validateButtons(rows: TelegramButtonRows): TelegramButtonRows {
  return rows.map((row) => row.map((button) => validateButton(button)));
}

/**
 * Serializa el teclado para la bandeja de salida. `null` si no hay botones: la
 * columna queda vacia y el mensaje sale sin teclado.
 */
export function serializeButtons(rows: TelegramButtonRows | null | undefined): string | null {
  if (!rows || rows.length === 0) {
    return null;
  }
  return JSON.stringify(validateButtons(rows));
}

/**
 * Lee el teclado de la bandeja de salida. `null` si no hay teclado o si esta roto:
 * un teclado ilegible se trata como si no hubiera botones (nunca se envia medio
 * teclado).
 */
export function parseButtons(markup: string | null | undefined): TelegramButtonRows | null {
  if (markup === null || markup === undefined || markup.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(markup);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  try {
    return validateButtons(parsed as TelegramButtonRows);
  } catch {
    return null;
  }
}

/** El teclado en el formato que espera la API de Telegram. */
export interface InlineKeyboardMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

/** Convierte el teclado al formato de la API. */
export function inlineKeyboard(rows: TelegramButtonRows): InlineKeyboardMarkup {
  return {
    inline_keyboard: validateButtons(rows).map((row) =>
      row.map((button) => ({ text: button.text, callback_data: button.data })),
    ),
  };
}
