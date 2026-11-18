import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager, LessThanOrEqual } from 'typeorm';
import { Account } from '../accounts/account.entity';
import { DebtPayment } from '../debts/debt-payment.entity';
import { isUniqueViolation } from '../data/unique-violation';
import { TransactionRunner } from '../data/transaction.runner';
import { dateInTimeZone, parseDate, parseMonth } from '../domain/date';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import { CURRENCY_CODES, Currency, isCurrency } from '../domain/money';
import { Movement, MovementKind } from './movement.entity';
import { LedgerOperation } from './ledger-operation.entity';
import { MovementRevision } from './movement-revision.entity';
import { BalanceReconciliation } from './balance-reconciliation.entity';

const MAX_SOURCE_KEY_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 280;
const DEFAULT_RECENT_LIMIT = 20;
const MAX_RECENT_LIMIT = 200;
/** Motivo por defecto de la correccion de un gasto. */
const DEFAULT_CORRECTION_REASON = 'Correccion de gasto';
/** Sufijo de la clave de la revision que anula el gasto original. */
const CORRECTION_VOID_SUFFIX = 'void';
/** Sufijo de la clave del movimiento que se registra en el medio destino. */
const CORRECTION_MOVEMENT_SUFFIX = 'expense';

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

export interface OpeningInput {
  sourceKey: string;
  accountId: string;
  money: { currency: Currency; minor: bigint };
  occurredOn: string;
  description?: string | undefined;
}

export interface TransferLeg {
  accountId: string;
  money: { currency: Currency; minor: bigint };
}

export interface TransferInput {
  sourceKey: string;
  from: TransferLeg;
  to: TransferLeg;
  fee?: TransferLeg | undefined;
  occurredOn: string;
  description?: string | undefined;
}

export interface OperationResult {
  operation: LedgerOperation;
  created: boolean;
}

export interface AccountBalance {
  accountId: string;
  name: string;
  currency: Currency;
  balance: bigint;
  /** Apertura incluida a esta fecha, no una instantanea que sustituya la actividad. */
  hasOpening: boolean;
  asOf: string;
}

/** DTO compatible con Movement; nunca se persiste sobre la fila original. */
export interface EffectiveMovement extends Movement {
  category: string | null;
  revision: number;
  voided: boolean;
}

export interface MovementHistory {
  original: Movement;
  revisions: MovementRevision[];
  effective: EffectiveMovement;
  feeOwner: LedgerOperation | null;
}

export interface VoidMovementInput {
  sourceKey: string;
  movementId: string;
  expectedRevision: number;
  reason: string;
}

export interface EditMovementInput extends VoidMovementInput {
  amountMinor: bigint;
  occurredOn: string;
  description?: string | undefined;
  category?: string | undefined;
}

export interface ReconcileInput {
  sourceKey: string;
  accountId: string;
  currency: Currency;
  targetMinor: bigint;
  occurredOn: string;
  reason: string;
}

/** `edit` corrige el gasto en su medio; `replace` lo anula y lo registra en otro medio. */
export type ExpenseCorrectionMode = 'edit' | 'replace';

/** Medio e importe de un gasto, antes y despues de la correccion. */
export interface ExpenseCorrectionSide {
  accountId: string;
  currency: Currency;
  amountMinor: bigint;
  occurredOn: string;
  description: string | null;
}

export interface ExpenseCorrectionInput {
  /** Clave idempotente de la correccion. */
  sourceKey: string;
  /** Movimiento de gasto que se corrige. */
  movementId: string;
  /** Importe exacto del gasto corregido, en unidades menores de la moneda destino. */
  amountMinor: bigint;
  /** Cuenta donde queda el gasto corregido. */
  accountId: string;
  /** Moneda del gasto corregido; debe ser la que opera la cuenta. */
  currency: Currency;
  /** Fecha del gasto corregido; si se omite, se conserva la del original. */
  occurredOn?: string | undefined;
  /** Descripcion del gasto corregido; si se omite, se conserva la del original. */
  description?: string | undefined;
  /** Motivo auditable de la correccion. */
  reason?: string | undefined;
}

export interface ExpenseCorrectionResult {
  /** Identificador del movimiento efectivo despues de la correccion. */
  movementId: string;
  /** `false` cuando la correccion ya estaba aplicada con el mismo `sourceKey`. */
  created: boolean;
  mode: ExpenseCorrectionMode;
}

