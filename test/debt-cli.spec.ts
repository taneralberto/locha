import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { Account } from '../src/accounts/account.entity';
import { DebtService } from '../src/debts/debt.service';
import { TransactionRunner } from '../src/data/transaction.runner';
import { FinancialService } from '../src/financial/financial.service';
import { openDatabase } from './helpers/temp-database';

/** Plazo de un comando de la CLI: son procesos nuevos y cada uno abre su base. */
const CLI_TIMEOUT_MS = 20_000;

describe('CLI de deudas (unidad 3)', () => {
  let directory: string;
  let databasePath: string;
  let env: NodeJS.ProcessEnv;
  let usd: string;
  let usdt: string;

  function cli(...args: string[]) {
    const result = spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], {
      env,
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
    });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout.trim(), error: result.stderr.trim() };
  }

  const add = (sourceKey = 'deuda-usd') => [
    'debt:add', '--source-key', sourceKey, '--direction', 'payable', '--counterparty', 'Carmen',
    '--currency', 'USD', '--amount', '8.00', '--on', '2026-11-01', '--description', 'dos tortas',
  ];

  /** Abre la base de la CLI en este proceso, trabaja y la cierra. */
  async function withDatabase<T>(work: (source: DataSource) => Promise<T>): Promise<T> {
    const source = await openDatabase(databasePath);
    try {
      return await work(source);
    } finally {
      await source.destroy();
    }
  }

  beforeAll(() => {
    const build = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], {
      encoding: 'utf8',
      timeout: 120000,
    });
    expect(build.status).toBe(0);
    directory = mkdtempSync(join(tmpdir(), 'locha-debt-cli-'));
    databasePath = join(directory, 'cli.sqlite');
    env = {
      ...process.env,
      DATABASE_PATH: databasePath,
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_ALLOWED_USER_ID: '',
      TELEGRAM_ALLOWED_CHAT_ID: '',
      OPENROUTER_API_KEY: '',
      OPENROUTER_MODEL: '',
    };
    expect(cli('migration:run').output).toContain('Debts1785888000000');
    usd = /Cuenta creada ([\da-f-]{36})/.exec(cli('account:add', '--name', 'Efectivo USD', '--currency', 'USD').output)![1]!;
    usdt = /Cuenta creada ([\da-f-]{36})/.exec(cli('account:add', '--name', 'Efectivo USDT', '--currency', 'USDT').output)![1]!;
  }, 180000);

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('crea las dos direcciones con importes exactos, las lista y las muestra con su historial', () => {
    const created = cli(...add());
    expect(created.status).toBe(0);
    const debtId = /Deuda ([\da-f-]{36})/.exec(created.output)![1]!;
    expect(created.output).toContain('creada');
    // Repetir la misma clave con el mismo contenido devuelve la misma deuda.
    expect(cli(...add()).output).toBe(`Deuda ${debtId} | existente`);
    // La misma clave con otro contenido es un conflicto.
    const conflict = cli(...add().map((arg) => (arg === 'Carmen' ? 'Vecino' : arg)));
    expect(conflict.status).toBe(1);
    expect(conflict.error).toContain('otro contenido');

    const receivable = cli('debt:add', '--source-key', 'cobro-usdt', '--direction', 'receivable',
      '--counterparty', 'Vecino', '--currency', 'USDT', '--amount', '9007199254740993.123456', '--on', '2026-11-02');
    expect(receivable.status).toBe(0);
    const receivableId = /Deuda ([\da-f-]{36})/.exec(receivable.output)![1]!;

    const list = cli('debt:list');
    expect(list.status).toBe(0);
    expect(list.output).toContain('Lo que debo:');
    expect(list.output).toContain('Lo que me deben:');
    expect(list.output).toContain(`${debtId} | Carmen | USD | original 8.00 | pagado 0.00 | pendiente 8.00 | open`);
    expect(list.output).toContain(`${receivableId} | Vecino | USDT | original 9007199254740993.123456 | pagado 0.000000 | pendiente 9007199254740993.123456 | open`);
    expect(list.output).toContain('lo que debo: 8.00 USD');
    expect(list.output).toContain('lo que me deben: 9007199254740993.123456 USDT');
    // Las direcciones no se compensan entre si.
    expect(list.output).toContain('sin compensar entre direcciones ni monedas');

    const receivableOnly = cli('debt:list', '--direction', 'receivable');
    expect(receivableOnly.output).toContain(receivableId);
    expect(receivableOnly.output).not.toContain(debtId);
    expect(cli('debt:list', '--currency', 'USDT').output).not.toContain(debtId);
    expect(cli('debt:list', '--counterparty', 'vecino').output).toContain(receivableId);
    expect(cli('debt:list', '--status', 'open').output).toContain(debtId);
    expect(cli('debt:list', '--status', 'paid').output).toContain('No hay deudas registradas.');

    const show = cli('debt:show', '--debt', debtId);
    expect(show.status).toBe(0);
    expect(show.output).toContain(`Deuda ${debtId} | lo que debo | Carmen | USD | original 8.00 | pagado 0.00 | pendiente 8.00 | open | fecha 2026-11-01 | descripcion dos tortas`);
    expect(show.output).toContain('Sin pagos.');
  }, 300000);

  it('paga: un gasto, parcial y total, con replay idempotente tras reiniciar', () => {
    const debtId = /Deuda ([\da-f-]{36})/.exec(cli(...add('deuda-pago')).output)![1]!;
    const pay = (sourceKey: string, amount: string, expected: string) => [
      'debt:pay', '--source-key', sourceKey, '--debt', debtId, '--account', usd,
      '--currency', 'USD', '--amount', amount, '--expected-outstanding', expected, '--on', '2026-11-05',
    ];

    const partial = cli(...pay('pago-parcial', '3.00', '8.00'));
    expect(partial.status).toBe(0);
    const paymentId = /Pago ([\da-f-]{36})/.exec(partial.output)![1]!;
    const movementId = /Movimiento ([\da-f-]{36})/.exec(partial.output)![1]!;
    expect(partial.output).toContain(`Pago ${paymentId} | Deuda ${debtId} | Movimiento ${movementId} | creado | importe 3.00 USD | pendiente 5.00 USD`);

    // Cada comando de la CLI es un proceso nuevo: repetir la clave devuelve el original.
    const replay = cli(...pay('pago-parcial', '3.00', '8.00'));
    expect(replay.status).toBe(0);
    expect(replay.output).toContain(`Pago ${paymentId} | Deuda ${debtId} | Movimiento ${movementId} | existente | importe 3.00 USD | pendiente 5.00 USD`);

    // La misma clave con otro importe es un conflicto y no escribe nada.
    const conflict = cli(...pay('pago-parcial', '4.00', '8.00'));
    expect(conflict.status).toBe(1);
    expect(conflict.error).toContain('otro contenido');

    const rest = cli(...pay('pago-resto', '5.00', '5.00'));
    expect(rest.status).toBe(0);
    expect(rest.output).toContain('| creado | importe 5.00 USD | pendiente 0.00 USD');

    const show = cli('debt:show', '--debt', debtId);
    expect(show.output).toContain('| pagado 8.00 | pendiente 0.00 | paid |');
    expect(show.output).toContain(`pago ${paymentId} | movimiento ${movementId} | gasto | 3.00 USD | 2026-11-05 | cuenta ${usd} | vigente`);

    const movements = JSON.parse(cli('movement:recent').output);
    expect(movements.map((row: { amountMinor: string }) => row.amountMinor).sort()).toEqual(['300', '500']);
    expect(movements.every((row: { kind: string }) => row.kind === 'expense')).toBe(true);
  }, 300000);

  it('cobrar lo que me deben es un ingreso', () => {
    const receivableId = /Deuda ([\da-f-]{36})/.exec(cli('debt:add', '--source-key', 'cobro', '--direction', 'receivable',
      '--counterparty', 'Vecino', '--currency', 'USD', '--amount', '5.00', '--on', '2026-11-01').output)![1]!;
    const paid = cli('debt:pay', '--source-key', 'cobro-pago', '--debt', receivableId, '--account', usd,
      '--currency', 'USD', '--amount', '5.00', '--expected-outstanding', '5.00', '--on', '2026-11-06');
    expect(paid.status).toBe(0);
    expect(paid.output).toContain('| creado | importe 5.00 USD | pendiente 0.00 USD');
    expect(cli('debt:show', '--debt', receivableId).output).toContain('| lo que me deben | Vecino | USD | original 5.00 | pagado 5.00 | pendiente 0.00 | paid |');
    const movements = JSON.parse(cli('movement:recent').output);
    expect(movements.filter((row: { kind: string }) => row.kind === 'income')).toHaveLength(1);
  }, 240000);

  it('rechaza expectativa obsoleta, cuenta inactiva y moneda distinta sin escribir', async () => {
    const debtId = /Deuda ([\da-f-]{36})/.exec(cli(...add('deuda-errores')).output)![1]!;
    const before = cli('debt:list').output;
    const movements = cli('movement:recent').output;

    const stale = cli('debt:pay', '--source-key', 'obsoleto', '--debt', debtId, '--account', usd,
      '--currency', 'USD', '--amount', '1.00', '--expected-outstanding', '7.00', '--on', '2026-11-05');
    expect(stale.status).toBe(1);
    expect(stale.error).toContain('Saldo pendiente esperado');

    const wrongCurrency = cli('debt:pay', '--source-key', 'moneda', '--debt', debtId, '--account', usdt,
      '--currency', 'USDT', '--amount', '1.00', '--expected-outstanding', '8.00', '--on', '2026-11-05');
    expect(wrongCurrency.status).toBe(1);
    expect(wrongCurrency.error).toContain('La deuda esta en USD y el pago es en USDT');

    const inactive = await withDatabase(async (source) => {
      await source.getRepository(Account).update(usd, { active: false });
      const result = cli('debt:pay', '--source-key', 'inactiva', '--debt', debtId, '--account', usd,
        '--currency', 'USD', '--amount', '1.00', '--expected-outstanding', '8.00', '--on', '2026-11-05');
      await source.getRepository(Account).update(usd, { active: true });
      return result;
    });
    expect(inactive.status).toBe(1);
    expect(inactive.error).toContain('esta inactiva');

    expect(cli('debt:list').output).toBe(before);
    expect(cli('movement:recent').output).toBe(movements);
  }, 300000);

  it('falla con flags desconocidos, repetidos o incompletos y no escribe nada', () => {
    const before = cli('debt:list').output;
    const movements = cli('movement:recent').output;
    for (const args of [
      ['debt:add'],
      [...add('deuda-flags'), '--unknown', 'x'],
      [...add('deuda-flags'), '--source-key', 'otro'],
      [...add('deuda-flags'), 'posicional'],
      [...add('deuda-flags'), '--direction', 'otra'],
      [...add('deuda-flags'), '--currency', 'EUR'],
      [...add('deuda-flags').map((arg) => (arg === '8.00' ? '0' : arg))],
      [...add('deuda-flags').map((arg) => (arg === '8.00' ? '1.001' : arg))],
      ['debt:list', '--status', 'otro'],
      ['debt:list', '--direction', 'otro'],
      ['debt:list', '--on', '2026-11-01'],
      ['debt:show'],
      ['debt:show', '--debt', 'no-existe'],
      ['debt:pay', '--source-key', 'x', '--debt', 'no-existe', '--account', usd, '--currency', 'USD', '--amount', '1.00', '--on', '2026-11-05'],
    ]) {
      expect({ args, result: cli(...args) }).toMatchObject({ result: { status: 1 } });
    }
    expect(cli('debt:list').output).toBe(before);
    expect(cli('movement:recent').output).toBe(movements);
  }, 360000);

  it('debt:pay advierte el deficit de las reservas y debt:add no', () => {
    const created = cli(...add('deuda-deficit'));
    expect(created.status).toBe(0);
    // Crear una deuda no mueve dinero: no hay advertencia.
    expect(created.output).not.toContain('ADVERTENCIA');
    const debtId = /Deuda ([\da-f-]{36})/.exec(created.output)![1]!;
    const paid = cli('debt:pay', '--source-key', 'pago-con-deficit', '--debt', debtId, '--account', usd,
      '--currency', 'USD', '--amount', '1.00', '--expected-outstanding', '8.00', '--on', '2026-11-05');
    expect(paid.status).toBe(0);
    expect(paid.output).toContain('ADVERTENCIA');
    expect(paid.output).toContain('deficit');
  }, 180000);

  it('el listado de la CLI no se corta: sale todas las filas, sin el tope de Telegram', async () => {
    const ids = await withDatabase(async (source) => {
      const transactions = new TransactionRunner(source);
      const debts = new DebtService(transactions, new FinancialService(transactions));
      const created: string[] = [];
      for (let index = 0; index < 60; index += 1) {
        const result = await debts.create({
          sourceKey: `deuda-larga-${index}`,
          direction: index % 2 === 0 ? 'payable' : 'receivable',
          counterparty: `Contraparte ${index} con un nombre bastante largo para alargar la fila`,
          money: { currency: 'USD', minor: 1000n + BigInt(index) },
          occurredOn: '2026-11-01',
        });
        created.push(result.debt.id);
      }
      return created;
    });

    const list = cli('debt:list');
    expect(list.status).toBe(0);
    expect(list.output.length).toBeGreaterThan(4096);
    expect(list.output).not.toContain('detalle omitido');
    for (const id of ids) {
      expect(list.output).toContain(id);
    }
  }, 240000);
});
