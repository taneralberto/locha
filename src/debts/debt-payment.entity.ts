import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Movement } from '../financial/movement.entity';
import { Debt, debtMinorTransformer } from './debt.entity';

/**
 * Pago de una obligacion: liga el movimiento ordinario que lo registra con la deuda
 * que liquida. El vinculo es de una a una con el movimiento original.
 */
@Entity('debt_payment')
export class DebtPayment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Clave idempotente externa del pago. */
  @Column({ type: 'varchar', unique: true })
  sourceKey!: string;

  @Column({ type: 'varchar' })
  debtId!: string;

  @ManyToOne(() => Debt, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'debtId' })
  debt!: Debt;

  /** Movimiento original del pago: nunca se reescribe. */
  @Column({ type: 'varchar', unique: true })
  movementId!: string;

  @ManyToOne(() => Movement, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'movementId' })
  movement!: Movement;

  /** Saldo pendiente que el llamador esperaba antes de este pago. */
  @Column({ type: 'text', transformer: debtMinorTransformer })
  expectedOutstandingMinor!: bigint;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;
}
