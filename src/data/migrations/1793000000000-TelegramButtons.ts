import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Unidad 1 (botones inline de Telegram): el teclado de la respuesta, el id del
 * mensaje enviado y la pulsacion de boton.
 *
 * Es **aditiva**: anade tres columnas y no reescribe ni una fila de las que ya
 * existian.
 *
 * - `telegram_outbox.markup`: el teclado inline (JSON) de la entrega.
 * - `telegram_outbox.messageId`: el id del mensaje que creo Telegram. Es unico
 *   dentro del chat: con el chat es la evidencia de a que entrega pertenece un boton
 *   pulsado.
 * - `telegram_inbox.callback`: la pulsacion (JSON). Viaja **aparte** del texto: una
 *   pulsacion no es un mensaje del usuario.
 *
 * El `down` quita las tres columnas: su contenido es transitorio (una entrega y una
 * pulsacion) y no afecta a los mensajes ya registrados.
 */
export class TelegramButtons1793000000000 implements MigrationInterface {
  name = 'TelegramButtons1793000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "telegram_outbox" ADD COLUMN "markup" text`);
    await queryRunner.query(`ALTER TABLE "telegram_outbox" ADD COLUMN "messageId" integer`);
    await queryRunner.query(`ALTER TABLE "telegram_inbox" ADD COLUMN "callback" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Las pulsaciones pendientes se descartan antes de quitar su columna: sin la
    // columna no se pueden volver a leer y no deben quedar esperando una entrega.
    await queryRunner.query(
      `UPDATE "telegram_inbox" SET "state" = 'discarded', "callback" = NULL WHERE "state" = 'accepted' AND "callback" IS NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "telegram_inbox" DROP COLUMN "callback"`);
    await queryRunner.query(`ALTER TABLE "telegram_outbox" DROP COLUMN "messageId"`);
    await queryRunner.query(`ALTER TABLE "telegram_outbox" DROP COLUMN "markup"`);
  }
}
