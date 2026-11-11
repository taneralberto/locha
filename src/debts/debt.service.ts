import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager, In } from 'typeorm';
import { TransactionRunner } from '../data/transaction.runner';
import { isUniqueViolation } from '../data/unique-violation';
import { parseDate } from '../domain/date';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import { Currency, isCurrency } from '../domain/money';
import { FinancialService } from '../financial/financial.service';
import { Movement, MovementKind } from '../financial/movement.entity';
import { Debt, DebtDirection } from './debt.entity';
import { DebtPayment } from './debt-payment.entity';

const MAX_SOURCE_KEY_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 280;
const MAX_COUNTERPARTY_LENGTH = 120;

/** Estado derivado de la obligacion: nunca se persiste. */
export type DebtStatus = 'open' | 'partial' | 'paid';

export interface CreateDebtInput {
  sourceKey: string;
  direction: DebtDirection;
  counterparty: string;
  money: { currency: Currency; minor: bigint };
  occurredOn: string;
  description?: string | undefined;
}

export interface SettleDebtInput {
  sourceKey: string;
  debtId: string;
  accountId: string;
  money: { currency: Currency; minor: bigint };
  occurredOn: string;
  expectedOutstandingMinor: bigint;
  description?: string | undefined;
}

export interface DebtFilters {
  direction?: DebtDirection | undefined;
  currency?: Currency | undefined;
  counterparty?: string | undefined;
  status?: DebtStatus | undefined;
}

/** Un pago con su movimiento original y si sigue vigente. */
export interface DebtPaymentView {
  payment: DebtPayment;
  movement: Movement;
  voided: boolean;
}

export interface DebtView {
  debt: Debt;
  paidMinor: bigint;
  outstandingMinor: bigint;
  status: DebtStatus;
  payments: DebtPaymentView[];
}

export interface SettleDebtResult {
  payment: DebtPayment;
  movement: Movement;
  created: boolean;
}

interface NormalizedDebt {
  sourceKey: string;
  direction: DebtDirection;
  counterparty: string;
  currency: Currency;
  principalMinor: bigint;
  occurredOn: string;
  description: string | null;
}

interface NormalizedSettle {
  sourceKey: string;
  debtId: string;
  accountId: string;
  currency: Currency;
  minor: bigint;
  occurredOn: string;
  expectedOutstandingMinor: bigint;
  description: string | null;
}

