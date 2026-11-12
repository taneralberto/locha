/**
 * Lo que sale del bot hacia Telegram nunca lleva identificadores tecnicos: ni ids, ni
 * claves, ni JSON crudo. Las respuestas nuevas se escriben asi desde el principio; esta
 * capa es la red de seguridad para lo que ya estaba guardado (respuestas durables
 * antiguas y respuestas pendientes en la bandeja de salida).
 */

/** Un identificador tecnico: el formato de un uuid. */
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** "Movimiento: <id>" y "| id: <id>": la etiqueta y el valor tecnico, juntos. */
const LABELLED_ID = new RegExp(
  `\\b(movimiento|deuda|pago|id|uuid|referencia)\\s*:\\s*["'\\u201c\\u201d]?\\s*${UUID_SOURCE}\\s*["'\\u201c\\u201d]?`,
  'gi',
);

/** El identificador suelto, con las comillas que lo rodeen. */
const ID_TOKEN = new RegExp(`["'\\u201c\\u201d]?\\s*${UUID_SOURCE}\\s*["'\\u201c\\u201d]?`, 'gi');

/**
 * Las claves idempotentes que genera la propia aplicacion. No son ids, pero tampoco son
 * informacion para el usuario: la de la captura (`capture:<hash>`), la de la comision
 * de una transferencia (`ledger:<id>:fee`) y la del pago de una deuda
 * (`debt-payment:<id>`).
 */
const APP_KEY = new RegExp(
  `(?:capture:[0-9a-f]{64}|ledger:${UUID_SOURCE}:fee|debt-payment:${UUID_SOURCE})`,
  'gi',
);

/**
 * Error de dominio que repite la clave del usuario. Se cuenta el problema **sin la
 * clave**: el usuario no la necesita y no debe verla.
 *
 * El valor de la clave es texto arbitrario: **no se supone** que no traiga comillas.
 * El cierre es la ultima comilla antes de «ya existe», asi que una clave con comillas
 * dentro se cuenta entera. Se aplica al texto **entero** (la clave puede traer saltos
 * de linea) y con un tope: la clave del dominio no pasa de 200 caracteres.
 */
const KEY_ERROR = /La\s+clave\s+"[\s\S]{0,300}?"\s+ya\s+existe\s+con\s+otro\s+contenido\./g;

/** Como se cuenta el error de clave sin repetirla. */
const KEY_ERROR_TEXT = 'Ya existe una operacion con esa clave y con otro contenido.';

/**
 * Campos que hacen que un JSON sea la foto tecnica de una entidad y no texto del
 * usuario: su identidad y sus metadatos.
 */
const TECHNICAL_KEYS = new Set([
  'id',
  'sourceKey',
  'accountId',
  'movementId',
  'amountMinor',
  'debtId',
  'paymentId',
  'goalId',
  'budgetId',
  'createdAt',
  'updatedAt',
  'chatId',
  'userId',
  'captureState',
  'sourceText',
  'revision',
  'expectedRevision',
]);

/** Aviso para una respuesta que solo tiene datos tecnicos. */
export const TECHNICAL_FALLBACK =
  'Esa respuesta guarda datos tecnicos que no se muestran. Consulta los datos actuales con /recent, /balances, /debts o /summary.';

/**
 * Quita los identificadores tecnicos de una respuesta. Si el texto es solo tecnico (el
 * JSON de una entidad), se sustituye por un aviso: no se enseña ni un id ni un campo
 * interno.
 */
export function sanitizeTelegramText(text: string): string {
  if (text.trim().length === 0) {
    return text;
  }
  if (hasTechnicalPayload(text)) {
    return TECHNICAL_FALLBACK;
  }
  // El error de dominio que repite la clave se cuenta **sobre el texto entero**: la
  // clave es arbitraria y puede traer saltos de linea.
  const withoutKeyError = text.replace(KEY_ERROR, KEY_ERROR_TEXT);
  const lines = withoutKeyError.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const cleaned = cleanLine(line);
    if (cleaned === null) {
      continue;
    }
    kept.push(cleaned);
  }
  const result = kept.join('\n');
  // Una respuesta que se queda sin contenido no se envia: se manda el aviso.
  return result.trim().length === 0 ? TECHNICAL_FALLBACK : result;
}

