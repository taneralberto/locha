import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1767225600000 implements MigrationInterface {
  name = 'InitialSchema1767225600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "account" (
        "id" varchar PRIMARY KEY NOT NULL,
        "name" varchar NOT NULL CONSTRAINT "UQ_account_name" UNIQUE,
        "currency" varchar NOT NULL,
        "active" boolean NOT NULL DEFAULT (1)
      )`,
    );
    await queryRunner.query(
      `CREATE TABLE "movement" (
        "id" varchar PRIMARY KEY NOT NULL,
        "sourceKey" varchar NOT NULL CONSTRAINT "UQ_movement_sourceKey" UNIQUE,
        "accountId" varchar NOT NULL,
        "kind" varchar NOT NULL,
        "amountMinor" text NOT NULL,
        "currency" varchar NOT NULL,
        "occurredOn" text NOT NULL,
        "description" varchar,
        "createdAt" datetime NOT NULL,
        CONSTRAINT "FK_movement_accountId" FOREIGN KEY ("accountId") REFERENCES "account" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_movement_accountId" ON "movement" ("accountId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_movement_accountId"`);
    await queryRunner.query(`DROP TABLE "movement"`);
    await queryRunner.query(`DROP TABLE "account"`);
  }
}
