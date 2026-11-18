import { Currency, formatAmount } from '../domain/money';
import { boundedLines } from '../domain/bounded-text';
import type { DebtDirection } from './debt.entity';
import type { DebtStatus, DebtView } from './debt.service';

/**
 * Limite de caracteres del reporte de deudas. Es el limite de un mensaje de Telegram:
 * el reporte se acorta por lineas enteras, nunca a mitad de una.
 */
export const MAX_DEBT_REPORT_CHARS = 4_096;

/**
 * Aviso de que el detalle completo esta en la CLI. La CLI de deudas existe: el listado
 * completo y el historial de una deuda se piden con `debt:list` y `debt:show`.
 */
export const DEBT_DETAIL_FALLBACK = 'Detalle completo: CLI debt:list y debt:show --debt <id>.';

/**
 * La misma pista **sin ids**: es la que ve el usuario del bot, que no conoce (ni
 * necesita) el identificador de la deuda.
 */
export const DEBT_CLI_FALLBACK = 'Detalle completo: CLI debt:list y debt:show.';

/**
 * Como se muestran las filas. La CLI deja el id: sus ids son la forma de seleccionar
 * una deuda. El bot los quita: al usuario le bastan la persona, la direccion, la
 * moneda y los importes.
 */
export interface DebtFormatOptions {
  showIds?: boolean;
}

/** Fila de deuda que el reporte necesita. No incluye el historial de pagos. */
export interface DebtReportRow {
  id: string;
  direction: DebtDirection;
  counterparty: string;
  currency: Currency;
  principalMinor: bigint;
  paidMinor: bigint;
  outstandingMinor: bigint;
  status: DebtStatus;
}

/** La fila de una deuda a partir de su vista: la vista es la fila con su historial. */
export function debtReportRow(view: DebtView): DebtReportRow {
  return {
    id: view.debt.id,
    direction: view.debt.direction,
    counterparty: view.debt.counterparty,
    currency: view.debt.currency,
    principalMinor: view.debt.principalMinor,
    paidMinor: view.paidMinor,
    outstandingMinor: view.outstandingMinor,
    status: view.status,
  };
}

/** Direccion de la deuda con su nombre legible. */
function directionText(direction: DebtDirection): string {
  return direction === 'payable' ? 'lo que debo' : 'lo que me deben';
}

/** Una fila: contraparte, importe original, pagado, pendiente y estado. */
export function formatDebtRow(row: DebtReportRow, options: DebtFormatOptions = {}): string {
  const amount = (value: bigint) => formatAmount(value, row.currency);
  const id = options.showIds === false ? '' : `${row.id} | `;
  return `${id}${row.counterparty} | ${row.currency} | original ${amount(row.principalMinor)} | pagado ${amount(row.paidMinor)} | pendiente ${amount(row.outstandingMinor)} | ${row.status}`;
}

/**
 * Totales por direccion y moneda. **Nunca se compensan**: lo que se debe y lo que nos
 * deben son direcciones distintas, y las monedas distintas tampoco se suman entre si.
 */
export function formatDebtTotals(rows: DebtReportRow[]): string[] {
  const totals = new Map<string, { direction: DebtDirection; currency: DebtReportRow['currency']; minor: bigint }>();
  for (const row of rows) {
    const key = `${row.direction}:${row.currency}`;
    const current = totals.get(key);
    totals.set(key, {
      direction: row.direction,
      currency: row.currency,
      minor: (current?.minor ?? 0n) + row.outstandingMinor,
    });
  }
  return [...totals.values()]
    .sort((left, right) =>
      left.direction === right.direction
        ? left.currency.localeCompare(right.currency)
        : left.direction === 'payable'
          ? -1
          : 1,
    )
    .map(
      (entry) =>
        `  ${directionText(entry.direction)}: ${formatAmount(entry.minor, entry.currency)} ${entry.currency}`,
    );
}

/**
 * Lineas del listado de deudas: separa lo que debo de lo que me deben, muestra cada
 * fila completa y cierra con los totales por direccion y moneda. **No se acota**: la
 * CLI lista todas las filas, sin el tope de caracteres de un mensaje de Telegram.
 */