/**
 * Limpia una linea. Devuelve `null` cuando la linea se queda sin contenido: una linea
 * que solo era un identificador no dice nada.
 */
function cleanLine(line: string): string | null {
  const cleaned = redactLabelledKeys(line)
    .replace(LABELLED_ID, '')
    .replace(APP_KEY, '')
    .replace(ID_TOKEN, '')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/, '');
  if (cleaned.trim().length === 0 && line.trim().length > 0) {
    return null;
  }
  // Una linea que se queda solo con una etiqueta tecnica ya no dice nada.
  if (/^\s*(?:movimiento|deuda|pago|id|uuid|referencia)\s*:\s*$/i.test(cleaned)) {
    return null;
  }
  return cleaned;
}

/**
 * Quita el valor de una clave tecnica (`sourceKey`, `clave`, `key`). El valor se
 * consume **completo**: entre comillas, con los espacios y las comillas escapadas
 * dentro; sin comillas, hasta el espacio. Si el valor no se puede delimitar, se quita
 * desde la etiqueta hasta el final de la linea: es mejor quitar de mas que dejar parte
 * de la clave a la vista. El resto de la linea (importes, nombres) se conserva.
 */
function redactLabelledKeys(line: string): string {
  const label = /\b(?:sourceKey|clave|key)\s*[:=]\s*/gi;
  let result = '';
  let rest = line;
  for (;;) {
    label.lastIndex = 0;
    const match = label.exec(rest);
    if (match === null) {
      return result + rest;
    }
    result += rest.slice(0, match.index);
    const after = rest.slice(match.index + match[0].length);
    rest = after.slice(keyValueLength(after));
  }
}

/**
 * Cuanto ocupa el valor de una clave tecnica. `0` si no hay valor. Un valor que no se
 * puede delimitar (comillas sin cerrar, o una comilla suelta) ocupa el resto de la
 * linea: es el fragmento tecnico entero.
 */
function keyValueLength(after: string): number {
  const first = after[0];
  if (first === undefined) {
    return 0;
  }
  const closing = closingQuoteOf(first);
  if (closing !== null) {
    const end = closingQuote(after, closing);
    return end === -1 ? after.length : end + 1;
  }
  const token = /^\S+/.exec(after)?.[0] ?? '';
  // Un valor sin comillas que trae una comilla es ambiguo: no se puede delimitar.
  return /["'“”]/.test(token) ? after.length : token.length;
}

/** La comilla que cierra a la que abre, o `null` si no es una comilla. */
function closingQuoteOf(opening: string): string | null {
  if (opening === '"' || opening === "'") {
    return opening;
  }
  if (opening === '“') {
    return '”';
  }
  if (opening === '”') {
    return '“';
  }
  return null;
}

/** La posicion de la comilla que cierra el valor; `-1` si no cierra. */
function closingQuote(text: string, quote: string): number {
  let escaped = false;
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === quote) {
      return index;
    }
  }
  return -1;
}

/**
 * `true` si el texto trae la foto tecnica de una entidad. Solo cuenta un JSON que se
 * puede **leer** y que tiene campos de identidad o de metadatos: el texto del usuario
 * con llaves o corchetes (una cuenta llamada «Caja {id: local}») no se hides.
 */
function hasTechnicalPayload(text: string): boolean {
  if (isTechnicalPayload(readJson(text.trim()))) {
    return true;
  }
  for (const line of text.split('\n')) {
    for (const candidate of jsonCandidates(line)) {
      if (isTechnicalPayload(readJson(candidate))) {
        return true;
      }
    }
  }
  return false;
}

/** Lee un JSON; `undefined` si no se puede leer. */
function readJson(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Los bloques JSON completos de una linea (uno por cada objeto o lista). Solo se
 * cuentan los que estan balanceados: una llave suelta del texto del usuario no es un
 * JSON.
 */
function jsonCandidates(line: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      if (depth === 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(line.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

/** `true` si lo leido tiene campos de identidad o de metadatos. */
function isTechnicalPayload(parsed: unknown): boolean {
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.some(
    (row) =>
      typeof row === 'object' &&
      row !== null &&
      Object.keys(row).some((key) => TECHNICAL_KEYS.has(key)),
  );
}
