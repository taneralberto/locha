import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Segunda migracion: bandeja de entrada de eventos, borradores de captura y consumo
 * diario reservado de inferencia.
 */
export class CaptureAndInference1769904000000 implements MigrationInterface {
  name = 'CaptureAndInference1769904000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "capture" (
        "id" varchar PRIMARY KEY NOT NULL,
        "chatId" varchar NOT NULL,
        "sourceKey" varchar NOT NULL,
        "state" varchar NOT NULL,
        "kind" varchar,
        "amount" varchar,
        "currency" varchar,
        "accountId" varchar,
        "occurredOn" text,
        "description" varchar,
        "sourceText" text,
        "createdAt" datetime NOT NULL,
        "updatedAt" datetime NOT NULL
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_capture_pending_chat" ON "capture" ("chatId") WHERE "state" IN ('awaiting_details', 'awaiting_confirmation')`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_capture_state" ON "capture" ("state")`);

    await queryRunner.query(
      `CREATE TABLE "capture_event" (
        "id" varchar PRIMARY KEY NOT NULL,
        "eventId" varchar NOT NULL,
        "chatId" varchar NOT NULL,
        "state" varchar NOT NULL,
        "reply" text,
        "captureState" varchar,
        "movementId" varchar,
        "createdAt" datetime NOT NULL,
        "updatedAt" datetime NOT NULL
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_capture_event" ON "capture_event" ("eventId", "chatId")`,
    );

    await queryRunner.query(
      `CREATE TABLE "ai_usage_day" (
        "day" varchar PRIMARY KEY NOT NULL,
        "requests" integer NOT NULL DEFAULT (0),
        "inputTokens" integer NOT NULL DEFAULT (0),
        "outputTokens" integer NOT NULL DEFAULT (0),
        "costMicroUsd" integer NOT NULL DEFAULT (0)
      )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ai_usage_day"`);
    await queryRunner.query(`DROP INDEX "UQ_capture_event"`);
    await queryRunner.query(`DROP TABLE "capture_event"`);
    await queryRunner.query(`DROP INDEX "IDX_capture_state"`);
    await queryRunner.query(`DROP INDEX "UQ_capture_pending_chat"`);
    await queryRunner.query(`DROP TABLE "capture"`);
  }
}