export function formatDebtList(rows: DebtReportRow[], options: DebtFormatOptions = {}): string[] {
  const payable = rows.filter((row) => row.direction === 'payable');
  const receivable = rows.filter((row) => row.direction === 'receivable');
  const lines: string[] = [];
  if (payable.length > 0) {
    lines.push('Lo que debo:');
    lines.push(...payable.map((row) => `  ${formatDebtRow(row, options)}`));
  }
  if (receivable.length > 0) {
    lines.push('Lo que me deben:');
    lines.push(...receivable.map((row) => `  ${formatDebtRow(row, options)}`));
  }
  lines.push('Totales por direccion y moneda (sin compensar entre direcciones ni monedas):');
  lines.push(...formatDebtTotals(rows));
  return lines;
}

/**
 * Reporte determinista: separa lo que debo de lo que me deben, muestra cada fila
 * completa y cierra con los totales por direccion y moneda. Se acorta por lineas
 * enteras y avisa cuando omite detalle.
 */
export function formatDebtReport(
  rows: DebtReportRow[],
  options: DebtFormatOptions & { title?: string; fallback?: string; empty?: string } = {},
): string {
  const title = options.title ?? 'Deudas:';
  const fallback = options.fallback ?? DEBT_DETAIL_FALLBACK;
  if (rows.length === 0) {
    return [options.empty ?? `${title} no hay deudas registradas.`, fallback].join('\n');
  }
  return boundedLines([title, ...formatDebtList(rows, options)], MAX_DEBT_REPORT_CHARS, fallback);
}

/**
 * Detalle de una deuda con su historial de pagos: cada pago con el id de su
 * movimiento original y si ese movimiento sigue vigente. Es la salida de `debt:show`:
 * no se acota.
 */
export function formatDebtDetail(view: DebtView): string[] {
  const { debt } = view;
  const currency = debt.currency;
  const amount = (value: bigint) => formatAmount(value, currency);
  const lines = [
    `Deuda ${debt.id} | ${directionText(debt.direction)} | ${debt.counterparty} | ${currency} | original ${amount(debt.principalMinor)} | pagado ${amount(view.paidMinor)} | pendiente ${amount(view.outstandingMinor)} | ${view.status} | fecha ${debt.occurredOn} | descripcion ${debt.description ?? '(sin descripcion)'}`,
  ];
  if (view.payments.length === 0) {
    lines.push('Sin pagos.');
    return lines;
  }
  lines.push('Pagos:');
  for (const payment of view.payments) {
    const movement = payment.movement;
    lines.push(
      `  pago ${payment.payment.id} | movimiento ${movement.id} | ${movement.kind === 'income' ? 'ingreso' : 'gasto'} | ${formatAmount(movement.amountMinor, movement.currency)} ${movement.currency} | ${movement.occurredOn} | cuenta ${movement.accountId} | ${payment.voided ? 'anulado' : 'vigente'}`,
    );
  }
  return lines;
}

/**
 * Aviso de que la consulta se corto por el limite del mensaje. **Solo aparece cuando
 * la respuesta no cabe**: el mensaje normal no lleva ningun pie.
 */
const DEBT_QUERY_TRUNCATION = 'Escribe una pregunta más concreta para ver menos deudas.';

/** Como se presenta una consulta de deudas en lenguaje natural. */
export interface DebtQueryOptions {
  /** `true` si el usuario pide el detalle de la deuda, no el resumen. */
  detail?: boolean;
  /** Mensaje cuando no hay deudas que coincidan con la consulta. */
  empty?: string;
}

/**
 * Importe en lenguaje natural: el decimal **exacto** de la moneda (no se redondea), sin
 * los ceros finales de la fraccion (los ceros enteros se conservan) y con la moneda como
 * sufijo. El dollar es el de USD; VES y USDT van con su codigo.
 */
function formatDebtAmount(minor: bigint, currency: Currency): string {
  const [whole = '0', fraction = ''] = formatAmount(minor, currency).split('.');
  const trimmed = fraction.replace(/0+$/, '');
  const exact = trimmed.length === 0 ? whole : `${whole}.${trimmed}`;
  return currency === 'USD' ? `$${exact}` : `${exact} ${currency}`;
}

/**
 * La contraparte como se muestra: los espacios y los saltos se colapsan en uno, para que
 * un nombre con saltos no rompa la fila. **No** se normalizan los diacriticos ni se
 * cambia lo guardado: la base sigue con el nombre tal cual.
 */
