import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { TransactionRunner } from '../data/transaction.runner';
import { isUniqueViolation } from '../data/unique-violation';
import { parseDate } from '../domain/date';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import { Currency, isCurrency } from '../domain/money';
import { Goal } from './goal.entity';

export interface CreateGoalInput {
  sourceKey: string;
  name: string;
  currency: Currency;
  targetMinor: bigint;
  targetOn?: string | null | undefined;
}

@Injectable()
export class GoalService {
  constructor(private readonly transactions: TransactionRunner) {}

  async create(input: CreateGoalInput, manager?: EntityManager): Promise<{ goal: Goal; created: boolean }> {
    if (!isCurrency(input.currency) || typeof input.targetMinor !== 'bigint' || input.targetMinor <= 0n) {
      throw new ValidationError('La meta requiere moneda soportada y objetivo entero positivo en unidades menores.');
    }
    const normalized = {
      sourceKey: savingsText(input.sourceKey, 'sourceKey', 200), name: savingsText(input.name, 'name', 80),
      currency: input.currency, targetMinor: input.targetMinor,
      targetOn: input.targetOn == null ? null : parseDate(savingsText(input.targetOn, 'targetOn', 10)),
    };
    const save = async (em: EntityManager) => {
      const repository = em.getRepository(Goal);
      const existing = await repository.findOneBy({ sourceKey: normalized.sourceKey });
      if (existing) {
        if (existing.name !== normalized.name || existing.currency !== normalized.currency ||
          existing.targetMinor !== normalized.targetMinor || existing.targetOn !== normalized.targetOn) {
          throw new ConflictError('La clave de meta ya existe con otro contenido.');
        }
        return { goal: existing, created: false };
      }
      try {
        return { goal: await repository.save(repository.create(normalized)), created: true };
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictError('La clave de meta ya existe.');
        throw error;
      }
    };
    return manager ? save(manager) : this.transactions.run(save);
  }

  async list(manager?: EntityManager): Promise<Goal[]> {
    const read = (em: EntityManager) => em.getRepository(Goal).find({ order: { createdAt: 'ASC', sourceKey: 'ASC' } });
    return manager ? read(manager) : this.transactions.run(read);
  }

  async get(id: string, manager?: EntityManager): Promise<Goal> {
    const goalId = savingsText(id, 'goalId', 36);
    const read = async (em: EntityManager) => {
      const goal = await em.getRepository(Goal).findOneBy({ id: goalId });
      if (!goal) throw new NotFoundError(`No existe la meta "${goalId}".`);
      return goal;
    };
    return manager ? read(manager) : this.transactions.run(read);
  }
}

export function savingsText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new ValidationError(`El campo "${field}" es obligatorio y admite hasta ${max} caracteres.`);
  }
  return value.trim();
}
