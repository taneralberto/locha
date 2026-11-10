import { randomUUID } from 'node:crypto';
import { Account } from '../src/accounts/account.entity';
import { AccountService } from '../src/accounts/account.service';
import { ConflictError, NotFoundError, ValidationError } from '../src/domain/errors';
import { FinancialService, RegisterInput } from '../src/financial/financial.service';
import { Movement } from '../src/financial/movement.entity';
import { createTempDatabase, TempDatabase } from './helpers/temp-database';

describe('FinancialService', () => {
  let database: TempDatabase;
  let accounts: AccountService;
  let service: FinancialService;

  beforeEach(async () => {
    database = await createTempDatabase();
    accounts = new AccountService(database.dataSource, database.transactions);
    service = new FinancialService(database.transactions);
  });

  afterEach(async () => {
    await database.cleanup();
  });

  async function createAccount(name = 'Efectivo', currency: 'USD' | 'VES' | 'USDT' = 'USD') {
    return accounts.add({ name, currency });
  }

  function input(overrides: Partial<RegisterInput> = {}): RegisterInput {
    return {
      sourceKey: 'telegram-1',
      accountId: 'cuenta-1',
      kind: 'expense',
      money: { currency: 'USD', minor: 123456n },
      occurredOn: '2026-01-05',
      ...overrides,
    };
  }

  /** Inserta un movimiento con `createdAt` explicito para probar el orden. */
  async function insertMovement(
    database: TempDatabase,
    accountId: string,
    sourceKey: string,
    occurredOn: string,
    createdAt: string,
  ): Promise<void> {
    await database.dataSource.query(
      `INSERT INTO "movement" ("id", "sourceKey", "accountId", "kind", "amountMinor", "currency", "occurredOn", "description", "createdAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), sourceKey, accountId, 'expense', '100', 'USD', occurredOn, null, createdAt],
    );
  }

  describe('register', () => {
    it('crea el movimiento y lo persiste', async () => {
      const account = await createAccount();

      const result = await service.register(input({ accountId: account.id, description: 'Almuerzo' }));

      expect(result.created).toBe(true);
      expect(result.movement.amountMinor).toBe(123456n);
      expect(result.movement.currency).toBe('USD');
      expect(result.movement.occurredOn).toBe('2026-01-05');
      expect(result.movement.description).toBe('Almuerzo');

      const stored = await database.dataSource.getRepository(Movement).find();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.amountMinor).toBe(123456n);
    });

    it('es idempotente: el mismo sourceKey con el mismo contenido devuelve el movimiento existente', async () => {
      const account = await createAccount();
      const first = await service.register(input({ accountId: account.id }));
      const second = await service.register(input({ accountId: account.id }));

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.movement.id).toBe(first.movement.id);
      expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
    });

    it('falla si el mismo sourceKey llega con otro contenido', async () => {
      const account = await createAccount();
      await service.register(input({ accountId: account.id }));

      await expect(
        service.register(input({ accountId: account.id, money: { currency: 'USD', minor: 123457n } })),
      ).rejects.toThrow(ConflictError);
      expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
    });

    it('rechaza una cuenta inexistente', async () => {
      await expect(service.register(input())).rejects.toThrow(NotFoundError);
    });

    it('rechaza una cuenta inactiva', async () => {
      const account = await createAccount();
      await database.dataSource.getRepository(Account).update(account.id, { active: false });

      await expect(service.register(input({ accountId: account.id }))).rejects.toThrow(ValidationError);
    });

    it('rechaza un movimiento en una moneda distinta a la de la cuenta', async () => {
      const account = await createAccount('Efectivo', 'USD');

      await expect(
        service.register(input({ accountId: account.id, money: { currency: 'VES', minor: 100n } })),
      ).rejects.toThrow(ValidationError);
    });

    it('rechaza importes no positivos, fechas invalidas y monedas desconocidas', async () => {
      const account = await createAccount();

      await expect(
        service.register(input({ accountId: account.id, money: { currency: 'USD', minor: 0n } })),
      ).rejects.toThrow(ValidationError);
      await expect(
        service.register(input({ accountId: account.id, money: { currency: 'USD', minor: -1n } })),
      ).rejects.toThrow(ValidationError);
      await expect(
        service.register(input({ accountId: account.id, occurredOn: '2026-02-30' })),
      ).rejects.toThrow(ValidationError);
      await expect(
        service.register(
          input({ accountId: account.id, money: { currency: 'EUR' as 'USD', minor: 100n } }),
        ),
      ).rejects.toThrow(ValidationError);
      await expect(
        service.register(input({ accountId: account.id, kind: 'transfer' as 'expense' })),
      ).rejects.toThrow(ValidationError);
    });

    it('guarda el importe exacto en unidades menores, sin perdida de precision', async () => {
      const account = await createAccount();

      await service.register(
        input({
          accountId: account.id,
          sourceKey: 'grande',
          money: { currency: 'USD', minor: 900719925474099399n },
        }),
      );

      const raw = await database.dataSource.query<{ amountMinor: string; type: string }[]>(
        'SELECT amountMinor, typeof(amountMinor) AS type FROM "movement"',
      );
      expect(raw[0]?.amountMinor).toBe('900719925474099399');
      expect(raw[0]?.type).toBe('text');
    });

    it('usa la transaccion del EntityManager entregado', async () => {
      const account = await createAccount();

      await database.dataSource.transaction(async (manager) => {
        const result = await service.register(input({ accountId: account.id }), manager);
        expect(result.created).toBe(true);
      });

      expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
    });
  });

  describe('recent', () => {
    it('ordena por fecha de operacion descendente', async () => {
      const account = await createAccount();
      await service.register(
        input({ accountId: account.id, sourceKey: 'b', occurredOn: '2026-01-05' }),
      );
      await service.register(
        input({ accountId: account.id, sourceKey: 'a', occurredOn: '2026-01-05' }),
      );
      await service.register(
        input({ accountId: account.id, sourceKey: 'c', occurredOn: '2026-01-07' }),
      );

      const recent = await service.recent(2);

      expect(recent.map((movement) => movement.sourceKey)).toEqual(['c', 'a']);
    });

    it('desempata por sourceKey y no depende de createdAt', async () => {
      const account = await createAccount();
      await insertMovement(database, account.id, 'a', '2026-01-05', '2026-01-05 09:00:00.000');
      await insertMovement(database, account.id, 'z', '2026-01-05', '2026-01-05 11:00:00.000');

      const recent = await service.recent(10);

      // "z" tiene el createdAt mas nuevo: el orden no debe depender de el.
      expect(recent.map((movement) => movement.sourceKey)).toEqual(['a', 'z']);
    });
  });

  describe('registro concurrente', () => {
    it('registra una sola vez el mismo sourceKey con el mismo contenido', async () => {
      const account = await createAccount();

      const results = await Promise.allSettled([
        service.register(input({ accountId: account.id })),
        service.register(input({ accountId: account.id })),
      ]);

      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      const created = results.filter((result) => result.status === 'fulfilled' && result.value.created);
      expect(created).toHaveLength(1);
      expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
    });

    it('el mismo sourceKey con otro contenido produce un conflicto', async () => {
      const account = await createAccount();

      const results = await Promise.allSettled([
        service.register(input({ accountId: account.id })),
        service.register(input({ accountId: account.id, money: { currency: 'USD', minor: 999n } })),
      ]);

      const statuses = results.map((result) => result.status);
      expect(statuses.filter((status) => status === 'fulfilled')).toHaveLength(1);
      expect(statuses.filter((status) => status === 'rejected')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toBeInstanceOf(ConflictError);
      expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
    });

    it('registra en paralelo movimientos con sourceKey distintos', async () => {
      const account = await createAccount();

      const results = await Promise.allSettled([
        service.register(input({ accountId: account.id, sourceKey: 'a' })),
        service.register(input({ accountId: account.id, sourceKey: 'b' })),
      ]);

      expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
      expect(await database.dataSource.getRepository(Movement).count()).toBe(2);
    });

    it('una transaccion fallida no bloquea las siguientes', async () => {
      const account = await createAccount();

      await expect(
        service.register(input({ accountId: 'cuenta-inexistente' })),
      ).rejects.toThrow(NotFoundError);

      const result = await service.register(input({ accountId: account.id }));

      expect(result.created).toBe(true);
      expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
    });
  });

  describe('summary', () => {
    it('calcula totales por moneda con bigint', async () => {
      const usd = await createAccount('Efectivo', 'USD');
      const ves = await createAccount('Banco', 'VES');

      await service.register(
        input({
          accountId: usd.id,
          sourceKey: 'u1',
          kind: 'expense',
          money: { currency: 'USD', minor: 100n },
        }),
      );
      await service.register(
        input({
          accountId: usd.id,
          sourceKey: 'u2',
          kind: 'expense',
          money: { currency: 'USD', minor: 200n },
        }),
      );
      await service.register(
        input({
          accountId: usd.id,
          sourceKey: 'u3',
          kind: 'income',
          money: { currency: 'USD', minor: 1000n },
        }),
      );
      await service.register(
        input({
          accountId: ves.id,
          sourceKey: 'v1',
          kind: 'income',
          money: { currency: 'VES', minor: 350000n },
        }),
      );

      const summary = await service.summary();
      const usdTotals = summary.find((totals) => totals.currency === 'USD');
      const vesTotals = summary.find((totals) => totals.currency === 'VES');
      const usdtTotals = summary.find((totals) => totals.currency === 'USDT');

      expect(summary.map((totals) => totals.currency)).toEqual(['VES', 'USD', 'USDT']);
      expect(usdTotals?.expense).toBe(300n);
      expect(usdTotals?.income).toBe(1000n);
      expect(usdTotals?.net).toBe(700n);
      expect(vesTotals?.income).toBe(350000n);
      expect(vesTotals?.net).toBe(350000n);
      expect(usdtTotals?.net).toBe(0n);
    });

    it('calcula los totales de un solo mes', async () => {
      const usd = await createAccount('Efectivo', 'USD');

      await service.register(
        input({
          accountId: usd.id,
          sourceKey: 'u1',
          occurredOn: '2026-11-05',
          money: { currency: 'USD', minor: 100n },
        }),
      );
      await service.register(
        input({
          accountId: usd.id,
          sourceKey: 'u2',
          kind: 'income',
          money: { currency: 'USD', minor: 1000n },
          occurredOn: '2026-11-20',
        }),
      );
      await service.register(
        input({
          accountId: usd.id,
          sourceKey: 'u3',
          occurredOn: '2026-10-05',
          money: { currency: 'USD', minor: 50n },
        }),
      );

      const summary = await service.summary('2026-11');
      const totals = summary.find((entry) => entry.currency === 'USD');

      expect(totals?.expense).toBe(100n);
      expect(totals?.income).toBe(1000n);
      expect(totals?.net).toBe(900n);
    });

    it('rechaza un mes que no existe', async () => {
      await expect(service.summary('2026-13')).rejects.toThrow(ValidationError);
    });
  });
});
