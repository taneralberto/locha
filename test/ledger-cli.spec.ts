import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('CLI B1 (procesos reales, base temporal)', () => {
  let directory: string;
  let env: NodeJS.ProcessEnv;
  let usd: string;
  let ves: string;

  function cli(...args: string[]) {
    const result = spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], { env, encoding: 'utf8', timeout: 20000 });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout.trim(), error: result.stderr.trim() };
  }

  beforeAll(() => {
    const build = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { encoding: 'utf8', timeout: 30000 });
    expect(build.status).toBe(0);
    directory = mkdtempSync(join(tmpdir(), 'locha-ledger-cli-'));
    env = { ...process.env, DATABASE_PATH: join(directory, 'cli.sqlite'), TELEGRAM_BOT_TOKEN: '', TELEGRAM_ALLOWED_USER_ID: '', TELEGRAM_ALLOWED_CHAT_ID: '', OPENROUTER_API_KEY: '', OPENROUTER_MODEL: '' };
    const migration = cli('migration:run');
    expect(migration.status).toBe(0);
    expect(migration.output).toContain('LedgerOperations1775260800000');
    const account = (name: string, currency: string): string => {
      const result = cli('account:add', '--name', name, '--currency', currency);
      expect(result.status).toBe(0);
      const id = /Cuenta creada ([\da-f-]{36})/.exec(result.output)?.[1];
      expect(id).toBeDefined();
      return id!;
    };
    usd = account('Efectivo', 'USD');
    ves = account('Banco', 'VES');
  }, 60000);

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('apertura y conversion repetibles, conflictos, comision y saldos deterministas', () => {
    const opening = ['opening:add', '--source-key', 'cli:open', '--account', usd, '--currency', 'USD', '--amount', '-9007199254740993.99', '--on', '2026-11-01', '--description=Inicio=USD'];
    const created = cli(...opening);
    expect(created.status).toBe(0);
    expect(created.output).toMatch(/Operacion [\da-f-]{36} \| opening \| creada/);
    expect(cli(...opening).output).toBe(created.output.replace('creada', 'existente'));
    expect(cli(...opening.map((arg) => arg === '--description=Inicio=USD' ? '--description=Inicio=VES' : arg)).status).toBe(1);
    const transfer = ['transfer:add', '--source-key', 'cli:transfer', '--from', usd, '--from-currency', 'USD', '--sent', '50.00', '--to', ves, '--to-currency', 'VES', '--received', '20000.00', '--on', '2026-11-02', '--fee-account', usd, '--fee-currency', 'USD', '--fee', '0.50'];
    const converted = cli(...transfer);
    expect(converted.status).toBe(0);
    expect(converted.output).toMatch(/Operacion [\da-f-]{36} \| transfer \| creada \| comision [\da-f-]{36}/);
    expect(cli(...transfer).output).toBe(converted.output.replace('creada', 'existente'));
    const balance = cli('balance:list', '--on', '2026-11-02');
    expect(balance.status).toBe(0);
    expect(balance.output).toContain(`${usd} | Efectivo | USD | -9007199254741044.49 | apertura si | al 2026-11-02`);
    expect(balance.output).toContain(`${ves} | Banco | VES | 20000.00 | apertura no | al 2026-11-02`);
    expect(cli('balance:list', '--on', '2026-11-02')).toEqual(balance);
    expect(cli('balance:list').status).toBe(0);
  }, 120000);

  it('rechaza grupo de comision incompleto, fechas, precision y opciones incompletas', () => {
    const transfer = ['transfer:add', '--source-key', 'invalid', '--from', usd, '--from-currency', 'USD', '--sent', '50', '--to', ves, '--to-currency', 'VES', '--received', '20000', '--on', '2026-11-02'];
    expect(cli(...transfer, '--fee-account', usd).error).toContain('--fee-currency');
    expect(cli(...transfer, '--fee').status).toBe(1);
    expect(cli('opening:add', '--source-key', 'bad', '--account', usd, '--currency', 'USD', '--amount', '0.001', '--on', '2026-11-01').status).toBe(1);
    expect(cli('balance:list', '--on', '2026-02-30').status).toBe(1);
    expect(cli('balance:list', '--on').status).toBe(1);
    expect(cli('balance:list', '--unknown', '1').status).toBe(1);
    expect(cli('opening:add').status).toBe(1);
  }, 120000);
});
