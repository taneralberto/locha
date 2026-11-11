import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, ValueTransformer } from 'typeorm';
import { Currency } from '../domain/money';

export const savingsMinorTransformer: ValueTransformer = {
  to: (value: bigint): string => value.toString(),
  from: (value: string): bigint => BigInt(value),
};

/** Definicion inmutable de una meta nominal, no una garantia de fondos. */
@Entity('goal')
export class Goal {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true })
  sourceKey!: string;

  @Column({ type: 'varchar', length: '80' })
  name!: string;

  @Column({ type: 'varchar' })
  currency!: Currency;

  @Column({ type: 'text', transformer: savingsMinorTransformer })
  targetMinor!: bigint;

  @Column({ type: 'text', nullable: true })
  targetOn!: string | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;
}
