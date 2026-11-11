import { createHash } from 'node:crypto';

/**
 * Clave idempotente del movimiento: la misma conversacion y evento dan la misma clave.
 * El separador se escribe como escape de texto (`\0`) para que el archivo fuente no
 * contenga un byte de control literal; en tiempo de ejecucion es el mismo separador.
 *
 * Vive en su propio modulo porque la clave es la **identidad** de un borrador: el
 * transporte la usa para saber de que evento de Telegram salio, y la captura la usa
 * para ligar el borrador al evento que lo creo.
 */
export function sourceKeyFor(chatId: string, eventId: string): string {
  const hash = createHash('sha256').update(`${chatId}\0${eventId}`).digest('hex');
  return `capture:${hash}`;
}
