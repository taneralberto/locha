import { ValidationError } from './errors';

/**
 * Registro de monedas soportadas. `scale` es la cantidad de decimales de cada moneda.
 * Es la unica fuente de verdad sobre monedas y escalas del proyecto.
 */
export const CURRENCIES = {
  VES: { scale: 2 },
  USD: { scale: 2 },
  USDT: { scale: 6 },
} as const;

export type Currency = keyof typeof CURRENCIES;

export const CURRENCY_CODES = Object.keys(CURRENCIES) as Currency[];

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && Object.hasOwn(CURRENCIES, value);
}

export function scaleOf(currency: Currency): number {
  return CURRENCIES[currency].scale;
}

const AMOUNT_PATTERN = /^(\d+)(?:\.(\d+))?$/;

/**
 * Convierte un importe decimal ("1234.56") en unidades menores exactas (123456n).
 * Rechaza negativos, cero, formatos invalidos y cualquier importe que exija redondeo.
 */
export function parseAmount(input: string, currency: Currency): bigint {
  const raw = input.trim();
  if (raw.startsWith('-')) {
    throw new ValidationError(`El importe "${input}" debe ser positivo.`);
  }
  const match = AMOUNT_PATTERN.exec(raw);
  const whole = match?.[1];
  const fraction = match?.[2] ?? '';
  if (whole === undefined) {
    throw new ValidationError(`Importe invalido "${input}" para ${currency}.`);
  }
  const scale = scaleOf(currency);
  if (fraction.length > scale) {
    throw new ValidationError(
      `El importe "${input}" tiene mas de ${scale} decimales para ${currency}; no se redondea.`,
    );
  }
  const minor = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
  if (minor <= 0n) {
    throw new ValidationError(`El importe "${input}" debe ser mayor que cero.`);
  }
  return minor;
}

/** Formatea unidades menores como decimal exacto de la moneda (123456n USD -> "1234.56"). */
export function formatAmount(minor: bigint, currency: Currency): string {
  const scale = scaleOf(currency);
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
