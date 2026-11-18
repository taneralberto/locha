import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { Account } from '../../src/accounts/account.entity';
import { TransactionRunner } from '../../src/data/transaction.runner';
import { DebtPayment } from '../../src/debts/debt-payment.entity';
import { BalanceReconciliation } from '../../src/financial/balance-reconciliation.entity';
import { LedgerOperation } from '../../src/financial/ledger-operation.entity';
import { Movement } from '../../src/financial/movement.entity';
import { MovementRevision } from '../../src/financial/movement-revision.entity';

type Row = Record<string, unknown>;

const TABLE_BY_ENTITY = new Map<unknown, string>([
  [Account, 'account'],
  [BalanceReconciliation, 'balance_reconciliation'],
  [DebtPayment, 'debt_payment'],
  [LedgerOperation, 'ledger_operation'],
  [Movement, 'movement'],
  [MovementRevision, 'movement_revision'],
]);

export interface FakeFindOptions {
  where?: Record<string, unknown>;
  order?: Record<string, 'ASC' | 'DESC'>;
}

/**
 * Gestor de entidades en memoria para ejercitar el dominio sin base de datos.
 * Reproduce lo que el dominio necesita: busquedas por igualdad y por operador,
 * orden, altas y el savepoint de una transaccion (una correccion que falla se
 * revierte sin tocar lo que habia antes).
 */
export class FakeEntityManager {
  private readonly tables = new Map<string, Row[]>();
  private readonly failures = new Map<string, Error>();

  constructor() {
    for (const table of TABLE_BY_ENTITY.values()) {
      this.tables.set(table, []);
    }
  }

  /** Filas de una tabla, en orden de insercion. */
  rows(table: string): Row[] {
    return this.tables.get(table) ?? [];
  }

  /** Inserta una fila y devuelve la fila guardada, con su identificador. */
  insert<T extends object>(table: string, row: Partial<T>): T {
    const stored = { ...row, id: (row as { id?: string }).id ?? randomUUID() } as unknown as Row;
    this.tables.get(table)?.push(stored);
    return stored as unknown as T;
  }

  /** Hace fallar el siguiente guardado de una tabla. */
  failSave(table: string, error: Error): void {
    this.failures.set(table, error);
  }

  /** Toma el fallo pendiente de una tabla, si lo hay. */
  takeFailure(table: string): Error | undefined {
    const failure = this.failures.get(table);
    this.failures.delete(table);
    return failure;
  }

  snapshot(): Map<string, Row[]> {
    return new Map([...this.tables].map(([table, rows]) => [table, rows.map((row) => ({ ...row }))]));
  }

  restore(snapshot: Map<string, Row[]>): void {
    for (const [table, rows] of snapshot) {
      this.tables.set(table, rows.map((row) => ({ ...row })));
    }
  }

  getRepository<T extends Row>(entity: unknown): FakeRepository<T> {
    const table = TABLE_BY_ENTITY.get(entity);
    if (table === undefined) {
      throw new Error(`Entidad sin tabla en el gestor falso: ${String(entity)}`);
    }
    return new FakeRepository<T>(this, table);
  }

  /** Savepoint: la base real lo resuelve con SAVEPOINT y ROLLBACK TO SAVEPOINT. */
  async transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    const snapshot = this.snapshot();
    try {
      return await work(this as unknown as EntityManager);
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  readonly queryRunner = {
    hasTable: async (table: string): Promise<boolean> => this.tables.has(table),
  };

  readonly connection = {
    createQueryRunner: () => this.queryRunner,
  };
}

class FakeRepository<T extends Row> {
  /** El dominio consulta el nombre de la tabla para saber si existe. */
  readonly metadata: { tableName: string };

  constructor(private readonly manager: FakeEntityManager, private readonly table: string) {
    this.metadata = { tableName: table };
  }

  create(entity: Partial<T>): T {
    return { ...entity } as T;
  }

  async save(entity: T): Promise<T> {
    const failure = this.manager.takeFailure(this.table);
    if (failure) {
      throw failure;
    }
    const stored = { ...entity } as Row;
    if (!stored.id) {
      stored.id = randomUUID();
    }
    const rows = this.manager.rows(this.table);
    const index = rows.findIndex((row) => row.id === stored.id);
    if (index >= 0) {
      rows[index] = stored;
    } else {
      rows.push(stored);
    }
    return stored as T;
  }

  async find(options: FakeFindOptions = {}): Promise<T[]> {
    let rows = [...this.manager.rows(this.table)];
    if (options.where) {
      rows = rows.filter((row) => matches(row, options.where!));
    }
    if (options.order) {
      rows = sortRows(rows, options.order!);
    }
    return rows as T[];
  }

  async findOne(options: FakeFindOptions = {}): Promise<T | null> {
    return (await this.find(options))[0] ?? null;
  }

  async findOneBy(where: Record<string, unknown>): Promise<T | null> {
    return this.findOne({ where });
  }

  async existsBy(where: Record<string, unknown>): Promise<boolean> {
    return (await this.find({ where })).length > 0;
  }
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([column, expected]) => matchesValue(row[column], expected));
}

function matchesValue(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') {
    return actual === expected;
  }
  const operator = expected as { type?: string; value?: unknown };
  switch (operator.type) {
    case 'lessThan':
      return compareValues(actual, operator.value) < 0;
    case 'lessThanOrEqual':
      return compareValues(actual, operator.value) <= 0;
    case 'moreThan':
      return compareValues(actual, operator.value) > 0;
    case 'moreThanOrEqual':
      return compareValues(actual, operator.value) >= 0;
    default:
      return actual === operator.value;
  }
}

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortRows(rows: Row[], order: Record<string, 'ASC' | 'DESC'>): Row[] {
  return [...rows].sort((left, right) => {
    for (const [column, direction] of Object.entries(order)) {
      const comparison = compareValues(left[column], right[column]);
      if (comparison !== 0) {
        return direction === 'ASC' ? comparison : -comparison;
      }
    }
    return 0;
  });
}

/** Runner de transacciones en memoria: una correccion fallida se revierte entera. */
export function fakeTransactions(manager: FakeEntityManager): TransactionRunner {
  return {
    run: async <T>(work: (em: EntityManager) => Promise<T>): Promise<T> => {
      const snapshot = manager.snapshot();
      try {
        return await work(manager as unknown as EntityManager);
      } catch (error) {
        manager.restore(snapshot);
        throw error;
      }
    },
  } as unknown as TransactionRunner;
}