@Injectable()
export class DebtService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly financial: FinancialService,
  ) {}

  /**
   * Registra una obligacion de seguimiento. No crea movimientos, cuentas ni saldo:
   * la obligacion solo existe hasta que se paga.
   */
  async create(input: CreateDebtInput, manager?: EntityManager): Promise<{ debt: Debt; created: boolean }> {
    const money = normalizeMoney(input.money);
    const normalized: NormalizedDebt = {
      sourceKey: requireText(input.sourceKey, 'sourceKey', MAX_SOURCE_KEY_LENGTH),
      direction: normalizeDirection(input.direction),
      counterparty: requireText(input.counterparty, 'counterparty', MAX_COUNTERPARTY_LENGTH),
      currency: money.currency,
      principalMinor: money.minor,
      occurredOn: normalizeDate(input.occurredOn),
      description: input.description === undefined ? null : requireText(input.description, 'description', MAX_DESCRIPTION_LENGTH),
    };
    const save = async (em: EntityManager) => {
      const repository = em.getRepository(Debt);
      const existing = await repository.findOneBy({ sourceKey: normalized.sourceKey });
      if (existing) {
        if (!sameDebt(existing, normalized)) {
          throw new ConflictError(`La clave "${normalized.sourceKey}" ya existe con otro contenido.`);
        }
        // Replay completo antes de cualquier estado mutable.
        return { debt: existing, created: false };
      }
      try {
        return { debt: await repository.save(repository.create(normalized)), created: true };
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictError('La clave de deuda ya existe.');
        throw error;
      }
    };
    return manager ? save(manager) : this.transactions.run(save);
  }

  /**
   * Paga una obligacion: registra el movimiento ordinario correspondiente (gasto si se
   * debe, ingreso si nos deben) y lo liga a la deuda, en la misma transaccion.
   */
  async settle(input: SettleDebtInput, manager?: EntityManager): Promise<SettleDebtResult> {
    const money = normalizeMoney(input.money);
    const normalized: NormalizedSettle = {
      sourceKey: requireText(input.sourceKey, 'sourceKey', MAX_SOURCE_KEY_LENGTH),
      debtId: requireText(input.debtId, 'debtId', 36),
      accountId: requireText(input.accountId, 'accountId', 36),
      currency: money.currency,
      minor: money.minor,
      occurredOn: normalizeDate(input.occurredOn),
      expectedOutstandingMinor: requirePositive(input.expectedOutstandingMinor, 'expectedOutstandingMinor'),
      description: input.description === undefined ? null : requireText(input.description, 'description', MAX_DESCRIPTION_LENGTH),
    };
    const save = async (em: EntityManager) => {
      const repository = em.getRepository(DebtPayment);
      const existing = await repository.findOneBy({ sourceKey: normalized.sourceKey });
      if (existing) {
        if (existing.debtId !== normalized.debtId ||
          existing.expectedOutstandingMinor !== normalized.expectedOutstandingMinor) {
          throw new ConflictError(`La clave "${normalized.sourceKey}" ya existe con otro contenido.`);
        }
        const debt = await requireDebt(em, existing.debtId);
        const movement = await em.getRepository(Movement).findOneBy({ id: existing.movementId });
        if (!movement) {
          throw new NotFoundError(`No existe el movimiento "${existing.movementId}".`);
        }
        // Se compara el movimiento ORIGINAL: un pago anulado no genera otro.
        if (!sameMovement(movement, normalized, kindOf(debt.direction))) {
          throw new ConflictError(`La clave "${normalized.sourceKey}" ya existe con otro contenido.`);
        }
        return { payment: existing, movement, created: false };
      }
      const debt = await requireDebt(em, normalized.debtId);
      if (debt.currency !== normalized.currency) {
        throw new ValidationError(`La deuda esta en ${debt.currency} y el pago es en ${normalized.currency}.`);
      }
      if (normalized.occurredOn < debt.occurredOn) {
        throw new ValidationError('El pago no puede ser anterior a la fecha de la deuda.');
      }
      const view = (await this.views(em, [debt]))[0]!;
      if (normalized.expectedOutstandingMinor !== view.outstandingMinor) {
        throw new ConflictError(
          `Saldo pendiente esperado ${normalized.expectedOutstandingMinor}; actual ${view.outstandingMinor}.`,
        );
      }
      if (normalized.minor > view.outstandingMinor) {
        throw new ValidationError('El pago supera el saldo pendiente de la deuda.');
      }
      const id = randomUUID();
      const registered = await this.financial.register({
        sourceKey: `debt-payment:${id}`,
        accountId: normalized.accountId,
        kind: kindOf(debt.direction),
        money: { currency: normalized.currency, minor: normalized.minor },
        occurredOn: normalized.occurredOn,
        ...(normalized.description === null ? {} : { description: normalized.description }),
      }, em);
      if (!registered.created) {
        throw new ConflictError('Colision con la clave del pago; no se registro ningun movimiento.');
      }
      try {
        const payment = await repository.save(repository.create({
          id,
          sourceKey: normalized.sourceKey,
          debtId: debt.id,
          movementId: registered.movement.id,
          expectedOutstandingMinor: normalized.expectedOutstandingMinor,
        }));
        return { payment, movement: registered.movement, created: true };
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictError('La clave de pago ya existe.');
        throw error;
      }
    };
    return manager ? save(manager) : this.transactions.run(save);
  }

  /** Obligacion con su saldo pendiente derivado y el historial de pagos. */
  async get(id: string, manager?: EntityManager): Promise<DebtView> {
    const debtId = requireText(id, 'debtId', 36);
    const read = async (em: EntityManager) => {
      const debt = await requireDebt(em, debtId);
      return (await this.views(em, [debt]))[0]!;
    };
    return manager ? read(manager) : this.transactions.run(read);
  }

  /** Obligaciones filtradas; los filtros de contraparte son coincidencias exactas canonicas. */
  async list(filters: DebtFilters = {}, manager?: EntityManager): Promise<DebtView[]> {
    const direction = filters.direction === undefined ? undefined : normalizeDirection(filters.direction);
    const currency = filters.currency === undefined ? undefined : normalizeCurrency(filters.currency);
    const status = filters.status === undefined ? undefined : normalizeStatus(filters.status);
    const counterparty = filters.counterparty === undefined
      ? undefined
      : canonicalCounterparty(requireText(filters.counterparty, 'counterparty', MAX_COUNTERPARTY_LENGTH));
    const read = async (em: EntityManager) => {
      const debts = await em.getRepository(Debt).find({ order: { occurredOn: 'DESC', sourceKey: 'ASC' } });
      const views = await this.views(em, debts);
      return views.filter((view) =>
        (direction === undefined || view.debt.direction === direction) &&
        (currency === undefined || view.debt.currency === currency) &&
        (counterparty === undefined || canonicalCounterparty(view.debt.counterparty) === counterparty) &&
        (status === undefined || view.status === status));
    };
    return manager ? read(manager) : this.transactions.run(read);
  }

  /**
   * Estado derivado de las obligaciones: lo pagado son los movimientos efectivos no
   * anulados ligados a la deuda; el pendiente es el principal menos lo pagado.
   */
  private async views(em: EntityManager, debts: Debt[]): Promise<DebtView[]> {
    if (debts.length === 0) return [];
    const payments = await em.getRepository(DebtPayment).find({
      where: { debtId: In(debts.map((debt) => debt.id)) },
      order: { createdAt: 'ASC', sourceKey: 'ASC' },
    });
    const effective = await this.financial.effectiveMovements(em);
    const effectiveById = new Map(effective.map((row) => [row.id, row]));
    const originals = payments.length === 0
      ? []
      : await em.getRepository(Movement).find({ where: { id: In(payments.map((payment) => payment.movementId)) } });
    const originalById = new Map(originals.map((row) => [row.id, row]));
    const byDebt = new Map<string, DebtPaymentView[]>();
    const paidByDebt = new Map<string, bigint>();
    for (const payment of payments) {
      const effectiveRow = effectiveById.get(payment.movementId);
      const original = originalById.get(payment.movementId);
      if (!effectiveRow || !original) continue;
      if (!effectiveRow.voided) {
        paidByDebt.set(payment.debtId, (paidByDebt.get(payment.debtId) ?? 0n) + effectiveRow.amountMinor);
      }
      const rows = byDebt.get(payment.debtId) ?? [];
      rows.push({ payment, movement: original, voided: effectiveRow.voided });
      byDebt.set(payment.debtId, rows);
    }
    return debts.map((debt) => {
      const paid = paidByDebt.get(debt.id) ?? 0n;
      const outstanding = debt.principalMinor - paid;
      return {
        debt,
        paidMinor: paid,
        outstandingMinor: outstanding,
        status: statusOf(paid, outstanding),
        payments: byDebt.get(debt.id) ?? [],
      };
    });
  }
}

