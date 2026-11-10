import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Cursor del polling. Guarda el `update_id` mas alto que ya se acepto o se ignoro de
 * forma durable. El cursor solo avanza despues de aceptar o ignorar una
 * actualizacion: nunca se salta una.
 */
@Entity('telegram_cursor')
export class TelegramCursor {
  /** Identificador del cursor. Solo hay uno: `polling`. */
  @PrimaryColumn({ type: 'varchar' })
  id!: string;

  /** Ultimo `update_id` aceptado o ignorado. */
  @Column({ type: 'integer', default: 0 })
  lastUpdateId!: number;
}

/** Identificador de la unica fila del cursor. */
export const POLLING_CURSOR_ID = 'polling';
