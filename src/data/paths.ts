import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Ruta canonica de un archivo: resuelve enlaces simbolicos y, en Windows, la
 * capitalizacion real del disco. Asi, dos formas de nombrar el mismo archivo (por
 * ejemplo con un enlace o con distinta capitalizacion) apuntan al mismo sitio y no
 * pueden esquivar el cerrojo ni una copia de seguridad.
 *
 * Si la ruta todavia no existe, se canoniza el directorio padre (y, si tampoco
 * existe, el ancestro mas cercano que exista) y se le anade el nombre final.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (parent === absolute) {
    return absolute;
  }
  if (!existsSync(parent)) {
    // El padre tampoco existe: se canoniza el ancestro mas cercano que exista.
    return join(canonicalPath(parent), basename(absolute));
  }
  const realParent = canonicalPath(parent);
  const candidate = join(realParent, basename(absolute));
  if (!existsSync(candidate)) {
    return candidate;
  }
  const real = realpathSync(candidate);
  return join(dirname(real), existingName(dirname(real), basename(real)));
}

/** Nombre real del archivo en el directorio: en Windows no distingue mayusculas. */
function existingName(directory: string, name: string): string {
  if (process.platform !== 'win32') {
    return name;
  }
  try {
    const entries = readdirSync(directory);
    return entries.find((entry) => entry.toLowerCase() === name.toLowerCase()) ?? name;
  } catch {
    return name;
  }
}
