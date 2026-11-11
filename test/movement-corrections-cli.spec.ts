import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('CLI B2 (procesos reales, base temporal)', () => {
  let directory: string;
  let env: NodeJS.ProcessEnv;
  let account: string;
  let movement: string;

  function cli(...args: string[]) {
    const result = spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], { env, encoding: 'utf8', timeout: 20000 });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout.trim(), error: result.stderr.trim() };
  }

  beforeAll(() => {
    const build = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { encoding: 'utf8', timeout: 30000 });
    expect(build.status).toBe(0);
    directory = mkdtempSync(join(tmpdir(), 'locha-b2-cli-'));
    env = { ...process.env, DATABASE_PATH: join(directory, 'cli.sqlite'), TELEGRAM_BOT_TOKEN: '', TELEGRAM_ALLOWED_USER_ID: '', TELEGRAM_ALLOWED_CHAT_ID: '', OPENROUTER_API_KEY: '', OPENROUTER_MODEL: '' };
    expect(cli('migration:run').output).toContain('MovementCorrections1777939200000');
    const created = cli('account:add', '--name', 'Efectivo', '--currency', 'USDT');
    expect(created.status).toBe(0);
    account = /Cuenta creada ([\da-f-]{36})/.exec(created.output)![1]!;
    const added = cli('movement:add', '--source-key', 'original', '--account', account, '--currency', 'USDT', '--kind', 'expense', '--amount', '1.123456', '--on', '2026-10-01');
    expect(added.status).toBe(0);
    movement = /Movimiento ([\da-f-]{36})/.exec(added.output)![1]!;
  }, 60000);

  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  const edit = () => ['movement:edit', '--source-key', 'edit', '--movement', movement, '--expected-revision', '0', '--amount', '9007199254740993.123456', '--on', '2026-11-01', '--reason', 'Corregir', '--description=Descripcion=exacta', '--category', ' Comida '];

  it('editar, consultar, conciliar, anular y reemplazar manualmente sin tocar el original', () => {
    const result = cli(...edit());
    expect(result.status).toBe(0);
    expect(cli(...edit()).output).toBe(result.output.replace('creada', 'existente'));
    const history = JSON.parse(cli('movement:show', '--movement', movement).output);
    expect(history.original.amountMinor).toBe('1123456');
    expect(history.effective).toMatchObject({ revision: 1, category: 'Comida', description: 'Descripcion=exacta', amountMinor: '9007199254740993123456' });
    expect(cli('movement:history', '--movement', movement).output).toBe(cli('movement:show', '--movement', movement).output);
    expect(JSON.parse(cli('summary', '--month', '2026-10').output)[2].expense).toBe('0');
    expect(JSON.parse(cli('movement:recent', '--limit', '1').output)[0].id).toBe(movement);
    const reconcile = ['balance:reconcile', '--source-key', 'rec', '--account', account, '--currency', 'USDT', '--target', '-0.000001', '--on', '2026-11-01', '--reason', 'Conteo'];
    const reconciled = cli(...reconcile);
    expect(reconciled.status).toBe(0);
    expect(cli(...reconcile).output).toBe(reconciled.output.replace('creada', 'existente'));
    expect(cli('balance:list', '--on', '2026-11-01').output).toContain('-0.000001');
    const rows = JSON.parse(cli('reconciliation:list', '--account', account).output);
    expect(rows[0]).toMatchObject({ targetMinor: '-1', beforeMinor: '-9007199254740993123456', deltaMinor: '9007199254740993123455' });
    const voidArgs = ['movement:void', '--source-key', 'void', '--movement', movement, '--expected-revision', '1', '--reason', 'Duplicado'];
    expect(cli(...voidArgs).status).toBe(0);
    expect(cli(...voidArgs).output).toContain('existente');
    expect(cli(...edit()).output).toContain('existente');
    expect(cli(...reconcile).output).toContain('existente');
    expect(JSON.parse(cli('movement:recent').output)).toEqual([]);
    expect(cli('movement:add', '--source-key', 'replacement', '--account', account, '--currency', 'USDT', '--kind', 'expense', '--amount', '2.000001', '--on', '2026-11-01').status).toBe(0);
    expect(JSON.parse(cli('movement:recent').output)).toHaveLength(1);
  }, 120000);

  it('flags estrictos y errores seguros no cambian historial ni conciliaciones', () => {
    const before = cli('movement:history', '--movement', movement).output;
    const recs = cli('reconciliation:list').output;
    for (const args of [
      ['movement:edit'], [...edit(), '--unknown', 'value'], [...edit(), '--reason', 'Repetido'],
      [...edit(), 'posicional'], ['movement:show', '--movement'], ['movement:show', '--movement', movement, '--account', account],
      ['movement:recent', '--limit', '1e2'], ['movement:recent', '--limit', '201'], ['movement:recent', '--limit', '0'],
      ['summary', '--month', '2026-13'], ['summary', '--month'], ['reconciliation:list', '--account', 'missing'],
      ['movement:void', '--source-key', 'bad', '--movement', movement, '--expected-revision', '-1', '--reason', 'r'],
      ['movement:void', '--source-key', 'bad', '--movement', movement, '--expected-revision', '2', '--reason', 'r'],
      ['movement:void', '--source-key', 'bad', '--movement', movement, '--expected-revision', '2', '--reason', 'r', '--amount', '1'],
      ['balance:reconcile', '--source-key', 'bad', '--account', account, '--currency', 'USD', '--target', '0', '--on', '2026-11-01', '--reason', 'r'],
      ['balance:reconcile', '--source-key', 'bad', '--account', account, '--currency', 'USDT', '--target', '0.0000001', '--on', '2026-11-01', '--reason', 'r'],
    ]) expect({ args, result: cli(...args) }).toMatchObject({ result: { status: 1 } });
    expect(cli('movement:history', '--movement', movement).output).toBe(before);
    expect(cli('reconciliation:list').output).toBe(recs);
    expect(cli('movement:show', '--movement', 'missing').error).toContain('No existe');
    expect(cli(...edit().map((arg) => arg === '9007199254740993.123456' ? '1.0000001' : arg)).status).toBe(1);
  }, 120000);
});
