import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Unidad 2 (deudas por conversacion): anade al borrador de captura los datos de deuda.
 *
 * Es **aditiva**: una sola columna de texto. No reescribe filas historicas ni cambia
 * ningun dato de los borradores que ya existian.
 */
export class DebtCapture1788566400000 implements MigrationInterface {
  name = 'DebtCapture1788566400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "capture" ADD COLUMN "debtPayload" text');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "capture" DROP COLUMN "debtPayload"');
  }
}
