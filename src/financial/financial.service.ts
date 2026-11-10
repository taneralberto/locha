import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Account } from '../accounts/account.entity';
import { isUniqueViolation } from '../data/unique-violation';
import { TransactionRunner } from '../data/transaction.runner';
import { parseDate, parseMonth } from '../domain/date';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import { CURRENCY_CODES, Currency, isCurrency } from '../domain/money';
import { Movement, MovementKind } from './movement.entity';

const MAX_SOURCE_KEY_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 280;
const DEFAULT_RECENT_LIMIT = 20;
const MAX_RECENT_LIMIT = 200;

export interface RegisterInput {
  sourceKey: string;
  accountId: string;
  kind: MovementKind;
  money: { currency: Currency; minor: bigint };
  occurredOn: string;
  description?: string | undefined;
}

export interface RegisterResult {
  movement: Movement;
  /** `false` cuando el `sourceKey` ya existia con el mismo contenido. */
  created: boolean;
}

export interface CurrencySummary {
  currency: Currency;
  income: bigint;
  expense: bigint;
  /** Actividad neta registrada (ingresos menos gastos). No es el saldo de la cuenta. */
  net: bigint;
}

interface NormalizedInput {
  sourceKey: string;
  accountId: string;
  kind: MovementKind;
  currency: Currency;
  minor: bigint;
  occurredOn: string;
  description: string | null;
}

@Injectable()
export class FinancialService {
  constructor(private readonly transactions: TransactionRunner) {}

  /**
   * Registra un movimiento de forma idempotente por `sourceKey`.
   *
   * Si se entrega `manager`, el registro usa esa transaccion (por ejemplo, para guardar
   * dos movimientos atomicos como una transferencia) y no abre otra. Sin `manager` se usa
   * la cola de transacciones compartida de la conexion.
   */
  async register(input: RegisterInput, manager?: EntityManager): Promise<RegisterResult> {
    const normalized = normalizeInput(input);
    const register = async (em: EntityManager): Promise<RegisterResult> => {
      const existing = await em.getRepository(Movement).findOne({
        where: { sourceKey: normalized.sourceKey },
      });
      if (existing) {
        if (samePayload(existing, normalized)) {
          return { movement: existing, created: false };
        }
        throw new ConflictError(
          `La clave "${normalized.sourceKey}" ya existe con otro contenido.`,
        );
      }

      const account = await em.getRepository(Account).findOne({ where: { id: normalized.accountId } });
      if (!account) {
        throw new NotFoundError(`No existe la cuenta "${normalized.accountId}".`);
      }
      if (!account.active) {
        throw new ValidationError(`La cuenta "${account.name}" esta inactiva.`);
      }
      if (account.currency !== normalized.currency) {
        throw new ValidationError(
          `La cuenta "${account.name}" opera en ${account.currency} y el movimiento es en ${normalized.currency}.`,
        );
      }

      const repository = em.getRepository(Movement);
      const movement = repository.create({
        sourceKey: normalized.sourceKey,
        accountId: normalized.accountId,
        kind: normalized.kind,
        amountMinor: normalized.minor,
        currency: normalized.currency,
        occurredOn: normalized.occurredOn,
        description: normalized.description,
      });
      try {
        return { movement: await repository.save(movement), created: true };
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        // Otra escritura gano la carrera: se resuelve con el movimiento ya persistido.
        const winner = await repository.findOne({ where: { sourceKey: normalized.sourceKey } });
        if (!winner) {
          throw error;
        }
        if (!samePayload(winner, normalized)) {
          throw new ConflictError(
            `La clave "${normalized.sourceKey}" ya existe con otro contenido.`,
          );
        }
        return { movement: winner, created: false };
      }
    };

    if (manager) {
      return register(manager);
    }
    return this.transactions.run(register);
  }

