import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Unidad 2 (correccion de gasto desde la captura): columnas nullable del borrador y
 * del evento de captura.
 *
 * Es **aditiva**: anade `capture.correctionTargetEventId` y `capture_event.metadata`, y
 * no reescribe ni una fila de las que ya existian.
 *
 * - `capture.correctionTargetEventId`: la **PK interna** del evento de captura que
 *   ancla la correccion (la entrega anterior, ya confirmada). No es el id del
 *   transporte y no se manda al modelo.
 * - `capture_event.metadata`: los metadatos del evento (que se puede hacer con el y
 *   desde donde), en JSON. Van **con la respuesta** del evento, en la misma
 *   transaccion.
 *
 * El `down` es seguro: cancela los borradores correctivos vivos (sin la columna que
 * los ancla, un `/confirm` no podria aplicarlos con seguridad) y no toca los
 * movimientos ya registrados.
 */
export class ExpenseCorrection1792000000000 implements MigrationInterface {
  name = 'ExpenseCorrection1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "capture" ADD COLUMN "correctionTargetEventId" varchar`);
    await queryRunner.query(`ALTER TABLE "capture_event" ADD COLUMN "metadata" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "capture"
       SET "state" = 'cancelled', "sourceText" = NULL, "debtPayload" = NULL,
           "amount" = NULL, "currency" = NULL, "accountId" = NULL,
           "occurredOn" = NULL, "description" = NULL, "correctionTargetEventId" = NULL
       WHERE "kind" = 'expense_correction'
         AND "state" IN ('awaiting_details', 'awaiting_confirmation')`,
    );
    await queryRunner.query(`ALTER TABLE "capture_event" DROP COLUMN "metadata"`);
    await queryRunner.query(`ALTER TABLE "capture" DROP COLUMN "correctionTargetEventId"`);
  }
}
