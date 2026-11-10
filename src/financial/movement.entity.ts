import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, ValueTransformer } from 'typeorm';
import { Currency } from '../domain/money';

export type MovementKind = 'income' | 'expense';

/**
 * El importe se guarda como texto en unidades menores: SQLite y JavaScript perderian
 * precision con enteros grandes si se usara un numero.
 */
const amountMinorTransformer: ValueTransformer = {
  to: (value: bigint): string => value.toString(),
  from: (value: string): bigint => BigInt(value),
};

@Entity('movement')
export class Movement {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Clave idempotente externa (por ejemplo, el identificador de un mensaje de Telegram). */
  @Column({ type: 'varchar', unique: true })
  sourceKey!: string;

  /** Referencia a `account.id`. La clave foranea la define la migracion inicial. */
  @Column({ type: 'varchar' })
  accountId!: string;

  @Column({ type: 'varchar' })
  kind!: MovementKind;

  @Column({ type: 'text', transformer: amountMinorTransformer })
  amountMinor!: bigint;

  @Column({ type: 'varchar' })
  currency!: Currency;

  /** Fecha de la operacion en forma canonica `YYYY-MM-DD` (texto, no numero). */
  @Column({ type: 'text' })
  occurredOn!: string;

  @Column({ type: 'varchar', length: '280', nullable: true })
  description!: string | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;
}
