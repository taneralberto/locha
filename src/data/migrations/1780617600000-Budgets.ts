import { MigrationInterface, QueryRunner } from 'typeorm';

export class Budgets1780617600000 implements MigrationInterface {
  name = 'Budgets1780617600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "budget" (
      "id" varchar PRIMARY KEY NOT NULL,
      "sourceKey" varchar NOT NULL UNIQUE CHECK (length(trim("sourceKey")) BETWEEN 1 AND 200),
      "name" varchar NOT NULL CHECK (length(trim("name")) BETWEEN 1 AND 80),
      "currency" varchar NOT NULL CHECK ("currency" IN ('USD', 'VES', 'USDT')),
      "limitMinor" text NOT NULL CHECK ("limitMinor" = '0' OR
        (length("limitMinor") > 0 AND "limitMinor" NOT GLOB '*[^0-9]*' AND substr("limitMinor", 1, 1) <> '0')),
      "category" varchar CHECK ("category" IS NULL OR length(trim("category")) BETWEEN 1 AND 80),
      "startsOn" text NOT NULL,
      "endsOn" text NOT NULL CHECK ("endsOn" >= "startsOn"),
      "createdAt" datetime NOT NULL
    )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "budget"`);
  }
}
