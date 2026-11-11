import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { TransactionRunner } from '../data/transaction.runner';
import { isUniqueViolation } from '../data/unique-violation';
import { dateInTimeZone, parseDate } from '../domain/date';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import { Currency, isCurrency } from '../domain/money';
import { FinancialService } from '../financial/financial.service';
import { Budget } from './budget.entity';

export interface CreateBudgetInput {
  sourceKey: string;
  name: string;
  currency: Currency;
  limitMinor: bigint;
  category?: string | null | undefined;
  startsOn: string;
  endsOn: string;
}

export interface BudgetStatus {
  budget: Budget;
  asOf: string;
  spent: bigint;
  remaining: bigint;
  overspent: boolean;
}

type BudgetPayload = Omit<Budget, 'id' | 'createdAt'>;

@Injectable()
export class BudgetService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly financial: FinancialService,
  ) {}

  async create(input: CreateBudgetInput, manager?: EntityManager): Promise<{ budget: Budget; created: boolean }> {
    const normalized = normalizeBudget(input);
    const save = async (em: EntityManager) => {
      const repository = em.getRepository(Budget);
      const existing = await repository.findOneBy({ sourceKey: normalized.sourceKey });
      if (existing) {
        if (!samePayload(existing, normalized)) {
          throw new ConflictError(`La clave "${normalized.sourceKey}" ya existe con otro contenido.`);
        }
        // Resolver replay antes de validar solapamientos, incluida su propia definicion.
        return { budget: existing, created: false };
      }
      const definitions = await this.list(em);
      if (definitions.some((row) => row.currency === normalized.currency && row.category === normalized.category &&
        row.startsOn <= normalized.endsOn && row.endsOn >= normalized.startsOn)) {
        throw new ConflictError('Ya existe un presupuesto solapado para esa moneda y alcance.');
      }
      try {
        return { budget: await repository.save(repository.create(normalized)), created: true };
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictError('La clave de presupuesto ya existe.');
        throw error;
      }
    };
    return manager ? save(manager) : this.transactions.run(save);
  }

  /** Todas las definiciones, incluidas las historicas y futuras, en orden estable. */
  async list(manager?: EntityManager): Promise<Budget[]> {
    const read = (em: EntityManager) => em.getRepository(Budget).find({ order: { startsOn: 'ASC', sourceKey: 'ASC' } });
    return manager ? read(manager) : this.transactions.run(read);
  }

  /** Sin id solo periodos activos. Cada alcance se muestra independiente, nunca se suma. */
  async status(options: { budgetId?: string | undefined; on?: string | undefined } = {}, manager?: EntityManager): Promise<BudgetStatus[]> {
    const asOf = options.on === undefined ? dateInTimeZone(new Date(), 'America/Caracas') : parseDate(options.on);
    const id = options.budgetId === undefined ? undefined : requireText(options.budgetId, 'budgetId', 36);
    const read = async (em: EntityManager): Promise<BudgetStatus[]> => {
      const definitions = await this.list(em);
      const selected = definitions.filter((row) => id === undefined ? row.startsOn <= asOf && row.endsOn >= asOf : row.id === id);
      if (id !== undefined && selected.length === 0) throw new NotFoundError(`No existe el presupuesto "${id}".`);
      const expenses = (await this.financial.effectiveMovements(em)).filter((row) => !row.voided && row.kind === 'expense' && row.occurredOn <= asOf);
      return selected.map((budget) => {
        const spent = expenses.filter((row) => row.currency === budget.currency && row.occurredOn >= budget.startsOn &&
          row.occurredOn <= budget.endsOn && (budget.category === null || row.category === budget.category))
          .reduce((total, row) => total + row.amountMinor, 0n);
        const remaining = budget.limitMinor - spent;
        return { budget, asOf, spent, remaining, overspent: remaining < 0n };
      });
    };
    return manager ? read(manager) : this.transactions.run(read);
  }
}

function normalizeBudget(input: CreateBudgetInput): BudgetPayload {
  if (!isCurrency(input.currency) || typeof input.limitMinor !== 'bigint' || input.limitMinor < 0n) {
    throw new ValidationError('El presupuesto requiere moneda soportada y limite entero no negativo en unidades menores.');
  }
  const startsOn = parseDate(requireText(input.startsOn, 'startsOn', 10));
  const endsOn = parseDate(requireText(input.endsOn, 'endsOn', 10));
  if (startsOn > endsOn) throw new ValidationError('startsOn debe ser anterior o igual a endsOn.');
  return {
    sourceKey: requireText(input.sourceKey, 'sourceKey', 200),
    name: requireText(input.name, 'name', 80),
    currency: input.currency, limitMinor: input.limitMinor,
    category: input.category == null ? null : requireText(input.category, 'category', 80),
    startsOn, endsOn,
  };
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new ValidationError(`El campo "${field}" es obligatorio y admite hasta ${max} caracteres.`);
  }
  return value.trim();
}

function samePayload(row: Budget, input: BudgetPayload): boolean {
  return row.name === input.name && row.currency === input.currency && row.limitMinor === input.limitMinor &&
    row.category === input.category && row.startsOn === input.startsOn && row.endsOn === input.endsOn;
}