/**
 * Identidad de la contraparte: NFD sin diacriticos, minusculas y espacios colapsados.
 * Solo sirve para comparar de forma exacta; la forma mostrada se conserva intacta.
 */
export function canonicalCounterparty(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function kindOf(direction: DebtDirection): MovementKind {
  return direction === 'payable' ? 'expense' : 'income';
}

function statusOf(paid: bigint, outstanding: bigint): DebtStatus {
  if (outstanding === 0n) return 'paid';
  return paid > 0n ? 'partial' : 'open';
}

async function requireDebt(em: EntityManager, id: string): Promise<Debt> {
  const debt = await em.getRepository(Debt).findOneBy({ id });
  if (!debt) throw new NotFoundError(`No existe la deuda "${id}".`);
  return debt;
}

function normalizeDirection(value: unknown): DebtDirection {
  if (value !== 'payable' && value !== 'receivable') {
    throw new ValidationError(`Direccion invalida "${String(value)}"; se espera payable o receivable.`);
  }
  return value;
}

function normalizeCurrency(value: unknown): Currency {
  if (!isCurrency(value)) {
    throw new ValidationError(`Moneda no soportada "${String(value)}".`);
  }
  return value;
}

function normalizeStatus(value: unknown): DebtStatus {
  if (value !== 'open' && value !== 'partial' && value !== 'paid') {
    throw new ValidationError(`Estado invalido "${String(value)}"; se espera open, partial o paid.`);
  }
  return value;
}

function normalizeMoney(money: { currency: Currency; minor: bigint }): { currency: Currency; minor: bigint } {
  const currency = normalizeCurrency(money?.currency);
  const minor = money?.minor;
  if (typeof minor !== 'bigint' || minor <= 0n) {
    throw new ValidationError('El importe debe ser un entero positivo en unidades menores.');
  }
  return { currency, minor };
}

function normalizeDate(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ValidationError('La fecha de la operacion es obligatoria.');
  }
  return parseDate(value);
}

function requirePositive(value: unknown, field: string): bigint {
  if (typeof value !== 'bigint' || value <= 0n) {
    throw new ValidationError(`El campo "${field}" debe ser un entero positivo en unidades menores.`);
  }
  return value;
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

function sameDebt(row: Debt, input: NormalizedDebt): boolean {
  return row.direction === input.direction &&
    canonicalCounterparty(row.counterparty) === canonicalCounterparty(input.counterparty) &&
    row.currency === input.currency && row.principalMinor === input.principalMinor &&
    row.occurredOn === input.occurredOn && (row.description ?? null) === input.description;
}

function sameMovement(movement: Movement, input: NormalizedSettle, kind: MovementKind): boolean {
  return movement.accountId === input.accountId && movement.kind === kind &&
    movement.currency === input.currency && movement.amountMinor === input.minor &&
    movement.occurredOn === input.occurredOn && (movement.description ?? null) === input.description;
}