export interface ExpenseCorrectionPreview {
  /** Movimiento de gasto que se corrige. */
  movementId: string;
  mode: ExpenseCorrectionMode;
  /** Medio e importe actuales del gasto. */
  current: ExpenseCorrectionSide;
  /** Medio e importe del gasto despues de la correccion. */
  target: ExpenseCorrectionSide;
  /** Clave del movimiento que se registraria al cambiar de medio. */
  replacementSourceKey: string | null;
}

type RevisionPayload = Omit<MovementRevision, 'id' | 'createdAt' | 'revision'>;

interface NormalizedExpenseCorrection {
  sourceKey: string;
  movementId: string;
  amountMinor: bigint;
  accountId: string;
  currency: Currency;
  occurredOn: string | undefined;
  description: string | undefined;
  reason: string;
}

interface CorrectionBase {
  history: MovementHistory;
  effective: EffectiveMovement;
  current: ExpenseCorrectionSide;
  target: ExpenseCorrectionSide;
  /** Categoria vigente del gasto: la guardan las revisiones, no el movimiento. */
  category: string | null;
}

interface EditCorrectionPlan extends CorrectionBase {
  mode: 'edit';
  /** Revision que deja el gasto corregido en su propio medio. */
  revision: RevisionPayload;
}

interface ReplaceCorrectionPlan extends CorrectionBase {
  mode: 'replace';
  /** Clave de la revision que anula el gasto original. */
  voidSourceKey: string;
  /** Payload de la revision que anula el gasto original. */
  voidRevision: RevisionPayload;
  /** Clave del movimiento que se registra en el medio destino. */
  replacementSourceKey: string;
  /** Payload del movimiento que se registra en el medio destino. */
  replacement: NormalizedInput;
}

type CorrectionPlan = EditCorrectionPlan | ReplaceCorrectionPlan;

interface NormalizedOperation {
  sourceKey: string;
  kind: 'opening' | 'transfer';
  accountId: string;
  currency: Currency;
  deltaMinor: bigint;
  destinationAccountId: string | null;
  destinationCurrency: Currency | null;
  destinationDeltaMinor: bigint | null;
  fee: TransferLeg | null;
  occurredOn: string;
  description: string | null;
}

@Injectable()
export class FinancialService {
  constructor(private readonly transactions: TransactionRunner) {}

  /** Unica proyeccion efectiva. Los filtros de fecha, orden y limite se aplican despues. */
  async effectiveMovements(manager?: EntityManager): Promise<EffectiveMovement[]> {
    const read = async (em: EntityManager): Promise<EffectiveMovement[]> => {
      const originals = await em.getRepository(Movement).find();
      const revisions = await em.getRepository(MovementRevision).find({ order: { revision: 'ASC' } });
      const byId = new Map(originals.map((original): [string, EffectiveMovement] => [original.id, {
        ...original, category: null, revision: 0, voided: false,
      }]));
      for (const revision of revisions) {
        const current = byId.get(revision.movementId)!;
        current.revision = revision.revision;
        if (revision.kind === 'void') {
          current.voided = true;
        } else {
          current.amountMinor = revision.amountMinor!;
          current.occurredOn = revision.occurredOn!;
          current.description = revision.description;
          current.category = revision.category;
        }
      }
      return [...byId.values()];
    };
    return manager ? read(manager) : this.transactions.run(read);
  }

  async movementHistory(movementId: string, manager?: EntityManager): Promise<MovementHistory> {
    const id = requireText(movementId, 'movementId', 36);
    const read = async (em: EntityManager): Promise<MovementHistory> => {
      const original = await requireMovement(em, id);
      const revisions = await em.getRepository(MovementRevision).find({ where: { movementId: id }, order: { revision: 'ASC' } });
      const effective = (await this.effectiveMovements(em)).find((row) => row.id === id)!;
      const feeOwner = await em.getRepository(LedgerOperation).findOneBy({ feeMovementId: id });
      return { original, revisions, effective, feeOwner };
    };
    return manager ? read(manager) : this.transactions.run(read);
  }

