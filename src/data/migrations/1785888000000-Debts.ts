import { MigrationInterface, QueryRunner } from 'typeorm';

export class Debts1785888000000 implements MigrationInterface {
  name = 'Debts1785888000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "debt" (
      "id" varchar PRIMARY KEY NOT NULL,
      "sourceKey" varchar NOT NULL UNIQUE CHECK (length(trim("sourceKey")) BETWEEN 1 AND 200),
      "direction" varchar NOT NULL CHECK ("direction" IN ('payable', 'receivable')),
      "counterparty" varchar NOT NULL CHECK (length(trim("counterparty")) BETWEEN 1 AND 120),
      "currency" varchar NOT NULL CHECK ("currency" IN ('USD', 'VES', 'USDT')),
      "principalMinor" text NOT NULL CHECK (length("principalMinor") > 0 AND "principalMinor" NOT GLOB '*[^0-9]*' AND substr("principalMinor", 1, 1) <> '0'),
      "occurredOn" text NOT NULL,
      "description" varchar CHECK ("description" IS NULL OR length(trim("description")) BETWEEN 1 AND 280),
      "createdAt" datetime NOT NULL
    )`);
    await queryRunner.query(`CREATE TABLE "debt_payment" (
      "id" varchar PRIMARY KEY NOT NULL,
      "sourceKey" varchar NOT NULL UNIQUE CHECK (length(trim("sourceKey")) BETWEEN 1 AND 200),
      "debtId" varchar NOT NULL,
      "movementId" varchar NOT NULL UNIQUE,
      "expectedOutstandingMinor" text NOT NULL CHECK (length("expectedOutstandingMinor") > 0 AND "expectedOutstandingMinor" NOT GLOB '*[^0-9]*' AND substr("expectedOutstandingMinor", 1, 1) <> '0'),
      "createdAt" datetime NOT NULL,
      FOREIGN KEY ("debtId") REFERENCES "debt" ("id") ON DELETE RESTRICT,
      FOREIGN KEY ("movementId") REFERENCES "movement" ("id") ON DELETE RESTRICT
    )`);
    await queryRunner.query('CREATE INDEX "IDX_debt_payment_debt" ON "debt_payment" ("debtId")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "debt_payment"');
    await queryRunner.query('DROP TABLE "debt"');
  }
}
