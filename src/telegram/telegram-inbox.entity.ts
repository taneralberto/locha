import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export type TelegramInboxState = 'accepted' | 'done' | 'discarded';

/**
 * Bandeja de entrada durable de Telegram. Cada actualizacion aceptada (autorizada y de
 * texto) se guarda con su `update_id` unico: al reiniciar, lo que quedo a medias se
 * vuelve a procesar sin volver a interpretarlo.
 *
 * El texto original solo se conserva mientras la actualizacion no esta procesada.
 */
@Entity('telegram_inbox')
export class TelegramInbox {
  /** Identificador de la actualizacion en Telegram: es la clave del evento. */
  @PrimaryColumn({ type: 'integer' })
  updateId!: number;

  /** Conversacion privada donde llego el mensaje. */
  @Column({ type: 'varchar' })
  chatId!: string;

  /** Usuario autorizado que escribio el mensaje. */
  @Column({ type: 'varchar' })
  userId!: string;

  /** Texto original del mensaje (acotado). Se borra cuando la actualizacion se procesa. */
  @Column({ type: 'text', nullable: true })
  text!: string | null;

  /** Marca de tiempo del mensaje (ISO). Es la fecha por defecto de la operacion. */
  @Column({ type: 'varchar' })
  receivedAt!: string;

  /**
   * `accepted` si todavia no se proceso; `done` cuando ya tiene respuesta;
   * `discarded` cuando ya no se puede procesar (el chat o el usuario dejo de estar
   * autorizado) y su texto se borro.
   */
  @Column({ type: 'varchar' })
  state!: TelegramInboxState;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
