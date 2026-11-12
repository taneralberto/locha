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
