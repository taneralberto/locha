import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { symlinkSync } from 'node:fs';
import { canonicalPath } from '../src/data/paths';

describe('Rutas canonicas', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'locha-paths-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('devuelve la ruta real de un archivo que existe', () => {
    const file = join(directory, 'locha.sqlite');
    writeFileSync(file, '');

    expect(canonicalPath(file)).toBe(canonicalPath(join(directory, '.', 'locha.sqlite')));
  });

  it('colapsa un enlace simbolico al directorio', () => {
    const real = join(directory, 'real');
    const alias = join(directory, 'alias');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, alias, 'junction');

    expect(canonicalPath(join(alias, 'locha.sqlite'))).toBe(
      canonicalPath(join(real, 'locha.sqlite')),
    );
  });

  it('colapsa la capitalizacion distinta en Windows', () => {
    if (process.platform !== 'win32') {
      return;
    }
    writeFileSync(join(directory, 'locha.sqlite'), '');

    expect(canonicalPath(join(directory, 'LOCHA.SQLITE'))).toBe(
      canonicalPath(join(directory, 'locha.sqlite')),
    );
  });

  it('canonicaliza el padre aunque el archivo todavia no exista', () => {
    const real = join(directory, 'real');
    const alias = join(directory, 'alias');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, alias, 'junction');

    expect(canonicalPath(join(alias, 'nuevo.sqlite'))).toBe(
      canonicalPath(join(real, 'nuevo.sqlite')),
    );
  });
});
