import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

/**
 * Una conexion SQLite admite una sola transaccion activa: dos transacciones simultaneas
 * sobre el mismo `DataSource` fallan con "cannot start a transaction within a transaction".
 * La cola se guarda por `DataSource` para que todo el proceso use la misma, aunque se
 * cree mas de una instancia de este runner.
 */
const queues = new WeakMap<DataSource, Promise<unknown>>();

@Injectable()
export class TransactionRunner {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Ejecuta `work` dentro de una transaccion propia, serializada con las demas de esta
   * conexion. Si `work` falla, la transaccion se revierte y la cola sigue disponible.
   */
  run<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    const previous = queues.get(this.dataSource) ?? Promise.resolve();
    const result = previous.then(() => this.dataSource.transaction(work));
    queues.set(
      this.dataSource,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}
