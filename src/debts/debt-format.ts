import { Currency, formatAmount } from '../domain/money';
import { boundedLines } from '../domain/bounded-text';
import type { DebtDirection } from './debt.entity';
import type { DebtStatus } from './debt.service';

/**
 * Limite de caracteres del reporte de deudas. Es el limite de un mensaje de Telegram:
 * el reporte se acorta por lineas enteras, nunca a mitad de una.
 */
export const MAX_DEBT_REPORT_CHARS = 4_096;

/**
 * Aviso de que el detalle completo estara en la CLI. La CLI de deudas llega en la
 * unidad siguiente: mientras tanto, el reporte es la fuente completa.
 */
export const DEBT_DETAIL_FALLBACK = 'Detalle completo: CLI debt:list (todavia no disponible).';

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

/** Una fila: id, contraparte, importe original, pagado, pendiente y estado. */
export function formatDebtRow(row: DebtReportRow): string {
  const amount = (value: bigint) => formatAmount(value, row.currency);
  return `${row.id} | ${row.counterparty} | ${row.currency} | original ${amount(row.principalMinor)} | pagado ${amount(row.paidMinor)} | pendiente ${amount(row.outstandingMinor)} | ${row.status}`;
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
        `  ${entry.direction === 'payable' ? 'lo que debo' : 'lo que me deben'}: ${formatAmount(entry.minor, entry.currency)} ${entry.currency}`,
    );
}

/**
 * Reporte determinista: separa lo que debo de lo que me deben, muestra cada fila
 * completa y cierra con los totales por direccion y moneda. Se acorta por lineas
 * enteras y avisa cuando omite detalle.
 */
export function formatDebtReport(
  rows: DebtReportRow[],
  options: { title?: string; fallback?: string; empty?: string } = {},
): string {
  const title = options.title ?? 'Deudas:';
  const fallback = options.fallback ?? DEBT_DETAIL_FALLBACK;
  if (rows.length === 0) {
    return [options.empty ?? `${title} no hay deudas registradas.`, fallback].join('\n');
  }
  const payable = rows.filter((row) => row.direction === 'payable');
  const receivable = rows.filter((row) => row.direction === 'receivable');
  const lines: string[] = [title];
  if (payable.length > 0) {
    lines.push('Lo que debo:');
    lines.push(...payable.map((row) => `  ${formatDebtRow(row)}`));
  }
  if (receivable.length > 0) {
    lines.push('Lo que me deben:');
    lines.push(...receivable.map((row) => `  ${formatDebtRow(row)}`));
  }
  lines.push('Totales por direccion y moneda (sin compensar entre direcciones ni monedas):');
  lines.push(...formatDebtTotals(rows));
  return boundedLines(lines, MAX_DEBT_REPORT_CHARS, fallback);
}
