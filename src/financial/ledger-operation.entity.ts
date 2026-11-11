import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, ValueTransformer } from 'typeorm';
import { Currency } from '../domain/money';

const minorTransformer: ValueTransformer = {
  to: (value: bigint | null): string | null => value === null ? null : value.toString(),
  from: (value: string | null): bigint | null => value === null ? null : BigInt(value),
};

/** Aperturas y transferencias son aditivas; nunca reescriben movimientos historicos. */
@Entity('ledger_operation')
export class LedgerOperation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true })
  sourceKey!: string;

  @Column({ type: 'varchar' })
  kind!: 'opening' | 'transfer';

  @Column({ type: 'varchar' })
  accountId!: string;

  @Column({ type: 'varchar' })
  currency!: Currency;

  @Column({ type: 'text', transformer: minorTransformer })
  deltaMinor!: bigint;

  @Column({ type: 'varchar', nullable: true })
  destinationAccountId!: string | null;

  @Column({ type: 'varchar', nullable: true })
  destinationCurrency!: Currency | null;

  @Column({ type: 'text', nullable: true, transformer: minorTransformer })
  destinationDeltaMinor!: bigint | null;

  @Column({ type: 'varchar', nullable: true, unique: true })
  feeMovementId!: string | null;

  @Column({ type: 'text' })
  occurredOn!: string;

  @Column({ type: 'varchar', length: '280', nullable: true })
  description!: string | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;
}