  async editMovement(input: EditMovementInput, manager?: EntityManager): Promise<{ revision: MovementRevision; created: boolean }> {
    if (typeof input.amountMinor !== 'bigint' || input.amountMinor <= 0n) {
      throw new ValidationError('El importe debe ser un entero positivo en unidades menores.');
    }
    return this.saveRevision({
      ...normalizeRevision(input), kind: 'edit', amountMinor: input.amountMinor,
      occurredOn: parseDate(input.occurredOn),
      description: input.description === undefined ? null : requireText(input.description, 'description', MAX_DESCRIPTION_LENGTH),
      category: input.category === undefined ? null : requireText(input.category, 'category', 80),
    }, manager);
  }

  async voidMovement(input: VoidMovementInput, manager?: EntityManager): Promise<{ revision: MovementRevision; created: boolean }> {
    return this.saveRevision({
      ...normalizeRevision(input), kind: 'void', amountMinor: null, occurredOn: null, description: null, category: null,
    }, manager);
  }

  /**
   * Describe la correccion de un gasto confirmado sin escribir nada.
   *
   * Aplica las mismas reglas que `correctExpense`: el importe tiene que ser un entero
   * positivo, la cuenta destino tiene que estar activa y operar en la moneda indicada,
   * y el gasto no puede estar anulado, revisado, atado a una deuda ni ser una comision.
   */
  async previewExpenseCorrection(input: ExpenseCorrectionInput, manager?: EntityManager): Promise<ExpenseCorrectionPreview> {
    const normalized = normalizeExpenseCorrection(input);
    const read = async (em: EntityManager): Promise<ExpenseCorrectionPreview> => {
      const plan = await this.correctionPlan(em, normalized);
      await this.requireCorrectableExpense(em, plan);
      return {
        movementId: normalized.movementId,
        mode: plan.mode,
        current: plan.current,
        target: plan.target,
        replacementSourceKey: plan.mode === 'replace' ? plan.replacementSourceKey : null,
      };
    };
    return manager ? read(manager) : this.transactions.run(read);
  }

  /**
   * Corrige un gasto ordinario ya confirmado y devuelve el movimiento efectivo.
   *
   * Mismo medio (misma cuenta y misma moneda): una edicion auditada del gasto.
   * Otro medio (por ejemplo, de VES a USDT): anula el original y registra el gasto
   * nuevo con la fecha y la descripcion del original. Las dos escrituras van en una
   * sola transaccion: si el registro falla, la anulacion se revierte y no queda un
   * exito parcial.
   *
   * Repetir la `sourceKey` con el mismo payload devuelve el resultado original sin
   * duplicar nada; con otro payload, la correccion entra en conflicto.
   */
  async correctExpense(input: ExpenseCorrectionInput, manager?: EntityManager): Promise<ExpenseCorrectionResult> {
    const normalized = normalizeExpenseCorrection(input);
    const work = async (em: EntityManager): Promise<ExpenseCorrectionResult> => {
      const plan = await this.correctionPlan(em, normalized);
      const replay = await this.replayCorrection(em, normalized, plan);
      if (replay !== null) return replay;
      await this.requireCorrectableExpense(em, plan);
      if (plan.mode === 'edit') {
        const edited = await this.editMovement({
          sourceKey: normalized.sourceKey,
          movementId: normalized.movementId,
          expectedRevision: 0,
          amountMinor: plan.target.amountMinor,
          occurredOn: plan.target.occurredOn,
          reason: normalized.reason,
          description: plan.target.description ?? undefined,
          category: plan.category ?? undefined,
        }, em);
        return { movementId: normalized.movementId, created: edited.created, mode: 'edit' };
      }
      await this.voidMovement({
        sourceKey: plan.voidSourceKey,
        movementId: normalized.movementId,
        expectedRevision: 0,
        reason: normalized.reason,
      }, em);
      const registered = await this.register({
        sourceKey: plan.replacementSourceKey,
        accountId: plan.replacement.accountId,
        kind: plan.replacement.kind,
        money: { currency: plan.replacement.currency, minor: plan.replacement.minor },
        occurredOn: plan.replacement.occurredOn,
        ...(plan.replacement.description === null ? {} : { description: plan.replacement.description }),
      }, em);
      if (!registered.created) {
        throw new ConflictError(`La clave "${plan.replacementSourceKey}" ya existe con otro contenido.`);
      }
      return { movementId: registered.movement.id, created: true, mode: 'replace' };
    };
    // Con manager del llamador, la transaccion propia es un savepoint: un fallo
    // revierte solo esta correccion y deja intacto el resto de su transaccion.
    return manager ? manager.transaction(work) : this.transactions.run(work);
  }

