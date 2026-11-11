import { ChildProcess, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as ts from 'typescript';
import {
  acquireInstanceLock,
  LockError,
  lockPathFor,
  releaseInstanceLock,
} from '../src/lock/instance-lock';

/** Fuentes del cerrojo que necesita el proceso hijo. */
const LOCK_SOURCES = ['src/lock/instance-lock.ts', 'src/data/paths.ts'];

/** Proceso hijo: toma el cerrojo y lo mantiene hasta que lo terminan. */
const CHILD_SCRIPT = `
const { acquireInstanceLock } = require('./src/lock/instance-lock.js');
let lock;
try {
  lock = acquireInstanceLock({ path: process.argv[2], label: 'proceso-hijo' });
} catch (error) {
  process.stdout.write('ocupado\\n');
  process.exit(0);
}
process.stdout.write('tomado\\n');
process.on('SIGTERM', () => {
  lock.release();
  process.exit(0);
});
setInterval(() => undefined, 1000);
`;

/**
 * Compila el cerrojo en un directorio temporal para que otro proceso pueda usarlo:
 * el proceso hijo es limpio y usa el codigo real.
 */
function compileLock(workspace: string): void {
  for (const source of LOCK_SOURCES) {
    const code = readFileSync(join(__dirname, '..', source), 'utf8');
    const output = ts.transpileModule(code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
      fileName: source,
    }).outputText;
    const target = join(workspace, source.replace(/\.ts$/, '.js'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, output);
  }
  writeFileSync(join(workspace, 'hijo.js'), CHILD_SCRIPT, 'utf8');
}

/** Espera a que el proceso hijo escriba el texto esperado. */
function waitForOutput(child: ChildProcess, expected: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(expected)) {
        resolve(output);
      }
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      reject(new Error(`El proceso hijo termino con el codigo ${code}: ${output}`)),
    );
  });
}

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

  it('otro proceso no puede tomar un cerrojo que ya esta tomado', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'locha-lock-proceso-'));
    compileLock(workspace);
    const child = spawn(process.execPath, [join(workspace, 'hijo.js'), lockPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      // El hijo toma el cerrojo con el codigo real, en un proceso limpio.
      await waitForOutput(child, 'tomado');
      expect(existsSync(lockPath)).toBe(true);

      // Esta instancia no puede tomar el mismo cerrojo.
      expect(() => acquireInstanceLock({ path: lockPath, label: 'prueba' })).toThrow(LockError);
    } finally {
      child.kill('SIGTERM');
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 20_000);

  it('un cerrojo tomado por esta instancia excluye a otro proceso', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'locha-lock-proceso-'));
    compileLock(workspace);
    const child = spawn(process.execPath, [join(workspace, 'hijo.js'), lockPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const lock = acquireInstanceLock({ path: lockPath, label: 'prueba' });

      // El otro proceso no puede tomar el cerrojo: no se roba.
      const output = await waitForOutput(child, 'ocupado');
      expect(output).toContain('ocupado');
      lock.release();
    } finally {
      child.kill('SIGTERM');
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 20_000);
});
