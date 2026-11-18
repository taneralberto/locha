import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Unidad 1 (historial de Telegram): tabla propia para el texto del usuario y la
 * respuesta del bot del chat privado autorizado.
 *
 * Es **aditiva**: crea una tabla nueva y no reescribe ni una fila de las que ya
 * existian. El historial va aparte de la bandeja de entrada, de la bandeja de salida
 * y del borrador de captura: no se mezcla con el trabajo pendiente ni con lo que ya
 * ocurrio.
 *
 * La clave es la actualizacion y el rol: un texto por actualizacion y rol. Los tiempos
 * son numericos (milisegundos desde epoch) para que la ventana de una hora se
 * compare sin interpretar fechas.
 */
export class TelegramHistory1791158400000 implements MigrationInterface {
  name = 'TelegramHistory1791158400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "telegram_history" (
        "updateId" integer NOT NULL,
        "role" varchar NOT NULL,
        "chatId" varchar NOT NULL,
        "userId" varchar NOT NULL,
        "text" text NOT NULL,
        "sentAt" integer NOT NULL,
        PRIMARY KEY ("updateId", "role")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_telegram_history_subject" ON "telegram_history" ("chatId", "userId", "sentAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_telegram_history_sentAt" ON "telegram_history" ("sentAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_telegram_history_sentAt"`);
    await queryRunner.query(`DROP INDEX "IDX_telegram_history_subject"`);
    await queryRunner.query(`DROP TABLE "telegram_history"`);
  }
}