function displayCounterparty(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Una deuda de la lista breve: la persona y lo pendiente. El separador es visual (—) y
 * no un dos puntos: el sanitizer de Telegram quita lo que va detras de un "clave:" o un
 * "key:", asi que un nombre asi se quedaria sin persona ni importe.
 *
 * Una deuda **saldada** no tiene pendiente: se muestra lo que se saldo, no un cero.
 */
function debtBullet(row: DebtReportRow): string {
  const settled = row.status === 'paid';
  const amount = formatDebtAmount(settled ? row.paidMinor : row.outstandingMinor, row.currency);
  const bullet = `• ${displayCounterparty(row.counterparty)} — ${amount}`;
  return settled ? `${bullet} (saldada)` : bullet;
}

/**
 * La lista breve: lo que debo y lo que me deben, con una linea en blanco entre los
 * grupos. No lleva totales ni estados: solo la persona y el importe.
 *
 * Cada **unidad** es lo que no se parte al acortar: la cabecera de un grupo va con su
 * primera viñeta, nunca sola.
 */
function debtSummaryUnits(rows: DebtReportRow[]): string[] {
  const units: string[] = [];
  const groups: Array<{ header: string; rows: DebtReportRow[] }> = [
    { header: 'Lo que debo:', rows: rows.filter((row) => row.direction === 'payable') },
    { header: 'Lo que me deben:', rows: rows.filter((row) => row.direction === 'receivable') },
  ];
  for (const group of groups) {
    if (group.rows.length === 0) {
      continue;
    }
    const bullets = group.rows.map(debtBullet);
    const blank = units.length > 0 ? '\n' : '';
    units.push(`${blank}${group.header}\n${bullets[0]}`);
    units.push(...bullets.slice(1));
  }
  return units;
}

/** Las etiquetas del detalle, con el verbo de la direccion de la deuda. */
function detailLabels(direction: DebtDirection): { paid: string; pending: string } {
  return direction === 'payable'
    ? { paid: 'Le he pagado', pending: 'Me falta por pagar' }
    : { paid: 'Me ha pagado', pending: 'Me falta por cobrar' };
}

/**
 * El detalle de cada deuda: el monto inicial, los abonos y lo que queda pendiente. Cada
 * deuda va en su propio bloque y el bloque **no se parte** al acortar: si varias
 * coinciden, **no se suman** ni se elige una.
 */
function debtDetailUnits(rows: DebtReportRow[]): string[] {
  const units: string[] = [];
  for (const row of rows) {
    const labels = detailLabels(row.direction);
    const block = [
      `${displayCounterparty(row.counterparty)} (${directionText(row.direction)}, ${row.currency})`,
      `  Monto inicial: ${formatDebtAmount(row.principalMinor, row.currency)}`,
      `  ${labels.paid}: ${formatDebtAmount(row.paidMinor, row.currency)}`,
      row.status === 'paid'
        ? '  Esta deuda está saldada.'
        : `  ${labels.pending}: ${formatDebtAmount(row.outstandingMinor, row.currency)}`,
    ].join('\n');
    units.push(units.length > 0 ? `\n${block}` : block);
  }
  return units;
}

/**
 * Consulta de deudas en lenguaje natural: la lista breve de lo pendiente o, si el
 * usuario pide el detalle, el monto inicial, los abonos y el pendiente de cada deuda.
 *
 * Es determinista y **sin ids, estados internos ni totales**: solo la persona y los
 * importes. El pie de la CLI no aparece: el detalle se pide con una pregunta más
 * concreta. Si la respuesta no cabe, se acorta por unidades enteras (una fila de la
 * lista o un bloque del detalle) y avisa.
 */
export function formatDebtQuery(rows: DebtReportRow[], options: DebtQueryOptions = {}): string {
  if (rows.length === 0) {
    return options.empty ?? 'No hay deudas que coincidan con la consulta.';
  }
  const units = options.detail === true ? debtDetailUnits(rows) : debtSummaryUnits(rows);
  return fitDebtQuery(units);
}

/**
 * Acota la consulta al limite de Telegram: si no cabe, se omiten unidades enteras (una
 * fila de la lista o un bloque completo del detalle) y avisa.
 */
function fitDebtQuery(units: string[]): string {
  if (units.join('\n').length <= MAX_DEBT_REPORT_CHARS) {
    return units.join('\n');
  }
  return boundedLines(units, MAX_DEBT_REPORT_CHARS, DEBT_QUERY_TRUNCATION);
}
