import { MigrationInterface, QueryRunner } from 'typeorm';

export class LedgerOperations1775260800000 implements MigrationInterface {
  name = 'LedgerOperations1775260800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "ledger_operation" (
      "id" varchar PRIMARY KEY NOT NULL,
      "sourceKey" varchar NOT NULL UNIQUE,
      "kind" varchar NOT NULL,
      "accountId" varchar NOT NULL,
      "currency" varchar NOT NULL CHECK ("currency" IN ('USD', 'VES', 'USDT')),
      "deltaMinor" text NOT NULL,
      "destinationAccountId" varchar,
      "destinationCurrency" varchar,
      "destinationDeltaMinor" text,
      "feeMovementId" varchar UNIQUE,
      "occurredOn" text NOT NULL,
      "description" varchar,
      "createdAt" datetime NOT NULL,
      CONSTRAINT "CK_ledger_shape" CHECK (
        ("kind" = 'opening' AND "destinationAccountId" IS NULL
          AND "destinationCurrency" IS NULL AND "destinationDeltaMinor" IS NULL
          AND "feeMovementId" IS NULL)
        OR
        ("kind" = 'transfer' AND "destinationAccountId" IS NOT NULL
          AND "destinationAccountId" <> "accountId"
          AND "destinationCurrency" IS NOT NULL AND "destinationCurrency" IN ('USD', 'VES', 'USDT')
          AND "destinationDeltaMinor" IS NOT NULL
          AND substr("deltaMinor", 1, 1) = '-' AND "deltaMinor" <> '-0'
          AND "destinationDeltaMinor" <> '0'
          AND substr("destinationDeltaMinor", 1, 1) <> '0'
          AND "destinationDeltaMinor" NOT GLOB '*[^0-9]*'
          AND length("destinationDeltaMinor") > 0
          AND ("currency" <> "destinationCurrency" OR substr("deltaMinor", 2) = "destinationDeltaMinor"))
      ),
      CONSTRAINT "CK_ledger_delta" CHECK (
        ("deltaMinor" = '0') OR
        (length("deltaMinor") > 0 AND "deltaMinor" NOT GLOB '*[^0-9]*' AND substr("deltaMinor", 1, 1) <> '0') OR
        (substr("deltaMinor", 1, 1) = '-' AND length("deltaMinor") > 1
          AND substr("deltaMinor", 2) NOT GLOB '*[^0-9]*' AND substr("deltaMinor", 2, 1) <> '0')
      ),
      FOREIGN KEY ("accountId") REFERENCES "account" ("id") ON DELETE RESTRICT,
      FOREIGN KEY ("destinationAccountId") REFERENCES "account" ("id") ON DELETE RESTRICT,
      FOREIGN KEY ("feeMovementId") REFERENCES "movement" ("id") ON DELETE RESTRICT
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_ledger_opening_account"
      ON "ledger_operation" ("accountId") WHERE "kind" = 'opening'`);
    await queryRunner.query(`CREATE INDEX "IDX_ledger_destination" ON "ledger_operation" ("destinationAccountId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ledger_operation"`);
  }
}
