import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tercera migracion: bandeja de entrada durable de Telegram, bandeja de salida de
 * respuestas y cursor del polling.
 */
export class TelegramDelivery1772582400000 implements MigrationInterface {
  name = 'TelegramDelivery1772582400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "telegram_inbox" (
        "updateId" integer PRIMARY KEY NOT NULL,
        "chatId" varchar NOT NULL,
        "userId" varchar NOT NULL,
        "text" text,
        "receivedAt" varchar NOT NULL,
        "state" varchar NOT NULL,
        "createdAt" datetime NOT NULL,
        "updatedAt" datetime NOT NULL
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_telegram_inbox_state" ON "telegram_inbox" ("state")`,
    );

    await queryRunner.query(
      `CREATE TABLE "telegram_outbox" (
        "id" varchar PRIMARY KEY NOT NULL,
        "updateId" integer NOT NULL CONSTRAINT "UQ_telegram_outbox_updateId" UNIQUE,
        "chatId" varchar NOT NULL,
        "userId" varchar NOT NULL,
        "text" text NOT NULL,
        "state" varchar NOT NULL,
        "attempts" integer NOT NULL DEFAULT (0),
        "nextAttemptAt" integer NOT NULL DEFAULT (0),
        "lastError" text,
        "createdAt" datetime NOT NULL,
        "updatedAt" datetime NOT NULL
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_telegram_outbox_state" ON "telegram_outbox" ("state")`,
    );

    await queryRunner.query(
      `CREATE TABLE "telegram_cursor" (
        "id" varchar PRIMARY KEY NOT NULL,
        "lastUpdateId" integer NOT NULL DEFAULT (0)
      )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "telegram_cursor"`);
    await queryRunner.query(`DROP INDEX "IDX_telegram_outbox_state"`);
    await queryRunner.query(`DROP TABLE "telegram_outbox"`);
    await queryRunner.query(`DROP INDEX "IDX_telegram_inbox_state"`);
    await queryRunner.query(`DROP TABLE "telegram_inbox"`);
  }
}
