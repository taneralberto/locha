import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, ValueTransformer } from 'typeorm';
import { Currency } from '../domain/money';

const minorTransformer: ValueTransformer = {
  to: (value: bigint): string => value.toString(),
  from: (value: string): bigint => BigInt(value),
};

/** Definicion inmutable; el consumo se deriva de los gastos efectivos, no se persiste. */
@Entity('budget')
export class Budget {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true })
  sourceKey!: string;

  @Column({ type: 'varchar', length: '80' })
  name!: string;

  @Column({ type: 'varchar' })
  currency!: Currency;

  @Column({ type: 'text', transformer: minorTransformer })
  limitMinor!: bigint;

  @Column({ type: 'varchar', length: '80', nullable: true })
  category!: string | null;

  @Column({ type: 'text' })
  startsOn!: string;

  @Column({ type: 'text' })
  endsOn!: string;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;
}
