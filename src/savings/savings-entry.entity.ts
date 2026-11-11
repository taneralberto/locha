import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Account } from '../accounts/account.entity';
import { Currency } from '../domain/money';
import { Goal, savingsMinorTransformer } from './goal.entity';

/** Historial append-only virtual: no crea movimientos financieros. */
@Entity('savings_entry')
export class SavingsEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true })
  sourceKey!: string;

  @Column({ type: 'varchar' })
  kind!: 'reserve' | 'release';

  @Column({ type: 'varchar' })
  accountId!: string;

  @ManyToOne(() => Account, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'accountId' })
  account!: Account;

  @Column({ type: 'varchar' })
  goalId!: string;

  @ManyToOne(() => Goal, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'goalId' })
  goal!: Goal;

  @Column({ type: 'varchar' })
  currency!: Currency;

  @Column({ type: 'text', transformer: savingsMinorTransformer })
  amountMinor!: bigint;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;
}
