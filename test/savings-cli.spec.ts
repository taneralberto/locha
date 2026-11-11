import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('CLI B4 (subprocesos y SQLite temporal)', () => {
  let directory: string;
  let env: NodeJS.ProcessEnv;
  let account: string;
  let goal: string;

  function cli(...args: string[]) {
    const result = spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], { env, encoding: 'utf8', timeout: 20000 });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout.trim(), error: result.stderr.trim() };
  }
  const add = () => ['goal:add', '--source-key', 'goal', '--name', 'Fondo', '--currency', 'USDT', '--target', '9007199254740993.123456', '--target-on', '2028-02-29'];
  const reserve = () => ['savings:reserve', '--source-key', 'reserve', '--goal', goal, '--account', account, '--amount', '9007199254740993.123456'];
  const release = () => ['savings:release', '--source-key', 'release', '--goal', goal, '--account', account, '--amount', '0.000001'];

  beforeAll(() => {
    const build = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { encoding: 'utf8', timeout: 30000 });
    expect(build.status).toBe(0);
    directory = mkdtempSync(join(tmpdir(), 'locha-b4-cli-'));
    env = { ...process.env, DATABASE_PATH: join(directory, 'cli.sqlite'), TELEGRAM_BOT_TOKEN: '', TELEGRAM_ALLOWED_USER_ID: '', TELEGRAM_ALLOWED_CHAT_ID: '', OPENROUTER_API_KEY: '', OPENROUTER_MODEL: '' };
    expect(cli('migration:run').output).toContain('GoalsAndSavings1783209600000');
    const created = cli('account:add', '--name', 'USDT', '--currency', 'USDT');
    expect(created.status).toBe(0);
    account = /Cuenta creada ([\da-f-]{36})/.exec(created.output)![1]!;
    expect(cli('opening:add', '--source-key', 'open', '--account', account, '--currency', 'USDT', '--amount', '9007199254740993.123456', '--on', '2020-01-01').status).toBe(0);
  }, 60000);
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  it('metas/reservas CLI exactas, IDs estables tras reinicios, consultas y replay sin duplicados ni movimientos', () => {
    const created = cli(...add());
    expect(created.status).toBe(0);
    goal = /Meta ([\da-f-]{36})/.exec(created.output)![1]!;
    expect(cli(...add()).output).toBe(created.output.replace('creada', 'existente'));
    expect(JSON.parse(cli('goal:list').output)).toMatchObject([{ id: goal, targetMinor: '9007199254740993123456', targetOn: '2028-02-29' }]);
    const reserved = cli(...reserve());
    expect(reserved.status).toBe(0);
    expect(cli(...reserve()).output).toBe(reserved.output.replace('creada', 'existente'));
    expect(cli('savings:status', '--account', account).output).toContain('saldo 9007199254740993.123456 | reservado 9007199254740993.123456 | disponible 0.000000 | deficit 0.000000');
    const released = cli(...release());
    expect(released.status).toBe(0);
    expect(cli(...release()).output).toBe(released.output.replace('creada', 'existente'));
    expect(cli('goal:status', '--goal', goal).output).toContain('reservado nominal 9007199254740993.123455 | restante 0.000001 | progreso 99.99%');
    const history = JSON.parse(cli('savings:history', '--account', account, '--goal', goal).output);
    expect(history).toHaveLength(2);
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'reserve', amountMinor: '9007199254740993123456' }),
      expect.objectContaining({ kind: 'release', amountMinor: '1' }),
    ]));
    expect(JSON.parse(cli('movement:recent').output)).toEqual([]);
    expect(cli('balance:list').output).toContain('9007199254740993.123456');
  }, 120000);

  it('flags estrictos, precision/positividad/calendario/moneda e insuficiencia fallan sin escrituras', () => {
    const beforeGoals = cli('goal:list').output;
    const beforeHistory = cli('savings:history').output;
    const usd = cli('account:add', '--name', 'USD', '--currency', 'USD');
    const usdAccount = /Cuenta creada ([\da-f-]{36})/.exec(usd.output)![1]!;
    const base = ['goal:add', '--source-key', 'bad', '--name', 'Bad', '--currency', 'USD', '--target'];
    for (const args of [
      ['goal:add'], [...add(), '--unknown', 'x'], [...add(), '--name', 'Duplicado'], [...add(), 'posicional'],
      ['goal:list', '--on', '2026-11-01'], ['goal:status', '--goal'], ['goal:status', '--goal', 'missing'],
      [...base, '0'], [...base, '-1'], [...base, '0.001'], [...base, '1e3'],
      [...base, '1', '--target-on', '2026-02-29'], [...base, '1', '--name', 'n'.repeat(81)],
      [...reserve(), '--on', '2020-01-01'], [...reserve(), '--amount', '1'], [...release(), '--amount', '1'],
      ['savings:status', '--on', '2026-11-10'], ['savings:status', '--account'], ['savings:history', '--goal'],
      ['savings:history', '--goal', 'missing'], ['savings:status', '--account', 'missing'],
      ...['0', '-1', '0.0000001'].map((amount) => ['savings:reserve', '--source-key', 'bad', '--goal', goal, '--account', account, '--amount', amount]),
      ['savings:reserve', '--source-key', 'bad', '--goal', goal, '--account', usdAccount, '--amount', '1'],
      ['savings:reserve', '--source-key', 'bad', '--goal', goal, '--account', account, '--amount', '0.000002'],
      ['savings:release', '--source-key', 'bad', '--goal', goal, '--account', account, '--amount', '9007199254740993.123456'],
      add().map((arg) => arg === 'Fondo' ? 'Conflicto' : arg),
      reserve().map((arg) => arg === '9007199254740993.123456' ? '0.000001' : arg),
    ]) expect({ args, result: cli(...args) }).toMatchObject({ result: { status: 1 } });
    expect(cli('goal:list').output).toBe(beforeGoals);
    expect(cli('savings:history').output).toBe(beforeHistory);
    expect(JSON.parse(cli('movement:recent').output)).toEqual([]);
  }, 180000);

  it('mutaciones reales registran y advierten deficit sin liberar: gasto, editar, anular ingreso, conciliar y transferencia con comision', () => {
    const history = cli('savings:history').output;
    const expense = cli('movement:add', '--source-key', 'expense', '--account', account, '--currency', 'USDT', '--kind', 'expense', '--amount', '0.000002', '--on', '2020-01-01');
    expect(expense.status).toBe(0);
    expect(expense.output).toContain(`ADVERTENCIA: cuenta ${account} | USDT | deficit 0.000001 | disponible -0.000001`);
    const movement = /Movimiento ([\da-f-]{36})/.exec(expense.output)![1]!;
    const edit = cli('movement:edit', '--source-key', 'edit', '--movement', movement, '--expected-revision', '0', '--amount', '0.000003', '--on', '2020-01-01', '--reason', 'Importe');
    expect(edit.status).toBe(0);
    expect(edit.output).toContain('deficit 0.000002');
    const income = cli('movement:add', '--source-key', 'income', '--account', account, '--currency', 'USDT', '--kind', 'income', '--amount', '0.000001', '--on', '2020-01-01');
    const incomeId = /Movimiento ([\da-f-]{36})/.exec(income.output)![1]!;
    const voided = cli('movement:void', '--source-key', 'void', '--movement', incomeId, '--expected-revision', '0', '--reason', 'Duplicado');
    expect(voided.status).toBe(0);
    expect(voided.output).toContain('ADVERTENCIA');
    const reconcile = cli('balance:reconcile', '--source-key', 'rec', '--account', account, '--currency', 'USDT', '--target', '0', '--on', '2020-01-01', '--reason', 'Conteo');
    expect(reconcile.status).toBe(0);
    expect(reconcile.output).toContain('deficit 9007199254740993.123455');
    const to = /Cuenta creada ([\da-f-]{36})/.exec(cli('account:add', '--name', 'Destino', '--currency', 'USD').output)![1]!;
    const transfer = cli('transfer:add', '--source-key', 'transfer', '--from', account, '--from-currency', 'USDT', '--sent', '0.000001', '--to', to, '--to-currency', 'USD', '--received', '0.01', '--fee-account', account, '--fee-currency', 'USDT', '--fee', '0.000001', '--on', '2020-01-01');
    expect(transfer.status).toBe(0);
    expect(transfer.output).toContain('comision');
    expect(transfer.output).toContain('deficit 9007199254740993.123457');
    expect(cli('goal:status').output).toContain('reserva nominal con cuentas deficitarias');
    expect(cli(...reserve()).output).toContain('existente');
    expect(cli(...release()).output).toContain('existente');
    expect(cli('savings:history').output).toBe(history);
    const blocked = cli('savings:reserve', '--source-key', 'blocked', '--goal', goal, '--account', account, '--amount', '0.000001');
    expect(blocked.status).toBe(1);
    expect(blocked.error).toContain('insuficientes');
    expect(blocked.output).not.toContain('ADVERTENCIA');
    const released = cli('savings:release', '--source-key', 'all', '--goal', goal, '--account', account, '--amount', '9007199254740993.123455');
    expect(released.status).toBe(0);
    expect(cli('savings:status', '--account', account).output).toContain('saldo -0.000002 | reservado 0.000000 | disponible -0.000002 | deficit 0.000002');
  }, 120000);
});
