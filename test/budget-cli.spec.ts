import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('CLI B3 (subprocesos y SQLite temporal)', () => {
  let directory: string;
  let env: NodeJS.ProcessEnv;
  let budgetId: string;

  function cli(...args: string[]) {
    const result = spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], { env, encoding: 'utf8', timeout: 20000 });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout.trim(), error: result.stderr.trim() };
  }
  const add = () => ['budget:add', '--source-key', 'budget', '--name', 'Noviembre', '--currency', 'USDT', '--limit', '9007199254740993.123456', '--month', '2026-11'];

  beforeAll(() => {
    const build = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { encoding: 'utf8', timeout: 30000 });
    expect(build.status).toBe(0);
    directory = mkdtempSync(join(tmpdir(), 'locha-b3-cli-'));
    env = { ...process.env, DATABASE_PATH: join(directory, 'cli.sqlite'), TELEGRAM_BOT_TOKEN: '', TELEGRAM_ALLOWED_USER_ID: '', TELEGRAM_ALLOWED_CHAT_ID: '', OPENROUTER_API_KEY: '', OPENROUTER_MODEL: '' };
    expect(cli('migration:run').output).toContain('Budgets1780617600000');
    const created = cli('account:add', '--name', 'USDT', '--currency', 'USDT');
    expect(created.status).toBe(0);
    const account = /Cuenta creada ([\da-f-]{36})/.exec(created.output)![1]!;
    expect(cli('movement:add', '--source-key', 'expense', '--account', account, '--currency', 'USDT', '--kind', 'expense', '--amount', '9007199254740993.123457', '--on', '2026-11-10').status).toBe(0);
  }, 60000);
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  it('crea/replay por payload normalizado, lista definiciones y estado exacto sin sumar restantes', () => {
    const result = cli(...add());
    expect(result.status).toBe(0);
    budgetId = /Presupuesto ([\da-f-]{36})/.exec(result.output)![1]!;
    expect(cli(...add()).output).toBe(result.output.replace('creado', 'existente'));
    const explicit = [...add().slice(0, -2), '--from', '2026-11-01', '--to', '2026-11-30'];
    expect(cli(...explicit).output).toContain('existente');
    const list = JSON.parse(cli('budget:list').output);
    expect(list).toMatchObject([{ id: budgetId, limitMinor: '9007199254740993123456', category: null, startsOn: '2026-11-01', endsOn: '2026-11-30' }]);
    const status = cli('budget:status', '--on', '2026-11-10');
    expect(status.status).toBe(0);
    expect(status.output).toContain('limite 9007199254740993.123456 | gastado 9007199254740993.123457 | restante -0.000001 | excedido');
    expect(status.output).toContain('no sumar restantes');
    expect(cli('budget:status', '--budget', budgetId, '--on', '2026-10-31').output).toContain('gastado 0.000000');
    expect(cli('budget:status', '--on', '2026-12-01').output).toContain('No hay presupuestos activos');
    expect(cli('budget:status', '--budget', budgetId, '--on', '2027-01-01').output).toContain('restante -0.000001');
    expect(cli(...add().map((arg) => arg === 'Noviembre' ? 'Conflicto' : arg)).error).toContain('otro contenido');
  }, 120000);

  it('mes/quincenas reales, limites cero y monedas/categorias independientes', () => {
    for (const half of ['first', 'second']) {
      const created = cli('budget:add', '--source-key', half, '--name', half, '--currency', 'USD', '--limit', '0', '--month', '2024-02', '--half', half, '--category', ' Comida ');
      expect(created.status).toBe(0);
    }
    expect(cli('budget:add', '--source-key', 'whole', '--name', 'Febrero', '--currency', 'USD', '--limit', '0.00', '--month', '2024-02').status).toBe(0);
    expect(JSON.parse(cli('budget:list').output)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKey: 'first', category: 'Comida', limitMinor: '0', startsOn: '2024-02-01', endsOn: '2024-02-15' }),
      expect.objectContaining({ sourceKey: 'second', startsOn: '2024-02-16', endsOn: '2024-02-29' }),
      expect.objectContaining({ sourceKey: 'whole', startsOn: '2024-02-01', endsOn: '2024-02-29' }),
    ]));
    expect(cli('budget:status', '--on', '2024-02-29').output).toContain('categoria Comida');
  }, 120000);

  it('rechaza argumentos desconocidos/repetidos/incompletos, periodos ambiguos y datos invalidos sin escribir', () => {
    const before = cli('budget:list').output;
    const base = ['budget:add', '--source-key', 'bad', '--name', 'Bad', '--currency', 'USD', '--limit', '0'];
    for (const args of [
      ['budget:add'], [...add(), '--unknown', 'x'], [...add(), '--name', 'Duplicado'], [...add(), 'posicional'],
      ['budget:list', '--on', '2026-11-01'], ['budget:status', '--on'], ['budget:status', '--budget'],
      ['budget:status', '--budget', 'missing'], ['budget:status', '--on', '2026-02-30'],
      [...base], [...base, '--from', '2026-11-01'], [...base, '--to', '2026-11-30'],
      [...base, '--month', '2026-13'], [...base, '--month', '2026-11', '--half', 'third'],
      [...base, '--half', 'first', '--from', '2026-11-01', '--to', '2026-11-30'],
      [...base, '--month', '2026-11', '--from', '2026-11-01'],
      [...base, '--month', '2026-11', '--to', '2026-11-30'],
      [...base, '--from', '2026-11-30', '--to', '2026-11-01'],
      [...base, '--from', '2026-02-29', '--to', '2026-03-01'],
      [...base, '--month', '2026-11', '--category'],
      ...['-1', '-0', '0.001', '1e3'].map((amount) => [...base.map((arg) => arg === '0' ? amount : arg), '--month', '2026-11']),
      [...base, '--month', '2024-02'], // already occupied global USD
    ]) expect({ args, result: cli(...args) }).toMatchObject({ result: { status: 1 } });
    expect(cli('budget:list').output).toBe(before);
  }, 120000);
});
