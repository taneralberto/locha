import { MigrationInterface, QueryRunner } from 'typeorm';

export class GoalsAndSavings1783209600000 implements MigrationInterface {
  name = 'GoalsAndSavings1783209600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "goal" (
      "id" varchar PRIMARY KEY NOT NULL,
      "sourceKey" varchar NOT NULL UNIQUE CHECK (length(trim("sourceKey")) BETWEEN 1 AND 200),
      "name" varchar NOT NULL CHECK (length(trim("name")) BETWEEN 1 AND 80),
      "currency" varchar NOT NULL CHECK ("currency" IN ('USD', 'VES', 'USDT')),
      "targetMinor" text NOT NULL CHECK (length("targetMinor") > 0 AND "targetMinor" NOT GLOB '*[^0-9]*' AND substr("targetMinor", 1, 1) <> '0'),
      "targetOn" text,
      "createdAt" datetime NOT NULL
    )`);
    await queryRunner.query(`CREATE TABLE "savings_entry" (
      "id" varchar PRIMARY KEY NOT NULL,
      "sourceKey" varchar NOT NULL UNIQUE CHECK (length(trim("sourceKey")) BETWEEN 1 AND 200),
      "kind" varchar NOT NULL CHECK ("kind" IN ('reserve', 'release')),
      "accountId" varchar NOT NULL REFERENCES "account"("id") ON DELETE RESTRICT,
      "goalId" varchar NOT NULL REFERENCES "goal"("id") ON DELETE RESTRICT,
      "currency" varchar NOT NULL CHECK ("currency" IN ('USD', 'VES', 'USDT')),
      "amountMinor" text NOT NULL CHECK (length("amountMinor") > 0 AND "amountMinor" NOT GLOB '*[^0-9]*' AND substr("amountMinor", 1, 1) <> '0'),
      "createdAt" datetime NOT NULL
    )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "savings_entry"');
    await queryRunner.query('DROP TABLE "goal"');
  }
}
