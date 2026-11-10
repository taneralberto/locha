import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalPath } from '../data/paths';

/**
 * Cerrojo de una sola instancia local. Vive en un directorio junto a la base de datos
 * y guarda el pid del proceso que lo tiene. Solo un proceso puede escribir en la base:
 * el bot y la CLI no pueden correr a la vez.
 *
 * **No hay recuperacion automatica.** Si el directorio del cerrojo ya existe, el
 * proceso se niega a arrancar: puede que haya otra instancia viva, puede que el
 * proceso anterior muriera de golpe y puede que el pid se haya reutilizado. Decide
 * el operador: comprueba que no haya ningun proceso con ese pid y borra el directorio
 * a mano. Un cerrojo nunca se roba.
 */
export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

export interface InstanceLock {
  /** Ruta canonica del directorio del cerrojo. */
  readonly path: string;
  /** Libera el cerrojo. Es idempotente. */
  release: () => void;
}

interface LockOwner {
  pid: number;
  label: string;
  startedAt: string;
}

const OWNER_FILE = 'owner.json';

/**
 * Ruta del directorio del cerrojo de una base de datos. Vive junto a ella para que
 * solo se pueda abrir la base de un solo modo. La ruta se canoniza para que un
 * enlace simbolico o una capitalizacion distinta no esquiven el cerrojo.
 */
export function lockPathFor(databasePath: string): string {
  return `${canonicalPath(databasePath)}.lock`;
}

/** Cerrojo tomado en este proceso: solo puede haber uno. */
let current: InstanceLock | null = null;

/**
 * Toma el cerrojo de la instancia local. Falla si el directorio del cerrojo ya
 * existe: la recuperacion es manual.
 *
 * `path` es el directorio del cerrojo (por ejemplo `data/locha.sqlite.lock`).
 */
export function acquireInstanceLock(options: { path: string; label: string }): InstanceLock {
  const directory = canonicalPath(options.path);
  mkdirSync(dirname(directory), { recursive: true });
  try {
    mkdirSync(directory);
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
    throw new LockError(lockedMessage(directory));
  }
  writeOwner(directory, options.label);
  const lock: InstanceLock = {
    path: directory,
    release: () => releaseLock(directory),
  };
  current = lock;
  return lock;
}

/** Libera el cerrojo tomado por este proceso, si lo hay. */
export function releaseInstanceLock(): void {
  if (!current) {
    return;
  }
  const lock = current;
  current = null;
  lock.release();
}

/**
 * Borra el cerrojo de una base concreta. Solo lo usa el supervisor de desarrollo,
 * que sabe que el proceso que lo tenia ya termino: en el uso normal el cerrojo se
 * suelta solo y nunca se roba.
 */
export function removeLockFor(databasePath: string): void {
  const directory = lockPathFor(databasePath);
  const owner = readOwner(directory);
  if (owner && isProcessAlive(owner.pid)) {
    throw new LockError(
      `El cerrojo "${directory}" lo tiene un proceso vivo (pid ${owner.pid}). No se toca.`,
    );
  }
  rmSync(directory, { recursive: true, force: true });
}

/** Mensaje de cerrojo ocupado: incluye como recuperarlo a mano. */
function lockedMessage(directory: string): string {
  const owner = readOwner(directory);
  const ownerText = owner
    ? `lo tiene el proceso ${owner.pid}`
    : 'y no se puede saber que proceso lo tiene';
  return [
    `Ya existe el cerrojo "${directory}" (${ownerText}).`,
    'Comprueba que ninguna otra instancia este corriendo y borra ese directorio manualmente para continuar.',
  ].join(' ');
}

function writeOwner(directory: string, label: string): void {
  const owner: LockOwner = {
    pid: process.pid,
    label,
    startedAt: new Date().toISOString(),
  };
  const temporary = join(directory, `${OWNER_FILE}.tmp`);
  writeFileSync(temporary, JSON.stringify(owner), 'utf8');
  renameSync(temporary, join(directory, OWNER_FILE));
}

function readOwner(directory: string): LockOwner | null {
  try {
    const raw = readFileSync(join(directory, OWNER_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid)) {
      return null;
    }
    return {
      pid: parsed.pid,
      label: typeof parsed.label === 'string' ? parsed.label : '',
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    };
  } catch {
    return null;
  }
}

function releaseLock(directory: string): void {
  const owner = readOwner(directory);
  if (!owner || owner.pid !== process.pid) {
    // El cerrojo ya no es nuestro (o quedo a medias): no se toca.
    return;
  }
  rmSync(directory, { recursive: true, force: true });
}

/** `true` si el proceso existe (o si no se puede saber porque no es nuestro). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}
