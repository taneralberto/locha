import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { Account } from '../src/accounts/account.entity';
import { CaptureEvent } from '../src/capture/capture-event.entity';
import { Capture } from '../src/capture/capture.entity';
import { buildDataSourceOptions } from '../src/data/data-source';
import { Movement } from '../src/financial/movement.entity';
import { createTempDatabase } from './helpers/temp-database';

describe('Migracion inicial', () => {
  it('mantiene synchronize y migrationsRun desactivados', () => {
    const options = buildDataSourceOptions('data/locha.sqlite');

    expect(options).toMatchObject({ synchronize: false, migrationsRun: false });
  });

  it('crea las tablas account y movement', async () => {
    const database = await createTempDatabase();

    const tables = await database.dataSource.query<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type = 'table'`,
    );

    expect(tables.map((table) => table.name)).toEqual(expect.arrayContaining(['account', 'movement']));
    await database.cleanup();
  });

  it('declara occurredOn y amountMinor como columnas de texto', async () => {
    const database = await createTempDatabase();

    const columns = await database.dataSource.query<{ name: string; type: string }[]>(
      `PRAGMA table_info("movement")`,
    );
    const typeOf = (name: string): string | undefined =>
      columns.find((column) => column.name === name)?.type?.toUpperCase();

    expect(typeOf('occurredOn')).toBe('TEXT');
    expect(typeOf('amountMinor')).toBe('TEXT');
    await database.cleanup();
  });

  it('conserva los datos al reabrir la base de datos', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'locha-migration-'));
    const path = join(directory, 'locha.sqlite');

    try {
      const first = new DataSource(buildDataSourceOptions(path));
      await first.initialize();
      await first.runMigrations();

      const accountRepository = first.getRepository(Account);
      const account = await accountRepository.save(
        accountRepository.create({ name: 'Efectivo', currency: 'USD', active: true }),
      );
      const movementRepository = first.getRepository(Movement);
      await movementRepository.save(
        movementRepository.create({
          sourceKey: 'persistencia-1',
          accountId: account.id,
          kind: 'expense',
          amountMinor: 123456n,
          currency: 'USD',
          occurredOn: '2026-01-05',
          description: 'Almuerzo',
        }),
      );
      await first.destroy();

      const second = new DataSource(buildDataSourceOptions(path));
      await second.initialize();

      const persisted = await second.getRepository(Movement).findOne({
        where: { sourceKey: 'persistencia-1' },
      });
      expect(persisted).not.toBeNull();
      expect(persisted?.amountMinor).toBe(123456n);
      expect(persisted?.occurredOn).toBe('2026-01-05');
      expect(persisted?.accountId).toBe(account.id);
      expect(persisted?.description).toBe('Almuerzo');

      const raw = await second.query<{ amountMinor: string; occurredOn: string; type: string }[]>(
        'SELECT amountMinor, occurredOn, typeof(occurredOn) AS type FROM "movement"',
      );
      expect(raw[0]?.amountMinor).toBe('123456');
      expect(raw[0]?.occurredOn).toBe('2026-01-05');
      expect(raw[0]?.type).toBe('text');

      await second.destroy();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('la migracion se puede revertir', async () => {
    const database = await createTempDatabase();

    await database.dataSource.undoLastMigration();
    await database.dataSource.undoLastMigration();

    const tables = await database.dataSource.query<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type = 'table'`,
    );
    expect(tables.map((table) => table.name)).not.toEqual(
      expect.arrayContaining(['movement', 'capture', 'capture_event', 'ai_usage_day']),
    );

    await database.cleanup();
  });
});

describe('Migracion de captura', () => {
  it('crea las tablas de captura, eventos y consumo diario', async () => {
    const database = await createTempDatabase();

    const tables = await database.dataSource.query<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type = 'table'`,
    );

    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(['capture', 'capture_event', 'ai_usage_day']),
    );
    await database.cleanup();
  });

  it('permite un solo borrador vivo por conversacion', async () => {
    const database = await createTempDatabase();
    const repository = database.dataSource.getRepository(Capture);

    await repository.save(
      repository.create({
        chatId: 'chat-1',
        sourceKey: 'capture:1',
        state: 'awaiting_confirmation',
        kind: 'expense',
        amount: '10.00',
        currency: 'USD',
        accountId: 'cuenta-1',
        occurredOn: '2026-11-10',
        description: null,
        sourceText: 'hola',
      }),
    );

    await expect(
      repository.save(
        repository.create({
          chatId: 'chat-1',
          sourceKey: 'capture:2',
          state: 'awaiting_details',
          kind: null,
          amount: null,
          currency: null,
          accountId: null,
          occurredOn: null,
          description: null,
          sourceText: null,
        }),
      ),
    ).rejects.toThrow();

    await database.cleanup();
  });

  it('identifica de forma unica cada evento de la conversacion', async () => {
    const database = await createTempDatabase();
    const repository = database.dataSource.getRepository(CaptureEvent);

    await repository.save(
      repository.create({
        eventId: 'e1',
        chatId: 'chat-1',
        state: 'processing',
        reply: null,
        captureState: null,
        movementId: null,
      }),
    );

    await expect(
      repository.save(
        repository.create({
          eventId: 'e1',
          chatId: 'chat-1',
          state: 'processing',
          reply: null,
          captureState: null,
          movementId: null,
        }),
      ),
    ).rejects.toThrow();

    await database.cleanup();
  });
});
