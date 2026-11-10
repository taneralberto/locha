import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { CaptureState } from './capture.entity';

export type CaptureEventState = 'processing' | 'completed' | 'uncertain';

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

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
