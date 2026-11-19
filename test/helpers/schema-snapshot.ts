import { DataSource } from 'typeorm';

/**
 * Columnas historicas del borrador de captura.
 *
 * La tabla `capture` es la unica que las migraciones cambian de forma **aditiva** (la
 * columna `debtPayload` de las deudas): SQLite reescribe su sentencia y `SELECT *`
 * devuelve una columna mas. Por eso su esquema no se compara y sus filas se leen con
 * estas columnas, no con todas.
 *
 * Las bandejas de Telegram tambien cambian de forma aditiva (el teclado de la
 * entrega, su id de mensaje y la pulsacion): su esquema no se compara tampoco y sus
 * filas se leen con las columnas de antes.
 */
const CAPTURE_COLUMNS =
  'chatId, sourceKey, state, kind, amount, currency, accountId, occurredOn, description, sourceText';

const EVENT_COLUMNS =
  'eventId, chatId, state, reply, captureState, movementId, createdAt, updatedAt';

const OUTBOX_COLUMNS =
  'id, updateId, chatId, userId, text, state, attempts, nextAttemptAt, lastError, createdAt, updatedAt';

const INBOX_COLUMNS = 'updateId, chatId, userId, text, receivedAt, state, createdAt, updatedAt';

/** Tablas cuyo esquema cambia de forma aditiva: no se compara su sentencia. */
const ADDITIVE_TABLES = ['capture', 'capture_event', 'telegram_outbox', 'telegram_inbox'];

/**
 * Instantanea del esquema y de las filas de una base, para comparar que una migracion
 * no cambia lo que ya estaba.
 */
export async function snapshot(database: DataSource, tables: string[]) {
  const comparable = tables.filter((table) => !ADDITIVE_TABLES.includes(table));
  const schema = await database.query(
    `SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN (${comparable.map(() => '?').join(',')}) ORDER BY name`,
    comparable,
  );
  const rows = await Promise.all(
    tables.map(async (table) => [table, await rowsOf(database, table)] as const),
  );
  return { schema, rows };
}

async function rowsOf(database: DataSource, table: string): Promise<unknown[]> {
  if (table === 'capture') {
    return database.query(`SELECT ${CAPTURE_COLUMNS} FROM "capture" ORDER BY rowid`);
  }
  if (table === 'capture_event') {
    return database.query(`SELECT ${EVENT_COLUMNS} FROM "capture_event" ORDER BY rowid`);
  }
  if (table === 'telegram_outbox') {
    return database.query(`SELECT ${OUTBOX_COLUMNS} FROM "telegram_outbox" ORDER BY rowid`);
  }
  if (table === 'telegram_inbox') {
    return database.query(`SELECT ${INBOX_COLUMNS} FROM "telegram_inbox" ORDER BY rowid`);
  }
  return database.query(`SELECT * FROM "${table}" ORDER BY rowid`);
}
