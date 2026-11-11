import { Account } from '../src/accounts/account.entity';
import { AccountService } from '../src/accounts/account.service';
import { ConflictError, NotFoundError, ValidationError } from '../src/domain/errors';
import { Currency, parseAmount, parseOpeningAmount } from '../src/domain/money';
import { FinancialService, OpeningInput, TransferInput } from '../src/financial/financial.service';
import { LedgerOperation } from '../src/financial/ledger-operation.entity';
import { Movement } from '../src/financial/movement.entity';
import { createTempDatabase, TempDatabase } from './helpers/temp-database';

describe('FinancialService B1: aperturas, transferencias y saldos', () => {
  let database: TempDatabase;
  let service: FinancialService;
  let usd: Account;
  let ves: Account;
  let usdt: Account;

  beforeEach(async () => {
    database = await createTempDatabase();
    service = new FinancialService(database.transactions);
    const accounts = new AccountService(database.dataSource, database.transactions);
    usd = await accounts.add({ name: 'Efectivo', currency: 'USD' });
    ves = await accounts.add({ name: 'Banco', currency: 'VES' });
    usdt = await accounts.add({ name: 'Cripto', currency: 'USDT' });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await database.cleanup();
  });

  function opening(overrides: Partial<OpeningInput> = {}): OpeningInput {
    return { sourceKey: 'opening:1', accountId: usd.id, money: { currency: 'USD', minor: 10000n },
      occurredOn: '2026-11-01', ...overrides };
  }

  function transfer(overrides: Partial<TransferInput> = {}): TransferInput {
    return {
      sourceKey: 'transfer:1', from: { accountId: usd.id, money: { currency: 'USD', minor: 5000n } },
      to: { accountId: ves.id, money: { currency: 'VES', minor: 2000000n } },
      occurredOn: '2026-11-02', ...overrides,
    };
  }

  it.each<[Currency, string, bigint]>([
    ['USD', '9007199254740993.99', 900719925474099399n],
    ['VES', '-9007199254740993.99', -900719925474099399n],
    ['USDT', '9007199254740993.123456', 9007199254740993123456n],
  ])('conserva exactitud de apertura y saldo %s', async (currency, amount, minor) => {
    const account = { USD: usd, VES: ves, USDT: usdt }[currency];
    const result = await service.open(opening({ accountId: account.id, money: { currency, minor: parseOpeningAmount(amount, currency) } }));
    expect(result.operation.deltaMinor).toBe(minor);
    const rows = await service.balances('2026-11-01');
    expect(rows.find((row) => row.accountId === account.id)).toMatchObject({ balance: minor, hasOpening: true });
    const raw = await database.dataSource.query(`SELECT deltaMinor, typeof(deltaMinor) AS type FROM ledger_operation`);
    expect(raw).toEqual([{ deltaMinor: minor.toString(), type: 'text' }]);
  });

  it('la apertura cero existe; es unica por cuenta incluso con otra clave', async () => {
    const input = opening({ money: { currency: 'USD', minor: 0n } });
    const first = await service.open(input);
    expect((await service.open(input)).operation.id).toBe(first.operation.id);
    expect((await service.open(input)).created).toBe(false);
    await expect(service.open({ ...input, sourceKey: 'otra' })).rejects.toThrow(ConflictError);
    expect((await service.balances('2026-11-01')).find((row) => row.accountId === usd.id)?.hasOpening).toBe(true);
  });

  it('la apertura es aditiva, no borra movimientos anteriores y no incluye fechas futuras', async () => {
    await service.register({ sourceKey: 'old', accountId: usd.id, money: { currency: 'USD', minor: 100n }, kind: 'expense', occurredOn: '2026-10-01' });
    await service.open(opening());
    await service.register({ sourceKey: 'future', accountId: usd.id, money: { currency: 'USD', minor: 999n }, kind: 'income', occurredOn: '2026-12-01' });
    expect((await service.balances('2026-10-01')).find((row) => row.accountId === usd.id)).toMatchObject({ balance: -100n, hasOpening: false });
    expect((await service.balances('2026-11-01')).find((row) => row.accountId === usd.id)).toMatchObject({ balance: 9900n, hasOpening: true });
    expect((await service.balances('2026-12-01')).find((row) => row.accountId === usd.id)?.balance).toBe(10899n);
  });

  it('saldo por defecto usa hoy en Caracas, no UTC; ordena todas las cuentas', async () => {
    await service.open(opening({ occurredOn: '2026-11-10' }));
    await service.transfer(transfer({ occurredOn: '2026-11-11' }));
    jest.useFakeTimers({ now: new Date('2026-11-11T02:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const rows = await service.balances();
      expect(rows.map((row) => row.name)).toEqual(['Banco', 'Cripto', 'Efectivo']);
      expect(rows.every((row) => row.asOf === '2026-11-10')).toBe(true);
      expect(rows.find((row) => row.accountId === usd.id)?.balance).toBe(10000n);
    } finally {
      jest.useRealTimers();
    }
  });

  it('conversion: conserva los dos importes reales; solo la comision es gasto', async () => {
    const input = transfer({ fee: { accountId: usdt.id, money: { currency: 'USDT', minor: 123456n } }, description: 'Cambio real' });
    const result = await service.transfer(input);
    expect(result.operation.deltaMinor).toBe(-5000n);
    expect(result.operation.destinationDeltaMinor).toBe(2000000n);
    expect(result.operation.feeMovementId).not.toBeNull();
    const balances = await service.balances('2026-11-02');
    expect(balances.map((row) => row.balance)).toEqual([2000000n, -123456n, -5000n]);
    const summary = await service.summary('2026-11');
    expect(summary.map((row) => row.income)).toEqual([0n, 0n, 0n]);
    expect(summary.map((row) => row.expense)).toEqual([0n, 0n, 123456n]);
    expect(await service.recent()).toHaveLength(1);
    const fee = (await service.recent())[0]!;
    expect(fee.id).toBe(result.operation.feeMovementId);
    expect(fee.sourceKey).toBe(`ledger:${result.operation.id}:fee`);
    expect((await service.transfer(input))).toMatchObject({ created: false, operation: { id: result.operation.id } });
  });

  it('transferencia en una moneda mantiene el principal; comision adicional independiente', async () => {
    const other = await new AccountService(database.dataSource, database.transactions).add({ name: 'Otro USD', currency: 'USD' });
    const input = transfer({ to: { accountId: other.id, money: { currency: 'USD', minor: 5000n } }, fee: { accountId: usd.id, money: { currency: 'USD', minor: 50n } } });
    await service.transfer(input);
    const rows = await service.balances('2026-11-02');
    expect(rows.find((row) => row.accountId === usd.id)?.balance).toBe(-5050n);
    expect(rows.find((row) => row.accountId === other.id)?.balance).toBe(5000n);
    await expect(service.transfer({ ...input, sourceKey: 'bad', to: { accountId: other.id, money: { currency: 'USD', minor: 4999n } } })).rejects.toThrow(ValidationError);
  });

  it('conversion USDT grande conserva todos los decimales sin tasa calculada', async () => {
    const amount = parseAmount('9007199254740993.123456', 'USDT');
    await service.transfer(transfer({ from: { accountId: usdt.id, money: { currency: 'USDT', minor: amount } } }));
    expect((await service.balances('2026-11-02')).find((row) => row.accountId === usdt.id)?.balance).toBe(-amount);
  });

  it('replay normalizado completo aun con cuentas inactivas; cambios siguen en conflicto', async () => {
    const input = transfer({ fee: { accountId: usdt.id, money: { currency: 'USDT', minor: 10n } }, description: ' Cambio ' });
    const first = await service.transfer(input);
    await service.open(opening());
    await database.dataSource.getRepository(Account).update([usd.id, ves.id, usdt.id], { active: false });
    expect(await service.transfer({ ...input, sourceKey: ' transfer:1 ', description: 'Cambio' })).toMatchObject({ created: false, operation: { id: first.operation.id } });
    expect((await service.open(opening())).created).toBe(false);
    await expect(service.transfer({ ...input, occurredOn: '2026-11-03' })).rejects.toThrow(ConflictError);
    await expect(service.open(opening({ money: { currency: 'USD', minor: 1n } }))).rejects.toThrow(ConflictError);
    await expect(service.transfer({ ...input, sourceKey: 'new' })).rejects.toThrow(ValidationError);
    expect((await service.balances('2026-11-02'))).toHaveLength(3);
  });

  it('cualquier cambio del payload de transferencia o comision produce conflicto', async () => {
    const input = transfer({ fee: { accountId: usd.id, money: { currency: 'USD', minor: 20n } } });
    await service.transfer(input);
    const changes: Partial<TransferInput>[] = [
      { from: { accountId: usdt.id, money: { currency: 'USDT', minor: 5000n } } },
      { from: { ...input.from, money: { currency: 'USD', minor: 5001n } } },
      { to: { ...input.to, money: { currency: 'VES', minor: 2000001n } } },
      { to: { accountId: usdt.id, money: { currency: 'USDT', minor: 2000000n } } },
      { fee: undefined },
      { fee: { accountId: usd.id, money: { currency: 'USD', minor: 21n } } },
      { fee: { accountId: ves.id, money: { currency: 'VES', minor: 20n } } },
      { description: 'diferente' }, { occurredOn: '2026-11-03' },
    ];
    for (const change of changes) {
      await expect(service.transfer({ ...input, ...change })).rejects.toThrow(ConflictError);
    }
    await expect(service.open(opening({ sourceKey: input.sourceKey }))).rejects.toThrow(ConflictError);
    expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
  });

  it('resuelve repeticiones concurrentes sin duplicar operacion ni comision', async () => {
    const input = transfer({ fee: { accountId: usd.id, money: { currency: 'USD', minor: 20n } } });
    const results = await Promise.all([service.transfer(input), service.transfer(input)]);
    expect(results.map((result) => result.created)).toEqual([true, false]);
    expect(results[0]?.operation.id).toBe(results[1]?.operation.id);
    expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
    const openings = await Promise.allSettled([service.open(opening()), service.open(opening({ sourceKey: 'other' }))]);
    expect(openings.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
  });

  it('conflicto concurrente deja una operacion y una sola comision', async () => {
    const input = transfer({ fee: { accountId: usd.id, money: { currency: 'USD', minor: 20n } } });
    const results = await Promise.allSettled([service.transfer(input), service.transfer({ ...input, description: 'changed' })]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1]?.status === 'rejected' && results[1].reason).toBeInstanceOf(ConflictError);
    expect(await database.dataSource.getRepository(LedgerOperation).count()).toBe(1);
    expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
  });

  it('revierte todo si falla despues de guardar la comision, y la cola se recupera', async () => {
    const original = service.register.bind(service);
    const spy = jest.spyOn(service, 'register').mockImplementationOnce(async (input, manager) => {
      await original(input, manager);
      throw new Error('fallo despues de comision');
    });
    const input = transfer({ fee: { accountId: usd.id, money: { currency: 'USD', minor: 20n } } });
    await expect(service.transfer(input)).rejects.toThrow('fallo despues de comision');
    expect(await database.dataSource.getRepository(Movement).count()).toBe(0);
    expect(await database.dataSource.getRepository(LedgerOperation).count()).toBe(0);
    spy.mockRestore();
    expect((await service.transfer(input)).created).toBe(true);
  });

  it('revierte la comision si falla la insercion de operacion', async () => {
    await database.dataSource.query(`CREATE TRIGGER fail_ledger BEFORE INSERT ON ledger_operation BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END`);
    await expect(service.transfer(transfer({ fee: { accountId: usd.id, money: { currency: 'USD', minor: 20n } } }))).rejects.toThrow('injected ledger failure');
    expect(await database.dataSource.getRepository(Movement).count()).toBe(0);
    expect(await database.dataSource.getRepository(LedgerOperation).count()).toBe(0);
  });

  it('usa el EntityManager recibido para aperturas, transferencias y lecturas; rollback del llamador', async () => {
    await expect(database.transactions.run(async (manager) => {
      await service.open(opening(), manager);
      await service.transfer(transfer(), manager);
      expect((await service.balances('2026-11-02', manager)).find((row) => row.accountId === usd.id)?.balance).toBe(5000n);
      throw new Error('rollback caller');
    })).rejects.toThrow('rollback caller');
    expect(await database.dataSource.getRepository(LedgerOperation).count()).toBe(0);
  });

  it('valida cuentas, monedas, importes, fechas y textos sin dejar escrituras', async () => {
    await expect(service.open(opening({ accountId: 'missing' }))).rejects.toThrow(NotFoundError);
    await expect(service.open(opening({ money: { currency: 'VES', minor: 0n } }))).rejects.toThrow(ValidationError);
    await expect(service.open(opening({ sourceKey: ' ' }))).rejects.toThrow(ValidationError);
    await expect(service.open(opening({ description: 'x'.repeat(281) }))).rejects.toThrow(ValidationError);
    await expect(service.open(opening({ occurredOn: '2026-02-30' }))).rejects.toThrow(ValidationError);
    await expect(service.balances('2026-02-30')).rejects.toThrow(ValidationError);
    await expect(service.transfer(transfer({ to: { accountId: usd.id, money: { currency: 'USD', minor: 5000n } } }))).rejects.toThrow(ValidationError);
    await expect(service.transfer(transfer({ from: { accountId: usd.id, money: { currency: 'USD', minor: 0n } } }))).rejects.toThrow(ValidationError);
    await expect(service.transfer(transfer({ fee: { accountId: ves.id, money: { currency: 'VES', minor: -1n } } }))).rejects.toThrow(ValidationError);
    await expect(service.transfer(transfer({ to: { accountId: 'missing', money: { currency: 'VES', minor: 1n } } }))).rejects.toThrow(NotFoundError);
    await expect(service.transfer(transfer({ fee: { accountId: ves.id, money: { currency: 'USD', minor: 1n } } }))).rejects.toThrow(ValidationError);
    expect(await database.dataSource.getRepository(LedgerOperation).count()).toBe(0);
    expect(await database.dataSource.getRepository(Movement).count()).toBe(0);
  });
});

describe('parseOpeningAmount', () => {
  it.each(['0', '0.00', '-0.00', '000.0'])('acepta cero exacto %s', (amount) => {
    expect(parseOpeningAmount(amount, 'USD')).toBe(0n);
    expect(() => parseAmount(amount, 'USD')).toThrow(ValidationError);
  });

  it('acepta negativos y las escalas del registro', () => {
    expect(parseOpeningAmount(' -12.34 ', 'USD')).toBe(-1234n);
    expect(parseOpeningAmount('-0.000001', 'USDT')).toBe(-1n);
    expect(parseOpeningAmount('1.23', 'VES')).toBe(123n);
  });

  it.each(['+1', '1e2', '1,00', '--1', '-', '', '0.000', '-0.000', '1.234', '1.'])('rechaza %s sin redondear', (amount) => {
    expect(() => parseOpeningAmount(amount, 'USD')).toThrow(ValidationError);
  });
});
