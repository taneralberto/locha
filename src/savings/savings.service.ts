import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Account } from '../accounts/account.entity';
import { TransactionRunner } from '../data/transaction.runner';
import { isUniqueViolation } from '../data/unique-violation';
import { dateInTimeZone } from '../domain/date';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import { Currency, formatAmount, isCurrency } from '../domain/money';
import { AccountBalance, FinancialService } from '../financial/financial.service';
import { Goal } from './goal.entity';
import { GoalService, savingsText } from './goal.service';
import { SavingsEntry } from './savings-entry.entity';

export interface SavingsInput {
  sourceKey: string;
  goalId: string;
  accountId: string;
  currency: Currency;
  amountMinor: bigint;
}

export interface SavingsStatus extends AccountBalance {
  reserved: bigint;
  available: bigint;
  deficit: bigint;
}

export interface GoalStatus {
  goal: Goal;
  reserved: bigint;
  remaining: bigint;
  progress: string;
  nominalWithDeficit: boolean;
}

@Injectable()
export class SavingsService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly financial: FinancialService,
    private readonly goals: GoalService,
  ) {}

  reserve(input: SavingsInput, manager?: EntityManager) {
    return this.append('reserve', input, manager);
  }

  release(input: SavingsInput, manager?: EntityManager) {
    return this.append('release', input, manager);
  }

  private async append(kind: SavingsEntry['kind'], input: SavingsInput, manager?: EntityManager): Promise<{ entry: SavingsEntry; created: boolean }> {
    if (!isCurrency(input.currency) || typeof input.amountMinor !== 'bigint' || input.amountMinor <= 0n) {
      throw new ValidationError('La reserva requiere moneda soportada e importe entero positivo en unidades menores.');
    }
    const normalized = {
      sourceKey: savingsText(input.sourceKey, 'sourceKey', 200),
      goalId: savingsText(input.goalId, 'goalId', 36), accountId: savingsText(input.accountId, 'accountId', 36),
      currency: input.currency, amountMinor: input.amountMinor, kind,
    };
    const save = async (em: EntityManager) => {
      const repository = em.getRepository(SavingsEntry);
      const existing = await repository.findOneBy({ sourceKey: normalized.sourceKey });
      // Replay completo antes de consultar fondos, actividad o reservas actuales.
      if (existing) {
        if (existing.kind !== kind || existing.goalId !== normalized.goalId || existing.accountId !== normalized.accountId ||
          existing.currency !== normalized.currency || existing.amountMinor !== normalized.amountMinor) {
          throw new ConflictError('La clave de reserva ya existe con otro contenido.');
        }
        return { entry: existing, created: false };
      }
      const goal = await this.goals.get(normalized.goalId, em);
      const account = await em.getRepository(Account).findOneBy({ id: normalized.accountId });
      if (!account) throw new NotFoundError(`No existe la cuenta "${normalized.accountId}".`);
      if (account.currency !== normalized.currency || goal.currency !== normalized.currency) {
        throw new ValidationError('La moneda de cuenta, meta e importe debe coincidir.');
      }
      const snapshot = await this.snapshot(em);
      const pair = snapshot.pairs.get(goal.id)?.get(account.id) ?? 0n;
      if (kind === 'reserve') {
        if (!account.active) throw new ValidationError('La cuenta esta inactiva.');
        const status = snapshot.accounts.find((row) => row.accountId === account.id)!;
        if (normalized.amountMinor > status.available) throw new ConflictError('Fondos disponibles insuficientes para reservar.');
      } else if (normalized.amountMinor > pair) {
        throw new ConflictError('La liberacion supera la reserva actual de esa meta y cuenta.');
      }
      try {
        return { entry: await repository.save(repository.create(normalized)), created: true };
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictError('La clave de reserva ya existe.');
        throw error;
      }
    };
    return manager ? save(manager) : this.transactions.run(save);
  }

  /** Solo estado actual, sin mezclar reservas actuales con saldos historicos/futuros. */
  async status(accountId?: string, manager?: EntityManager): Promise<SavingsStatus[]> {
    const id = accountId === undefined ? undefined : savingsText(accountId, 'accountId', 36);
    const read = async (em: EntityManager) => {
      const rows = (await this.snapshot(em)).accounts;
      if (id !== undefined && !rows.some((row) => row.accountId === id)) throw new NotFoundError(`No existe la cuenta "${id}".`);
      return rows.filter((row) => id === undefined || row.accountId === id);
    };
    return manager ? read(manager) : this.transactions.run(read);
  }

  async goalStatus(goalId?: string, manager?: EntityManager): Promise<GoalStatus[]> {
    const read = async (em: EntityManager) => {
      const goals = goalId === undefined ? await this.goals.list(em) : [await this.goals.get(goalId, em)];
      const snapshot = await this.snapshot(em);
      return goals.map((goal) => {
        const pairs = snapshot.pairs.get(goal.id) ?? new Map<string, bigint>();
        const reserved = [...pairs.values()].reduce((total, amount) => total + amount, 0n);
        const remaining = goal.targetMinor > reserved ? goal.targetMinor - reserved : 0n;
        const hundredths = reserved * 10000n / goal.targetMinor;
        const progress = `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}%`;
        const nominalWithDeficit = snapshot.accounts.some((row) => row.currency === goal.currency && row.deficit > 0n && (pairs.get(row.accountId) ?? 0n) > 0n);
        return { goal, reserved, remaining, progress, nominalWithDeficit };
      });
    };
    return manager ? read(manager) : this.transactions.run(read);
  }

  async history(options: { accountId?: string | undefined; goalId?: string | undefined } = {}, manager?: EntityManager): Promise<SavingsEntry[]> {
    const accountId = options.accountId === undefined ? undefined : savingsText(options.accountId, 'accountId', 36);
    const goalId = options.goalId === undefined ? undefined : savingsText(options.goalId, 'goalId', 36);
    const read = async (em: EntityManager) => {
      if (goalId !== undefined) await this.goals.get(goalId, em);
      if (accountId !== undefined && !await em.getRepository(Account).existsBy({ id: accountId })) throw new NotFoundError(`No existe la cuenta "${accountId}".`);
      return em.getRepository(SavingsEntry).find({
        where: { ...(accountId === undefined ? {} : { accountId }), ...(goalId === undefined ? {} : { goalId }) },
        order: { createdAt: 'ASC', sourceKey: 'ASC' },
      });
    };
    return manager ? read(manager) : this.transactions.run(read);
  }

  /**
   * Avisos de deficit actual. La CLI los muestra con el id de la cuenta (sus ids son
   * la forma de consultarla); el bot los pide con el nombre, que es lo que el usuario
   * conoce.
   */
  async warnings(options: { names?: boolean } = {}): Promise<string[]> {
    return (await this.status()).filter((row) => row.deficit > 0n).map((row) =>
      `ADVERTENCIA: cuenta ${options.names === true ? row.name : row.accountId} | ${row.currency} | deficit ${formatAmount(row.deficit, row.currency)} | disponible ${formatAmount(row.available, row.currency)}; reservas preservadas, no se liberan automaticamente.`);
  }

  /** Unica aritmetica de reservas: pares -> agregado por cuenta, siempre bigint. */
  private async snapshot(manager: EntityManager) {
    const pairs = new Map<string, Map<string, bigint>>();
    const totals = new Map<string, bigint>();
    for (const entry of await manager.getRepository(SavingsEntry).find()) {
      const delta = entry.kind === 'reserve' ? entry.amountMinor : -entry.amountMinor;
      const accounts = pairs.get(entry.goalId) ?? new Map<string, bigint>();
      accounts.set(entry.accountId, (accounts.get(entry.accountId) ?? 0n) + delta);
      pairs.set(entry.goalId, accounts);
      totals.set(entry.accountId, (totals.get(entry.accountId) ?? 0n) + delta);
    }
    const today = dateInTimeZone(new Date(), 'America/Caracas');
    const accounts = (await this.financial.balances(today, manager)).map((row): SavingsStatus => {
      const reserved = totals.get(row.accountId) ?? 0n;
      const available = row.balance - reserved;
      return { ...row, reserved, available, deficit: available < 0n ? -available : 0n };
    });
    return { pairs, accounts };
  }
}