  /** Lee el gasto y arma el plan de la correccion, sin aplicar ni validar el estado. */
  private async correctionPlan(em: EntityManager, normalized: NormalizedExpenseCorrection): Promise<CorrectionPlan> {
    const history = await this.movementHistory(normalized.movementId, em);
    const original = history.original;
    const effective = history.effective;
    const target: ExpenseCorrectionSide = {
      accountId: normalized.accountId,
      currency: normalized.currency,
      amountMinor: normalized.amountMinor,
      occurredOn: normalized.occurredOn ?? effective.occurredOn,
      description: normalized.description ?? effective.description,
    };
    const current: ExpenseCorrectionSide = {
      accountId: original.accountId,
      currency: original.currency,
      amountMinor: effective.amountMinor,
      occurredOn: effective.occurredOn,
      description: effective.description,
    };
    const base: CorrectionBase = { history, effective, current, target, category: effective.category };
    const sameMedium = original.accountId === normalized.accountId && original.currency === normalized.currency;
    if (sameMedium) {
      return {
        ...base,
        mode: 'edit',
        revision: {
          sourceKey: normalized.sourceKey,
          movementId: normalized.movementId,
          expectedRevision: 0,
          kind: 'edit',
          reason: normalized.reason,
          amountMinor: target.amountMinor,
          occurredOn: target.occurredOn,
          description: target.description,
          category: effective.category,
        },
      };
    }
    const voidSourceKey = derivedKey(normalized.sourceKey, CORRECTION_VOID_SUFFIX);
    const replacementSourceKey = derivedKey(normalized.sourceKey, CORRECTION_MOVEMENT_SUFFIX);
    return {
      ...base,
      mode: 'replace',
      voidSourceKey,
      voidRevision: {
        sourceKey: voidSourceKey,
        movementId: normalized.movementId,
        expectedRevision: 0,
        kind: 'void',
        reason: normalized.reason,
        amountMinor: null,
        occurredOn: null,
        description: null,
        category: null,
      },
      replacementSourceKey,
      replacement: {
        sourceKey: replacementSourceKey,
        accountId: target.accountId,
        kind: 'expense',
        currency: target.currency,
        minor: target.amountMinor,
        occurredOn: target.occurredOn,
        description: target.description,
      },
    };
  }

  /** Un gasto se corrige una sola vez y solo si es un gasto ordinario sin revisar. */
  private async requireCorrectableExpense(em: EntityManager, plan: CorrectionPlan): Promise<void> {
    if (plan.history.original.kind !== 'expense') {
      throw new ValidationError('Solo un gasto se corrige con esta operacion.');
    }
    if (plan.effective.voided) {
      throw new ConflictError('El gasto esta anulado; la anulacion es terminal.');
    }
    if (plan.effective.revision !== 0) {
      throw new ConflictError('El gasto ya fue revisado; la correccion exige la revision 0.');
    }
    if (await isDebtPayment(em, plan.history.original.id)) {
      throw new ConflictError('El pago de una deuda no se corrige como gasto ordinario.');
    }
    if (plan.history.feeOwner !== null) {
      throw new ConflictError('La comision de una transferencia no se corrige como gasto ordinario.');
    }
    await requireOperationAccount(em, plan.target.accountId, plan.target.currency);
  }

  /**
   * Una correccion repetida con la misma clave y el mismo payload devuelve el
   * resultado original; con otro payload, conflicto. Se resuelve antes de mirar el
   * estado del gasto, que la propia correccion ya cambio.
   */
  private async replayCorrection(
    em: EntityManager,
    normalized: NormalizedExpenseCorrection,
    plan: CorrectionPlan,
  ): Promise<ExpenseCorrectionResult | null> {
    if (plan.mode === 'edit') {
      const existing = await em.getRepository(MovementRevision).findOneBy({ sourceKey: normalized.sourceKey });
      if (!existing) return null;
      if (!sameRevision(existing, plan.revision)) {
        throw new ConflictError(`La clave "${normalized.sourceKey}" ya existe con otro contenido.`);
      }
      return { movementId: normalized.movementId, created: false, mode: 'edit' };
    }
    const voidRevision = await em.getRepository(MovementRevision).findOneBy({ sourceKey: plan.voidSourceKey });
    const replacement = await em.getRepository(Movement).findOneBy({ sourceKey: plan.replacementSourceKey });
    if (!voidRevision && !replacement) return null;
    if (!voidRevision || !replacement) {
      throw new ConflictError(`La correccion "${normalized.sourceKey}" esta incompleta; no se aplica de nuevo.`);
    }
    if (!sameRevision(voidRevision, plan.voidRevision) || !samePayload(replacement, plan.replacement)) {
      throw new ConflictError(`La clave "${normalized.sourceKey}" ya existe con otro contenido.`);
    }
    return { movementId: replacement.id, created: false, mode: 'replace' };
  }

