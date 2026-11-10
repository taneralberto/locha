import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Contexto de aplicacion NestJS', () => {
  it('arranca sin HTTP, expone los servicios y comparte el DataSource con la CLI', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'locha-app-'));
    const databasePath = join(directory, 'locha.sqlite');
    const previousPath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = databasePath;

    try {
      const { NestFactory } = await import('@nestjs/core');
      const { DataSource } = await import('typeorm');
      const { AppModule } = await import('../src/app.module');
      const { AccountService } = await import('../src/accounts/account.service');
      const { FinancialService } = await import('../src/financial/financial.service');
      const { CaptureService } = await import('../src/capture/capture.service');
      const { OperationInterpreter } = await import('../src/interpreter/interpreter');
      const { TelegramService } = await import('../src/telegram/telegram.service');

      const app = await NestFactory.createApplicationContext(AppModule, {
        logger: false,
        abortOnError: false,
      });
      try {
        expect(app.get(AccountService)).toBeDefined();
        expect(app.get(FinancialService)).toBeDefined();
        expect(app.get(CaptureService)).toBeDefined();
        expect(app.get(OperationInterpreter)).toBeDefined();
        expect(app.get(TelegramService)).toBeDefined();

        const dataSource = app.get(DataSource);
        const applied = await dataSource.runMigrations();
        expect(applied.map((migration) => migration.name)).toEqual([
          'InitialSchema1767225600000',
          'CaptureAndInference1769904000000',
          'TelegramDelivery1772582400000',
        ]);

        const tables = await dataSource.query<{ name: string }[]>(
          `SELECT name FROM sqlite_master WHERE type = 'table'`,
        );
        expect(tables.map((table) => table.name)).toEqual(
          expect.arrayContaining([
            'account',
            'movement',
            'capture',
            'capture_event',
            'ai_usage_day',
            'telegram_inbox',
            'telegram_outbox',
            'telegram_cursor',
          ]),
        );
      } finally {
        await app.close();
      }
    } finally {
      if (previousPath === undefined) {
        delete process.env.DATABASE_PATH;
      } else {
        process.env.DATABASE_PATH = previousPath;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('no arranca con DATABASE_PATH vacio', async () => {
    const previousPath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = '   ';

    try {
      const { NestFactory } = await import('@nestjs/core');
      const { AppModule } = await import('../src/app.module');

      await expect(
        NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false }),
      ).rejects.toThrow(/DATABASE_PATH/);
    } finally {
      if (previousPath === undefined) {
        delete process.env.DATABASE_PATH;
      } else {
        process.env.DATABASE_PATH = previousPath;
      }
    }
  });
});
