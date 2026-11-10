import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/data/data-source';
import { TransactionRunner } from '../../src/data/transaction.runner';

export interface TempDatabase {
  path: string;
  dataSource: DataSource;
  /** Runner de transacciones de esta conexion: misma cola que usa la aplicacion. */
  transactions: TransactionRunner;
  /** Cierra la conexion sin borrar el archivo: simula un reinicio del proceso. */
  close: () => Promise<void>;
  cleanup: () => Promise<void>;
}

/** Base de datos temporal con el esquema de las migraciones ya aplicado. */
export async function createTempDatabase(): Promise<TempDatabase> {
  const directory = mkdtempSync(join(tmpdir(), 'locha-test-'));
  const path = join(directory, 'locha.sqlite');
  const dataSource = new DataSource(buildDataSourceOptions(path));
  await dataSource.initialize();
  await dataSource.runMigrations();
  return {
    path,
    dataSource,
    transactions: new TransactionRunner(dataSource),
    close: async () => {
      if (dataSource.isInitialized) {
        await dataSource.destroy();
      }
    },
    cleanup: async () => {
      if (dataSource.isInitialized) {
        await dataSource.destroy();
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Abre una base de datos existente aplicando las migraciones pendientes. */
export async function openDatabase(path: string): Promise<DataSource> {
  const dataSource = new DataSource(buildDataSourceOptions(path));
  await dataSource.initialize();
  await dataSource.runMigrations();
  return dataSource;
}
