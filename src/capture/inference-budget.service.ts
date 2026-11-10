import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AiLimits } from '../config/configuration';
import { TransactionRunner } from '../data/transaction.runner';
import { dateInTimeZone } from '../domain/date';
import { AiUsageDay } from './ai-usage.entity';

/** Zona horaria del usuario: define el dia de consumo y la fecha por defecto de las operaciones. */
export const DEFAULT_TIME_ZONE = 'America/Caracas';

/** El dia de consumo ya no alcanza: no se llama al proveedor. */
export class BudgetExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExhaustedError';
  }
}

/**
 * Reserva diaria de inferencia. Antes de cada llamada se reserva el maximo configured
 * (una peticion, los tokens de entrada y salida y el costo maximo por llamada). La
 * reserva es conservadora y no se devuelve si la llamada falla: ante la duda se gasta
 * menos, nunca mas.
 *
 * El allowance local no es una garantia de la factura del proveedor: el operador debe
 * ademas fijar un limite de gasto en su cuenta de OpenRouter.
 */
@Injectable()
export class InferenceBudgetService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly transactions: TransactionRunner,
    private readonly limits: AiLimits,
  ) {}

  /** Reserva consumo para una llamada. Falla cerrado si el dia ya no alcanza. */
  async reserve(): Promise<void> {
    const day = dateInTimeZone(new Date(), DEFAULT_TIME_ZONE);
    await this.transactions.run(async (manager) => {
      const repository = manager.getRepository(AiUsageDay);
      const row = (await repository.findOneBy({ day })) ?? repository.create({
        day,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        costMicroUsd: 0,
      });
      if (row.requests + 1 > this.limits.maxRequestsPerDay) {
        throw new BudgetExhaustedError(
          `Se alcanzo el limite de ${this.limits.maxRequestsPerDay} llamadas por dia.`,
        );
      }
      if (row.costMicroUsd + this.limits.maxCostMicroUsdPerCall > this.limits.dailyBudgetMicroUsd) {
        throw new BudgetExhaustedError(
          `Se alcanzo el presupuesto diario de ${this.limits.dailyBudgetMicroUsd} microUSD.`,
        );
      }
      row.requests += 1;
      row.inputTokens += this.limits.maxInputTokensPerCall;
      row.outputTokens += this.limits.maxOutputTokensPerCall;
      row.costMicroUsd += this.limits.maxCostMicroUsdPerCall;
      await repository.save(row);
    });
  }

  /** Consumo reservado del dia en curso. */
  async current(): Promise<AiUsageDay | null> {
    const day = dateInTimeZone(new Date(), DEFAULT_TIME_ZONE);
    return this.dataSource.getRepository(AiUsageDay).findOneBy({ day });
  }
}
