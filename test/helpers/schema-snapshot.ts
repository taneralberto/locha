import { DataSource } from 'typeorm';

/**
 * Columnas historicas del borrador de captura.
 *
 * La tabla `capture` es la unica que las migraciones cambian de forma **aditiva** (la
 * columna `debtPayload` de las deudas): SQLite reescribe su sentencia y `SELECT *`
 * devuelve una columna mas. Por eso su esquema no se compara y sus filas se leen con
 * estas columnas, no con todas.
 */
const CAPTURE_COLUMNS =
  'chatId, sourceKey, state, kind, amount, currency, accountId, occurredOn, description, sourceText';

/**
 * Instantanea del esquema y de las filas de una base, para comparar que una migracion
 * no cambia lo que ya estaba.
 */
export async function snapshot(database: DataSource, tables: string[]) {
  const comparable = tables.filter((table) => table !== 'capture');
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
  return database.query(`SELECT * FROM "${table}" ORDER BY rowid`);
}
