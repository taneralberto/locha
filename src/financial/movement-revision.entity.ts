import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, ValueTransformer } from 'typeorm';

const minorTransformer: ValueTransformer = {
  to: (value: bigint | null): string | null => value === null ? null : value.toString(),
  from: (value: string | null): bigint | null => value === null ? null : BigInt(value),
};

/** Cada edicion conserva una instantanea completa; la anulacion es terminal. */
@Entity('movement_revision')
export class MovementRevision {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true })
  sourceKey!: string;

  @Column({ type: 'varchar' })
  movementId!: string;

  @Column({ type: 'integer' })
  revision!: number;

  @Column({ type: 'integer' })
  expectedRevision!: number;

  @Column({ type: 'varchar' })
  kind!: 'edit' | 'void';

  @Column({ type: 'varchar', length: '280' })
  reason!: string;

  @Column({ type: 'text', nullable: true, transformer: minorTransformer })
  amountMinor!: bigint | null;

  @Column({ type: 'text', nullable: true })
  occurredOn!: string | null;

  @Column({ type: 'varchar', length: '280', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', length: '80', nullable: true })
  category!: string | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;
}
