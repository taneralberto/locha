import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireInstanceLock,
  LockError,
  lockPathFor,
  releaseInstanceLock,
} from '../src/lock/instance-lock';

describe('Cerrojo de una sola instancia', () => {
  let directory: string;
  let lockPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'locha-lock-'));
    lockPath = lockPathFor(join(directory, 'locha.sqlite'));
  });

  afterEach(() => {
    releaseInstanceLock();
    rmSync(directory, { recursive: true, force: true });
  });

  it('toma el cerrojo y lo suelta', () => {
    const lock = acquireInstanceLock({ path: lockPath, label: 'prueba' });

    expect(existsSync(lock.path)).toBe(true);
    expect(existsSync(join(lock.path, 'owner.json'))).toBe(true);

    lock.release();
    expect(existsSync(lock.path)).toBe(false);
  });

  it('no permite dos instancias a la vez', () => {
    const lock = acquireInstanceLock({ path: lockPath, label: 'prueba' });

    expect(() => acquireInstanceLock({ path: lockPath, label: 'prueba' })).toThrow(LockError);
    expect(() => acquireInstanceLock({ path: lockPath, label: 'prueba' })).toThrow(
      /otra instancia|cerrojo/,
    );

    lock.release();
  });

  it('no recupera un cerrojo obsoleto: la recuperacion es manual', () => {
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(lockPath, 'owner.json'),
      JSON.stringify({ pid: 999_999, label: 'viejo', startedAt: '2026-01-01T00:00:00.000Z' }),
      'utf8',
    );

    // El proceso ya no existe, pero el cerrojo no se roba: decide el operador.
    expect(() => acquireInstanceLock({ path: lockPath, label: 'prueba' })).toThrow(
      /borra ese directorio manualmente/,
    );
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(join(lockPath, 'owner.json'))).toBe(true);
  });

  it('no roba un cerrojo del que no se puede saber el dueño', () => {
    mkdirSync(lockPath, { recursive: true });

    expect(() => acquireInstanceLock({ path: lockPath, label: 'prueba' })).toThrow(
      /manualmente/,
    );
    // El cerrojo ajeno sigue intacto.
    expect(existsSync(lockPath)).toBe(true);
  });

  it('un enlace a la base no esquiva el cerrojo', () => {
    const real = join(directory, 'real');
    const alias = join(directory, 'alias');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, alias, 'junction');

    const realPath = lockPathFor(join(real, 'locha.sqlite'));
    const aliasPath = lockPathFor(join(alias, 'locha.sqlite'));

    expect(aliasPath).toBe(realPath);

    const lock = acquireInstanceLock({ path: aliasPath, label: 'prueba' });

    expect(() => acquireInstanceLock({ path: realPath, label: 'prueba' })).toThrow(LockError);
    lock.release();
  });

  it('otra capitalizacion de la base no esquiva el cerrojo', () => {
    if (process.platform !== 'win32') {
      // En Linux las rutas distinguen mayusculas: no hay alias que colapsar.
      return;
    }
    writeFileSync(join(directory, 'locha.sqlite'), '');
    const variant = lockPathFor(join(directory, 'LOCHA.SQLITE'));

    expect(variant).toBe(lockPath);
  });
});
