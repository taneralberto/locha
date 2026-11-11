import { MigrationInterface, QueryRunner } from 'typeorm';

export class MovementCorrections1777939200000 implements MigrationInterface {
  name = 'MovementCorrections1777939200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "movement_revision" (
      "id" varchar PRIMARY KEY NOT NULL,
      "sourceKey" varchar NOT NULL UNIQUE,
      "movementId" varchar NOT NULL,
      "revision" integer NOT NULL CHECK (typeof("revision") = 'integer' AND "revision" > 0),
      "expectedRevision" integer NOT NULL CHECK (typeof("expectedRevision") = 'integer' AND "expectedRevision" >= 0 AND "revision" = "expectedRevision" + 1),
      "kind" varchar NOT NULL,
      "reason" varchar NOT NULL CHECK (length(trim("reason")) BETWEEN 1 AND 280),
      "amountMinor" text,
      "occurredOn" text,
      "description" varchar CHECK ("description" IS NULL OR length(trim("description")) BETWEEN 1 AND 280),
      "category" varchar CHECK ("category" IS NULL OR length(trim("category")) BETWEEN 1 AND 80),
      "createdAt" datetime NOT NULL,
      UNIQUE ("movementId", "revision"),
      CHECK (("kind" = 'edit' AND "amountMinor" IS NOT NULL AND length("amountMinor") > 0
        AND "amountMinor" NOT GLOB '*[^0-9]*' AND substr("amountMinor", 1, 1) <> '0'
        AND "occurredOn" IS NOT NULL)
        OR ("kind" = 'void' AND "amountMinor" IS NULL AND "occurredOn" IS NULL
          AND "description" IS NULL AND "category" IS NULL)),
      FOREIGN KEY ("movementId") REFERENCES "movement" ("id") ON DELETE RESTRICT
    )`);
    const signedCheck = (column: string) => `CHECK (
      "${column}" = '0' OR
      (length("${column}") > 0 AND "${column}" NOT GLOB '*[^0-9]*' AND substr("${column}", 1, 1) <> '0') OR
      (substr("${column}", 1, 1) = '-' AND length("${column}") > 1
        AND substr("${column}", 2) NOT GLOB '*[^0-9]*' AND substr("${column}", 2, 1) <> '0'))`;
    await queryRunner.query(`CREATE TABLE "balance_reconciliation" (
      "id" varchar PRIMARY KEY NOT NULL,
      "sourceKey" varchar NOT NULL UNIQUE,
      "accountId" varchar NOT NULL,
      "currency" varchar NOT NULL CHECK ("currency" IN ('USD', 'VES', 'USDT')),
      "targetMinor" text NOT NULL ${signedCheck('targetMinor')},
      "beforeMinor" text NOT NULL ${signedCheck('beforeMinor')},
      "deltaMinor" text NOT NULL ${signedCheck('deltaMinor')},
      "occurredOn" text NOT NULL,
      "reason" varchar NOT NULL CHECK (length(trim("reason")) BETWEEN 1 AND 280),
      "createdAt" datetime NOT NULL,
      FOREIGN KEY ("accountId") REFERENCES "account" ("id") ON DELETE RESTRICT
    )`);
    await queryRunner.query(`CREATE INDEX "IDX_reconciliation_account" ON "balance_reconciliation" ("accountId", "occurredOn")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "balance_reconciliation"`);
    await queryRunner.query(`DROP TABLE "movement_revision"`);
  }
}