  private async saveRevision(input: RevisionPayload, manager?: EntityManager): Promise<{ revision: MovementRevision; created: boolean }> {
    const save = async (em: EntityManager) => {
      const repository = em.getRepository(MovementRevision);
      const existing = await repository.findOneBy({ sourceKey: input.sourceKey });
      if (existing) {
        if (!sameRevision(existing, input)) {
          throw new ConflictError(`La clave "${input.sourceKey}" ya existe con otro contenido.`);
        }
        // El replay no depende de revisiones posteriores, anulaciones ni cuentas inactivas.
        return { revision: existing, created: false };
      }
      // Un pago de deuda se corrige anulando y pagando de nuevo: su importe no se edita.
      if (input.kind === 'edit' && await isDebtPayment(em, input.movementId)) {
        throw new ConflictError('El movimiento de un pago de deuda no se edita; anula el pago y registra uno nuevo.');
      }
      const history = await this.movementHistory(input.movementId, em);
      if (history.effective.voided) {
        throw new ConflictError('El movimiento esta anulado; la anulacion es terminal.');
      }
      if (history.effective.revision !== input.expectedRevision) {
        throw new ConflictError(`Revision esperada ${input.expectedRevision}; actual ${history.effective.revision}.`);
      }
      await requireOperationAccount(em, history.original.accountId, history.original.currency);
      try {
        const revision = await repository.save(repository.create({ ...input, revision: input.expectedRevision + 1 }));
        return { revision, created: true };
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError('La clave o la revision del movimiento ya existe.');
        }
        throw error;
      }
    };
    return manager ? save(manager) : this.transactions.run(save);
  }

  async reconcile(input: ReconcileInput, manager?: EntityManager): Promise<{ reconciliation: BalanceReconciliation; created: boolean }> {
    if (!isCurrency(input.currency) || typeof input.targetMinor !== 'bigint') {
      throw new ValidationError('La conciliacion requiere moneda soportada y objetivo entero en unidades menores.');
    }
    const normalized = {
      sourceKey: requireText(input.sourceKey, 'sourceKey', MAX_SOURCE_KEY_LENGTH),
      accountId: requireText(input.accountId, 'accountId', 36), currency: input.currency,
      targetMinor: input.targetMinor, occurredOn: parseDate(input.occurredOn),
      reason: requireText(input.reason, 'reason', MAX_DESCRIPTION_LENGTH),
    };
    const save = async (em: EntityManager) => {
      const repository = em.getRepository(BalanceReconciliation);
      const existing = await repository.findOneBy({ sourceKey: normalized.sourceKey });
      if (existing) {
        if (existing.accountId !== normalized.accountId || existing.currency !== normalized.currency ||
          existing.targetMinor !== normalized.targetMinor || existing.occurredOn !== normalized.occurredOn || existing.reason !== normalized.reason) {
          throw new ConflictError(`La clave "${normalized.sourceKey}" ya existe con otro contenido.`);
        }
        return { reconciliation: existing, created: false };
      }
      await requireOperationAccount(em, normalized.accountId, normalized.currency);
      const beforeMinor = (await this.balances(normalized.occurredOn, em)).find((row) => row.accountId === normalized.accountId)!.balance;
      try {
        const reconciliation = await repository.save(repository.create({
          ...normalized, beforeMinor, deltaMinor: normalized.targetMinor - beforeMinor,
        }));
        return { reconciliation, created: true };
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError('La clave de conciliacion ya existe.');
        }
        throw error;
      }
    };
    return manager ? save(manager) : this.transactions.run(save);
  }

  async reconciliations(accountId?: string, manager?: EntityManager): Promise<BalanceReconciliation[]> {
    const id = accountId === undefined ? undefined : requireText(accountId, 'accountId', 36);
    const read = async (em: EntityManager) => {
      if (id !== undefined && !await em.getRepository(Account).existsBy({ id })) {
        throw new NotFoundError(`No existe la cuenta "${id}".`);
      }
      return em.getRepository(BalanceReconciliation).find({
        ...(id === undefined ? {} : { where: { accountId: id } }),
        order: { occurredOn: 'DESC', sourceKey: 'ASC' },
      });
    };
    return manager ? read(manager) : this.transactions.run(read);
  }

  async open(input: OpeningInput, manager?: EntityManager): Promise<OperationResult> {
    const leg = normalizeLeg(input, true);
    return this.saveOperation({
      ...normalizeOperationText(input),
      kind: 'opening',
      accountId: leg.accountId,
      currency: leg.money.currency,
      deltaMinor: leg.money.minor,
      destinationAccountId: null,
      destinationCurrency: null,
      destinationDeltaMinor: null,
      fee: null,
    }, manager);
  }

  async transfer(input: TransferInput, manager?: EntityManager): Promise<OperationResult> {
    const from = normalizeLeg(input.from);
    const to = normalizeLeg(input.to);
    const fee = input.fee === undefined ? null : normalizeLeg(input.fee);
    if (from.accountId === to.accountId) {
      throw new ValidationError('La transferencia requiere dos cuentas distintas.');
    }
    if (from.money.currency === to.money.currency && from.money.minor !== to.money.minor) {
      throw new ValidationError('En la misma moneda, enviado y recibido deben ser iguales; registra la comision aparte.');
    }
    return this.saveOperation({
      ...normalizeOperationText(input),
      kind: 'transfer',
      accountId: from.accountId,
      currency: from.money.currency,
      deltaMinor: -from.money.minor,
      destinationAccountId: to.accountId,
      destinationCurrency: to.money.currency,
      destinationDeltaMinor: to.money.minor,
      fee,
    }, manager);
  }

  private async saveOperation(input: NormalizedOperation, manager?: EntityManager): Promise<OperationResult> {
    const save = async (em: EntityManager): Promise<OperationResult> => {
      const repository = em.getRepository(LedgerOperation);
      const existing = await repository.findOneBy({ sourceKey: input.sourceKey });
      if (existing) {
        const fee = existing.feeMovementId === null ? null :
          await em.getRepository(Movement).findOneByOrFail({ id: existing.feeMovementId });
        if (!sameOperation(existing, fee, input)) {
          throw new ConflictError(`La clave "${input.sourceKey}" ya existe con otro contenido.`);
        }
        // Resolver el replay antes de consultar el estado mutable de las cuentas.
        return { operation: existing, created: false };
      }
      await requireOperationAccount(em, input.accountId, input.currency);
      if (input.destinationAccountId !== null && input.destinationCurrency !== null) {
        await requireOperationAccount(em, input.destinationAccountId, input.destinationCurrency);
      }
      if (input.kind === 'opening' && await repository.existsBy({ kind: 'opening', accountId: input.accountId })) {
        throw new ConflictError('La cuenta ya tiene una apertura.');
      }
      const id = randomUUID();
      let feeMovementId: string | null = null;
      if (input.fee !== null) {
        const result = await this.register({
          sourceKey: `ledger:${id}:fee`,
          accountId: input.fee.accountId,
          kind: 'expense',
          money: input.fee.money,
          occurredOn: input.occurredOn,
          ...(input.description === null ? {} : { description: input.description }),
        }, em);
        if (!result.created) {
          throw new ConflictError('Colision con la clave de la comision; no se registro la transferencia.');
        }
        feeMovementId = result.movement.id;
      }
      const { fee: _fee, ...fields } = input;
      try {
        const operation = await repository.save(repository.create({ ...fields, id, feeMovementId }));
        return { operation, created: true };
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError('Ya existe la clave de operacion o la apertura de la cuenta.');
        }
        throw error;
      }
    };
    return manager ? save(manager) : this.transactions.run(save);
  }

  /** Saldo aditivo a una fecha inclusiva; incluye cuentas inactivas y admite negativos. */
  async balances(on?: string, manager?: EntityManager): Promise<AccountBalance[]> {
    const asOf = on === undefined ? dateInTimeZone(new Date(), 'America/Caracas') : parseDate(on);
    const read = async (em: EntityManager): Promise<AccountBalance[]> => {
      const accounts = await em.getRepository(Account).find({ order: { name: 'ASC', id: 'ASC' } });
      const rows = accounts.map((account): AccountBalance => ({
        accountId: account.id, name: account.name, currency: account.currency,
        balance: 0n, hasOpening: false, asOf,
      }));
      const byId = new Map(rows.map((row) => [row.accountId, row]));
      const movements = (await this.effectiveMovements(em)).filter((row) => !row.voided && row.occurredOn <= asOf);
      for (const movement of movements) {
        const row = byId.get(movement.accountId)!;
        row.balance += movement.kind === 'income' ? movement.amountMinor : -movement.amountMinor;
      }
      const operations = await em.getRepository(LedgerOperation).find({ where: { occurredOn: LessThanOrEqual(asOf) } });
      for (const operation of operations) {
        const row = byId.get(operation.accountId)!;
        row.balance += operation.deltaMinor;
        if (operation.kind === 'opening') {
          row.hasOpening = true;
        } else {
          byId.get(operation.destinationAccountId!)!.balance += operation.destinationDeltaMinor!;
        }
      }
      const reconciliations = await em.getRepository(BalanceReconciliation).find({ where: { occurredOn: LessThanOrEqual(asOf) } });
      for (const reconciliation of reconciliations) {
        byId.get(reconciliation.accountId)!.balance += reconciliation.deltaMinor;
      }
      return rows;
    };
    return manager ? read(manager) : this.transactions.run(read);
  }

  /**
   * Registra un movimiento de forma idempotente por `sourceKey`.
   *
   * Si se entrega `manager`, el registro usa esa transaccion (por ejemplo, para guardar
   * la comision de una transferencia) y no abre otra. Sin `manager` se usa
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
  async recent(limit: number = DEFAULT_RECENT_LIMIT, manager?: EntityManager): Promise<EffectiveMovement[]> {
    const take = Number.isFinite(limit)
      ? Math.min(Math.max(Math.trunc(limit), 1), MAX_RECENT_LIMIT)
      : DEFAULT_RECENT_LIMIT;
    const read = async (em: EntityManager): Promise<EffectiveMovement[]> =>
      (await this.effectiveMovements(em)).filter((row) => !row.voided)
        .sort((a, b) => compareText(b.occurredOn, a.occurredOn) || compareText(a.sourceKey, b.sourceKey)).slice(0, take);
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
    const prefix = month === undefined ? null : parseMonth(month);
    const read = async (em: EntityManager): Promise<CurrencySummary[]> => {
      const movements = (await this.effectiveMovements(em)).filter((row) =>
        !row.voided && (prefix === null || row.occurredOn.startsWith(prefix)));
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

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeRevision(input: VoidMovementInput) {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision >= Number.MAX_SAFE_INTEGER) {
    throw new ValidationError('expectedRevision debe ser un entero seguro no negativo.');
  }
  return {
    sourceKey: requireText(input.sourceKey, 'sourceKey', MAX_SOURCE_KEY_LENGTH),
    movementId: requireText(input.movementId, 'movementId', 36),
    expectedRevision: input.expectedRevision,
    reason: requireText(input.reason, 'reason', MAX_DESCRIPTION_LENGTH),
  };
}

function sameRevision(row: MovementRevision, input: RevisionPayload): boolean {
  return row.movementId === input.movementId && row.expectedRevision === input.expectedRevision &&
    row.kind === input.kind && row.reason === input.reason && row.amountMinor === input.amountMinor &&
    row.occurredOn === input.occurredOn && row.description === input.description && row.category === input.category;
}

async function requireMovement(em: EntityManager, id: string): Promise<Movement> {
  const movement = await em.getRepository(Movement).findOneBy({ id });
  if (movement) return movement;
  if (await em.getRepository(LedgerOperation).existsBy({ id })) {
    throw new ValidationError('Editar/anular aperturas o principales de transferencias no esta soportado; no se revierte parcialmente la operacion.');
  }
  throw new NotFoundError(`No existe el movimiento "${id}".`);
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

function normalizeExpenseCorrection(input: ExpenseCorrectionInput): NormalizedExpenseCorrection {
  if (typeof input.amountMinor !== 'bigint' || input.amountMinor <= 0n) {
    throw new ValidationError('El importe debe ser un entero positivo en unidades menores.');
  }
  const currency: unknown = input.currency;
  if (!isCurrency(currency)) {
    throw new ValidationError(`Moneda no soportada "${String(currency)}".`);
  }
  if (input.occurredOn !== undefined && typeof input.occurredOn !== 'string') {
    throw new ValidationError('La fecha de la operacion es obligatoria.');
  }
  return {
    sourceKey: requireText(input.sourceKey, 'sourceKey', MAX_SOURCE_KEY_LENGTH),
    movementId: requireText(input.movementId, 'movementId', 36),
    amountMinor: input.amountMinor,
    accountId: requireText(input.accountId, 'accountId', 36),
    currency,
    occurredOn: input.occurredOn === undefined ? undefined : parseDate(input.occurredOn),
    description: input.description === undefined ? undefined : requireText(input.description, 'description', MAX_DESCRIPTION_LENGTH),
    reason: input.reason === undefined ? DEFAULT_CORRECTION_REASON : requireText(input.reason, 'reason', MAX_DESCRIPTION_LENGTH),
  };
}

/** Clave propia de una correccion, derivada de su clave y de su sufijo. */
function derivedKey(sourceKey: string, suffix: string): string {
  const key = `${sourceKey}:${suffix}`;
  if (key.length > MAX_SOURCE_KEY_LENGTH) {
    throw new ValidationError(`La clave "${sourceKey}" no admite la clave derivada "${suffix}".`);
  }
  return key;
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

function normalizeLeg(input: TransferLeg, signed = false): TransferLeg {
  const accountId = requireText(input?.accountId, 'accountId', 36);
  const currency: unknown = input.money?.currency;
  const minor: unknown = input.money?.minor;
  if (!isCurrency(currency)) {
    throw new ValidationError(`Moneda no soportada "${String(currency)}".`);
  }
  if (typeof minor !== 'bigint' || (!signed && minor <= 0n)) {
    throw new ValidationError(signed ? 'La apertura debe ser un entero en unidades menores.' : 'El importe debe ser un entero positivo en unidades menores.');
  }
  return { accountId, money: { currency, minor } };
}

function normalizeOperationText(input: Pick<OpeningInput, 'sourceKey' | 'occurredOn' | 'description'>) {
  if (typeof input.occurredOn !== 'string') {
    throw new ValidationError('La fecha de la operacion es obligatoria.');
  }
  return {
    sourceKey: requireText(input.sourceKey, 'sourceKey', MAX_SOURCE_KEY_LENGTH),
    occurredOn: parseDate(input.occurredOn),
    description: input.description === undefined ? null : requireText(input.description, 'description', MAX_DESCRIPTION_LENGTH),
  };
}

/**
 * Un movimiento ligado a un pago de deuda no se edita. Las bases anteriores a la
 * migracion B5 no tienen esa tabla y, por tanto, no tienen pagos de deuda: el veto
 * no aplica y la edicion de movimientos sigue funcionando.
 */
async function isDebtPayment(em: EntityManager, movementId: string): Promise<boolean> {
  const repository = em.getRepository(DebtPayment);
  const runner = em.queryRunner ?? em.connection.createQueryRunner();
  try {
    if (!await runner.hasTable(repository.metadata.tableName)) {
      return false;
    }
    return await repository.existsBy({ movementId });
  } finally {
    if (!em.queryRunner) {
      await runner.release();
    }
  }
}

async function requireOperationAccount(em: EntityManager, id: string, currency: Currency): Promise<void> {
  const account = await em.getRepository(Account).findOneBy({ id });
  if (!account) {
    throw new NotFoundError(`No existe la cuenta "${id}".`);
  }
  if (!account.active || account.currency !== currency) {
    throw new ValidationError(`La cuenta "${account.name}" debe estar activa y operar en ${currency}.`);
  }
}

function sameOperation(operation: LedgerOperation, fee: Movement | null, input: NormalizedOperation): boolean {
  return operation.kind === input.kind && operation.accountId === input.accountId &&
    operation.currency === input.currency && operation.deltaMinor === input.deltaMinor &&
    operation.destinationAccountId === input.destinationAccountId &&
    operation.destinationCurrency === input.destinationCurrency &&
    operation.destinationDeltaMinor === input.destinationDeltaMinor &&
    operation.occurredOn === input.occurredOn && operation.description === input.description &&
    (input.fee === null ? fee === null : fee !== null && fee.accountId === input.fee.accountId &&
      fee.currency === input.fee.money.currency && fee.amountMinor === input.fee.money.minor &&
      fee.kind === 'expense' && fee.occurredOn === input.occurredOn && fee.description === input.description);
}
