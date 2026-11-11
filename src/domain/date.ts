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
  // Date.UTC trata los anos 00..99 como 1900..1999 y pierde sus dias bisiestos reales.
  const date = new Date(0);
  date.setUTCFullYear(targetYear, targetMonth - 1, targetDay);
  const isRealDate =
    date.getUTCFullYear() === targetYear &&
    date.getUTCMonth() === targetMonth - 1 &&
    date.getUTCDate() === targetDay;
  if (!isRealDate) {
    throw new ValidationError(`Fecha invalida "${input}"; no existe en el calendario.`);
  }
  return `${year}-${month}-${day}`;
}

/** Periodo inclusivo de un mes real, sin rollover. */
export function monthPeriod(input: string): { startsOn: string; endsOn: string } {
  const month = parseMonth(input);
  const year = Number(month.slice(0, 4));
  const number = Number(month.slice(5));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const last = number === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(number) ? 30 : 31;
  return { startsOn: `${month}-01`, endsOn: `${month}-${last}` };
}

/** Quincenas de calendario: 1..15 o 16..ultimo dia del mes. */
export function quincenaPeriod(input: string, half: 'first' | 'second'): { startsOn: string; endsOn: string } {
  const period = monthPeriod(input);
  if (half !== 'first' && half !== 'second') throw new ValidationError('La quincena debe ser first o second.');
  return half === 'first' ? { startsOn: period.startsOn, endsOn: `${period.startsOn.slice(0, 7)}-15` }
    : { startsOn: `${period.startsOn.slice(0, 7)}-16`, endsOn: period.endsOn };
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
