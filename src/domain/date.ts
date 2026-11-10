import { ValidationError } from './errors';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

/**
 * Valida un mes de calendario (`YYYY-MM`) y devuelve su forma canonica. Un mes que no
 * existe (por ejemplo `2026-13`) se rechaza: los totales del mes se calculan sobre el
 * calendario, no sobre un texto arbitrario.
 */
export function parseMonth(input: string): string {
  const raw = input.trim();
  const match = MONTH_PATTERN.exec(raw);
  const year = match?.[1];
  const month = match?.[2];
  if (year === undefined || month === undefined) {
    throw new ValidationError(`Mes invalido "${input}"; se espera el formato YYYY-MM.`);
  }
  const targetMonth = Number(month);
  if (targetMonth < 1 || targetMonth > 12) {
    throw new ValidationError(`Mes invalido "${input}"; no existe en el calendario.`);
  }
  return `${year}-${month}`;
}

/**
 * Valida una fecha de calendario y devuelve su forma canonica `YYYY-MM-DD`.
 * Rechaza fechas que no existen (por ejemplo, 2026-02-30).
 */
export function parseDate(input: string): string {
  const raw = input.trim();
  const match = DATE_PATTERN.exec(raw);
  const year = match?.[1];
  const month = match?.[2];
  const day = match?.[3];
  if (year === undefined || month === undefined || day === undefined) {
    throw new ValidationError(`Fecha invalida "${input}"; se espera el formato YYYY-MM-DD.`);
  }
  const targetYear = Number(year);
  const targetMonth = Number(month);
  const targetDay = Number(day);
  const date = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay));
  if (targetYear < 100) {
    date.setUTCFullYear(targetYear);
  }
  const isRealDate =
    date.getUTCFullYear() === targetYear &&
    date.getUTCMonth() === targetMonth - 1 &&
    date.getUTCDate() === targetDay;
  if (!isRealDate) {
    throw new ValidationError(`Fecha invalida "${input}"; no existe en el calendario.`);
  }
  return `${year}-${month}-${day}`;
}

/**
 * Devuelve la fecha (`YYYY-MM-DD`) de un instante en una zona horaria IANA.
 * Se usa para fijar la fecha por defecto de una operacion segun la zona del usuario.
 */
export function dateInTimeZone(instant: Date, timeZone: string): string {
  if (Number.isNaN(instant.getTime())) {
    throw new ValidationError('El instante no es una fecha valida.');
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const year = value('year');
  const month = value('month');
  const day = value('day');
  if (!year || !month || !day) {
    throw new ValidationError(`No se pudo resolver la fecha en la zona "${timeZone}".`);
  }
  return `${year}-${month}-${day}`;
}
