import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { Currency } from '../domain/money';

@Entity('account')
export class Account {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true })
  name!: string;

  @Column({ type: 'varchar' })
  currency!: Currency;

  @Column({ type: 'boolean', default: true })
  active!: boolean;
}