  /**
   * Movimientos recientes en orden determinista: fecha de operacion descendente, luego
   * `sourceKey`. La lectura pasa por la cola de transacciones: nunca ve el estado
   * anterior a un commit que este en curso.
   */
  async recent(limit: number = DEFAULT_RECENT_LIMIT, manager?: EntityManager): Promise<Movement[]> {
    const take = Number.isFinite(limit)
      ? Math.min(Math.max(Math.trunc(limit), 1), MAX_RECENT_LIMIT)
      : DEFAULT_RECENT_LIMIT;
    const read = async (em: EntityManager): Promise<Movement[]> =>
      em.getRepository(Movement).find({
        order: { occurredOn: 'DESC', sourceKey: 'ASC' },
        take,
      });
    if (manager) {
      return read(manager);
    }
    return this.transactions.run(read);
  }

  /**
   * Totales por moneda calculados en bigint a partir de los movimientos registrados.
   * Con `month` (`YYYY-MM`) solo se cuentan los movimientos de ese mes.
   */
  async summary(month?: string, manager?: EntityManager): Promise<CurrencySummary[]> {
    const prefix = month === undefined ? null : `${parseMonth(month)}%`;
    const read = async (em: EntityManager): Promise<CurrencySummary[]> => {
      const query = em.getRepository(Movement).createQueryBuilder('movement');
      if (prefix !== null) {
        query.andWhere('movement.occurredOn LIKE :prefix', { prefix });
      }
      const movements = await query.getMany();
      const totals = new Map<Currency, { income: bigint; expense: bigint }>();
      for (const movement of movements) {
        const current = totals.get(movement.currency) ?? { income: 0n, expense: 0n };
        if (movement.kind === 'income') {
          current.income += movement.amountMinor;
        } else {
          current.expense += movement.amountMinor;
        }
        totals.set(movement.currency, current);
      }
      return CURRENCY_CODES.map((currency) => {
        const current = totals.get(currency) ?? { income: 0n, expense: 0n };
        return {
          currency,
          income: current.income,
          expense: current.expense,
          net: current.income - current.expense,
        };
      });
    };
    if (manager) {
      return read(manager);
    }
    return this.transactions.run(read);
  }
}
function normalizeInput(input: RegisterInput): NormalizedInput {
  const sourceKey = requireText(input.sourceKey, 'sourceKey', MAX_SOURCE_KEY_LENGTH);
  const accountId = requireText(input.accountId, 'accountId', 36);
  if (input.kind !== 'income' && input.kind !== 'expense') {
    throw new ValidationError(`Tipo de movimiento invalido "${String(input.kind)}".`);
  }
  const currency: unknown = input.money?.currency;
  if (!isCurrency(currency)) {
    throw new ValidationError(`Moneda no soportada "${String(currency)}".`);
  }
  const minor: unknown = input.money?.minor;
  if (typeof minor !== 'bigint' || minor <= 0n) {
    throw new ValidationError('El importe debe ser un entero positivo en unidades menores.');
  }
  if (typeof input.occurredOn !== 'string') {
    throw new ValidationError('La fecha de la operacion es obligatoria.');
  }
  const description =
    input.description === undefined
      ? null
      : requireText(input.description, 'description', MAX_DESCRIPTION_LENGTH);
  return {
    sourceKey,
    accountId,
    kind: input.kind,
    currency,
    minor,
    occurredOn: parseDate(input.occurredOn),
    description,
  };
}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`El campo "${field}" es obligatorio.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError(`El campo "${field}" es obligatorio.`);
  }
  if (trimmed.length > maxLength) {
    throw new ValidationError(`El campo "${field}" supera los ${maxLength} caracteres.`);
  }
  return trimmed;
}

function samePayload(movement: Movement, input: NormalizedInput): boolean {
  return (
    movement.accountId === input.accountId &&
    movement.kind === input.kind &&
    movement.currency === input.currency &&
    movement.amountMinor === input.minor &&
    movement.occurredOn === input.occurredOn &&
    (movement.description ?? null) === input.description
  );
}
