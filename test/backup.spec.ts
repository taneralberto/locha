import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Account } from '../src/accounts/account.entity';
import { AccountService } from '../src/accounts/account.service';
import { backupDatabase, publishCopy, restoreDatabase, validateDatabase } from '../src/data/backup';
import { TransactionRunner } from '../src/data/transaction.runner';
import { FinancialService } from '../src/financial/financial.service';
import { createTempDatabase, openDatabase } from './helpers/temp-database';

describe('Copia de seguridad y restauracion', () => {
  let directory: string;
  let source: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'locha-backup-'));
    const database = await createTempDatabase();
    const accounts = new AccountService(database.dataSource, database.transactions);
    const account = await accounts.add({ name: 'Efectivo', currency: 'USD' });
    const financial = new FinancialService(database.transactions);
    await financial.register({
      sourceKey: 'telegram:1',
      accountId: account.id,
      kind: 'expense',
      money: { currency: 'USD', minor: 1250n },
      occurredOn: '2026-11-10',
    });
    await database.close();
    source = database.path;
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('crea una copia valida con los mismos totales', async () => {
    const destination = join(directory, 'copia.sqlite');

    const result = await backupDatabase(source, destination);

    expect(result.destination).toBe(destination);
    expect(existsSync(destination)).toBe(true);

    const restored = await openDatabase(destination);
    const financial = new FinancialService(new TransactionRunner(restored));
    const summary = await financial.summary();
    expect(summary.find((entry) => entry.currency === 'USD')?.expense).toBe(1250n);
    await restored.destroy();
  });

  it('no pisa un destino que ya existe', async () => {
    const destination = join(directory, 'copia.sqlite');
    writeFileSync(destination, 'contenido previo');

    await expect(backupDatabase(source, destination)).rejects.toThrow(/ya existe/);
    expect(existsSync(destination)).toBe(true);
  });

  it('restaura en una ruta nueva y nunca sobre la base actual', async () => {
    const copy = join(directory, 'copia.sqlite');
    await backupDatabase(source, copy);

    const restoredPath = join(directory, 'restaurada.sqlite');
    await restoreDatabase(copy, restoredPath);

    expect(existsSync(restoredPath)).toBe(true);
    await expect(restoreDatabase(copy, restoredPath)).rejects.toThrow(/ya existe/);
  });

  it('rechaza una copia que no es una base valida', async () => {
    const invalid = join(directory, 'no-es-una-base.sqlite');
    writeFileSync(invalid, 'esto no es una base de datos');

    await expect(backupDatabase(invalid, join(directory, 'copia.sqlite'))).rejects.toThrow();
    expect(() => validateDatabase(invalid)).toThrow();
  });

  it('no pisa un destino que aparece mientras se copia', async () => {
    const destination = join(directory, 'copia.sqlite');
    // El destino aparece entre la comprobacion y la publicacion.
    writeFileSync(destination, 'contenido ajeno');

    await expect(publishCopy(source, destination, false)).rejects.toThrow(/ya existe/);

    // El archivo que apareció no se toco.
    expect(readFileSync(destination, 'utf8')).toBe('contenido ajeno');
  });

  it('no destruye la base si el destino es un alias suyo', async () => {
    const real = join(directory, 'real');
    mkdirSync(real, { recursive: true });
    const realDatabase = join(real, 'locha.sqlite');
    copyFileSync(source, realDatabase);
    const alias = join(directory, 'alias');
    symlinkSync(real, alias, 'junction');

    await expect(
      backupDatabase(realDatabase, join(alias, 'locha.sqlite'), { force: true }),
    ).rejects.toThrow(/no puede ser la base de datos/);

    // La base sigue intacta.
    const restored = await openDatabase(realDatabase);
    expect(await restored.getRepository(Account).count()).toBe(1);
    await restored.destroy();
  });
});
