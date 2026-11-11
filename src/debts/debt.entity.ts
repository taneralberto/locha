import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, ValueTransformer } from 'typeorm';
import { Currency } from '../domain/money';

export const debtMinorTransformer: ValueTransformer = {
  to: (value: bigint): string => value.toString(),
  from: (value: string): bigint => BigInt(value),
};

/** `payable` es lo que se debe; `receivable` es lo que nos deben. No distingue origen. */
export type DebtDirection = 'payable' | 'receivable';

/**
 * Obligacion de seguimiento: no es un movimiento ni una cuenta. El principal se
 * guarda como texto en unidades menores para no perder precision con importes grandes.
 */
@Entity('debt')
export class Debt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Clave idempotente externa; identifica la obligacion y no cambia nunca. */
  @Column({ type: 'varchar', unique: true })
  sourceKey!: string;

  @Column({ type: 'varchar' })
  direction!: DebtDirection;

  /** Forma mostrada de la contraparte. La canonica se deriva al comparar. */
  @Column({ type: 'varchar', length: '120' })
  counterparty!: string;

  @Column({ type: 'varchar' })
  currency!: Currency;

  @Column({ type: 'text', transformer: debtMinorTransformer })
  principalMinor!: bigint;

  /** Fecha de la obligacion en forma canonica `YYYY-MM-DD` (texto, no numero). */
  @Column({ type: 'text' })
  occurredOn!: string;

  @Column({ type: 'varchar', length: '280', nullable: true })
  description!: string | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;
}
