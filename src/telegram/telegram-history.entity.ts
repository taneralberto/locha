import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Quien escribio el texto que se guarda: el usuario autorizado o el bot. */
export type TelegramHistoryRole = 'user' | 'bot';

/**
 * Historial temporal del chat privado de Telegram: el texto original del usuario y la
 * respuesta exacta del bot, cada uno con su hora.
 *
 * Es una tabla **aparte** de la bandeja de entrada, de la bandeja de salida y del
 * borrador de captura: el historial no se mezcla con el trabajo pendiente ni con lo
 * que ya ocurrio. Solo guarda lo del chat y del usuario autorizados.
 *
 * La clave es la actualizacion y el rol (`updateId`, `role`): un texto por
 * actualizacion y rol, sin repeticiones. Los tiempos son **numericos** (milisegundos
 * desde epoch) para que la ventana se compare sin interpretar fechas.
 */
@Entity('telegram_history')
export class TelegramHistory {
  /** Actualizacion de Telegram a la que pertenece la entrada. */
  @PrimaryColumn({ type: 'integer' })
  updateId!: number;

  /** Quien escribio el texto. */
  @PrimaryColumn({ type: 'varchar' })
  role!: TelegramHistoryRole;

  /** Conversacion privada donde ocurrio. */
  @Column({ type: 'varchar' })
  chatId!: string;

  /** Usuario autorizado de la conversacion. */
  @Column({ type: 'varchar' })
  userId!: string;

  /** Texto original del mensaje del usuario, o respuesta exacta del bot. */
  @Column({ type: 'text' })
  text!: string;

  /** Instante del mensaje, en milisegundos desde epoch. */
  @Column({ type: 'integer' })
  sentAt!: number;
}
