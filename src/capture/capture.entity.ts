import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Currency } from '../domain/money';

export type CaptureState =
  | 'awaiting_details'
  | 'awaiting_confirmation'
  | 'registered'
  | 'cancelled'
  | 'unsupported';

/** Tipo de operacion del borrador: ademas de gasto e ingreso, las deudas. */
export type CaptureKind = 'income' | 'expense' | 'debt_create' | 'debt_settle';

/**
 * Borrador durable de una operacion por conversacion. Solo hay un borrador vivo
 * (`awaiting_*`) por chat: lo garantiza el indice unico parcial de la migracion.
 * El `sourceKey` es el del movimiento que se registrara al confirmar y no cambia aunque
 * el borrador se corrija.
 */
@Entity('capture')
export class Capture {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Conversacion (chat o canal) a la que pertenece el borrador. */
  @Column({ type: 'varchar' })
  chatId!: string;

  /** Clave idempotente del movimiento que se registrara al confirmar. */
  @Column({ type: 'varchar' })
  sourceKey!: string;

  @Column({ type: 'varchar' })
  state!: CaptureState;

  @Column({ type: 'varchar', nullable: true })
  kind!: CaptureKind | null;

  /** Importe en decimal exacto de la moneda, como texto. */
  @Column({ type: 'varchar', nullable: true })
  amount!: string | null;

  @Column({ type: 'varchar', nullable: true })
  currency!: Currency | null;

  @Column({ type: 'varchar', nullable: true })
  accountId!: string | null;

  @Column({ type: 'text', nullable: true })
  occurredOn!: string | null;

  @Column({ type: 'varchar', length: '280', nullable: true })
  description!: string | null;

  /**
   * Datos de deuda del borrador, en JSON. Solo se usa cuando `kind` es `debt_create` o
   * `debt_settle`; en los demas borradores queda en `null`.
   */
  @Column({ type: 'text', nullable: true })
  debtPayload!: string | null;

  /** Texto original del mensaje: solo se conserva mientras el borrador esta vivo. */
  @Column({ type: 'text', nullable: true })
  sourceText!: string | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
