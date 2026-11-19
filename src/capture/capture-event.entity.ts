import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { CaptureState } from './capture.entity';

/**
 * Estado del evento en la captura.
 *
 * - `processing`: la interpretacion esta en curso.
 * - `reading`: la consulta de seguimiento esta leyendo el contexto del chat.
 * - `completed`: la respuesta esta guardada y se reproduce identica.
 * - `uncertain`: la interpretacion fallo y no se reintenta sola.
 */
export type CaptureEventState = 'processing' | 'reading' | 'completed' | 'uncertain';

/**
 * Bandeja de entrada durable de los eventos del transporte. La identidad del evento la
 * entrega la fuente autorizada (por ejemplo, el `update_id` de Telegram): repetir el
 * mismo evento reproduce la respuesta guardada, sin volver a interpretar ni gastar.
 */
@Entity('capture_event')
export class CaptureEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Identificador del evento en el transporte. */
  @Column({ type: 'varchar' })
  eventId!: string;

  /** Conversacion (chat o canal) del evento. */
  @Column({ type: 'varchar' })
  chatId!: string;

  @Column({ type: 'varchar' })
  state!: CaptureEventState;

  /** Respuesta durable: se reproduce identica cuando el mismo evento se reenvia. */
  @Column({ type: 'text', nullable: true })
  reply!: string | null;

  /** Estado del borrador de la conversacion despues de atender el evento. */
  @Column({ type: 'varchar', nullable: true })
  captureState!: CaptureState | null;

  /** Movimiento registrado por este evento, si hubo. */
  @Column({ type: 'varchar', nullable: true })
  movementId!: string | null;

  /**
   * Metadatos del evento, en JSON: que se puede hacer con el y desde donde.
   *
   * Van **con la respuesta**: se guardan en la misma transaccion, para que el menu
   * de una fase se pueda reproducir tal cual estaba, sin reconstruirlo con los datos
   * de ahora. `null` si el evento no ofrece nada.
   */
  @Column({ type: 'text', nullable: true })
  metadata!: string | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
