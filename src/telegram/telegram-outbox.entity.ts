import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type TelegramOutboxState = 'pending' | 'sent' | 'discarded';

/**
 * Bandeja de salida durable: la respuesta al usuario se escribe aqui antes de enviarse.
 * Si el envio falla, la respuesta queda pendiente y se reintenta mas tarde, sin
 * perderla. Un envio que se interrumpe puede repetir la respuesta (al menos una vez),
 * pero nunca duplica un movimiento: el registro depende del evento, no del envio.
 */
@Entity('telegram_outbox')
export class TelegramOutbox {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Actualizacion a la que responde esta entrega: una respuesta por actualizacion. */
  @Column({ type: 'integer', unique: true })
  updateId!: number;

  @Column({ type: 'varchar' })
  chatId!: string;

  /** Usuario al que se responde: se comprueba contra la lista vigente al enviar. */
  @Column({ type: 'varchar' })
  userId!: string;

  /** Texto de la respuesta al usuario. */
  @Column({ type: 'text' })
  text!: string;

  /**
   * Teclado inline de la respuesta, en JSON. `null` si la respuesta no lleva
   * botones. Viaja con el texto: lo que sale al chat es el texto **y** su teclado.
   */
  @Column({ type: 'text', nullable: true })
  markup!: string | null;

  /**
   * Id del mensaje creado en Telegram. Es unico **dentro del chat**: junto con el
   * chat identifica la entrega exacta de un boton pulsado. `null` mientras no se ha
   * enviado.
   */
  @Column({ type: 'integer', nullable: true })
  messageId!: number | null;

  /** `pending` si aun no se envio; `sent` si ya salio; `discarded` si ya no se puede enviar. */
  @Column({ type: 'varchar' })
  state!: TelegramOutboxState;

  /** Intentos de envio ya realizados. */
  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  /** Momento en el que se puede volver a intentar (marca de tiempo). */
  @Column({ type: 'integer', default: 0 })
  nextAttemptAt!: number;

  /** Motivo del ultimo fallo, sin detalle: nunca contiene la credencial. */
  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
