import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Consumo reservado de inferencia por dia. Es una reserva conservadora: se guarda lo
 * que se permitio gastar, no lo que el proveedor cobro. El allowance local no es una
 * garantia de la factura del proveedor.
 */
@Entity('ai_usage_day')
export class AiUsageDay {
  /** Dia en la zona del usuario (`YYYY-MM-DD`). */
  @PrimaryColumn({ type: 'varchar' })
  day!: string;

  @Column({ type: 'integer', default: 0 })
  requests!: number;

  @Column({ type: 'integer', default: 0 })
  inputTokens!: number;

  @Column({ type: 'integer', default: 0 })
  outputTokens!: number;

  /** Costo reservado, en microUSD (1 USD = 1_000_000 microUSD). */
  @Column({ type: 'integer', default: 0 })
  costMicroUsd!: number;
}
