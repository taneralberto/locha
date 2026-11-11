import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, ValueTransformer } from 'typeorm';
import { Currency } from '../domain/money';

const minorTransformer: ValueTransformer = {
  to: (value: bigint): string => value.toString(),
  from: (value: string): bigint => BigInt(value),
};

/** Delta fijo calculado al conciliar: actividad retroactiva posterior puede causar deriva. */
@Entity('balance_reconciliation')
export class BalanceReconciliation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true })
  sourceKey!: string;

  @Column({ type: 'varchar' })
  accountId!: string;

  @Column({ type: 'varchar' })
  currency!: Currency;

  @Column({ type: 'text', transformer: minorTransformer })
  targetMinor!: bigint;

  @Column({ type: 'text', transformer: minorTransformer })
  beforeMinor!: bigint;

  @Column({ type: 'text', transformer: minorTransformer })
  deltaMinor!: bigint;

  @Column({ type: 'text' })
  occurredOn!: string;

  @Column({ type: 'varchar', length: '280' })
  reason!: string;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;
}
