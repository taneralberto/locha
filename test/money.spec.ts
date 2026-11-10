import { ValidationError } from '../src/domain/errors';
import { CURRENCIES, CURRENCY_CODES, formatAmount, isCurrency, parseAmount } from '../src/domain/money';
import { parseDate } from '../src/domain/date';

describe('Registro de monedas', () => {
  it('expone las monedas soportadas con su escala', () => {
    expect(CURRENCY_CODES).toEqual(['VES', 'USD', 'USDT']);
    expect(CURRENCIES.VES.scale).toBe(2);
    expect(CURRENCIES.USD.scale).toBe(2);
    expect(CURRENCIES.USDT.scale).toBe(6);
  });

  it('rechaza monedas fuera del registro', () => {
    expect(isCurrency('USD')).toBe(true);
    expect(isCurrency('EUR')).toBe(false);
    expect(isCurrency('usd')).toBe(false);
    expect(isCurrency(undefined)).toBe(false);
  });
});

describe('parseAmount', () => {
  it('convierte importes decimales a unidades menores exactas', () => {
    expect(parseAmount('1234.56', 'USD')).toBe(123456n);
    expect(parseAmount('0.01', 'USD')).toBe(1n);
    expect(parseAmount('1234.567890', 'USDT')).toBe(1234567890n);
    expect(parseAmount('0.000001', 'USDT')).toBe(1n);
    expect(parseAmount('3500', 'VES')).toBe(350000n);
  });

  it('conserva la precision de importes que exceden el rango seguro de JavaScript', () => {
    expect(parseAmount('9007199254740993.99', 'USD')).toBe(900719925474099399n);
  });

  it('rechaza importes que requieren redondeo', () => {
    expect(() => parseAmount('1234.567', 'USD')).toThrow(ValidationError);
    expect(() => parseAmount('0.0000001', 'USDT')).toThrow(ValidationError);
  });

  it('rechaza cero y negativos', () => {
    expect(() => parseAmount('0', 'USD')).toThrow(ValidationError);
    expect(() => parseAmount('0.00', 'USD')).toThrow(ValidationError);
    expect(() => parseAmount('-5', 'USD')).toThrow(ValidationError);
    expect(() => parseAmount('-0.01', 'USD')).toThrow(ValidationError);
  });

  it('rechaza formatos invalidos', () => {
    for (const invalid of ['', '   ', 'abc', '1e3', '1,000.00', '1.2.3', '$5', 'NaN', 'Infinity', '.5']) {
      expect(() => parseAmount(invalid, 'USD')).toThrow(ValidationError);
    }
  });
});

describe('formatAmount', () => {
  it('formatea unidades menores con los decimales de la moneda', () => {
    expect(formatAmount(123456n, 'USD')).toBe('1234.56');
    expect(formatAmount(1n, 'USD')).toBe('0.01');
    expect(formatAmount(0n, 'USD')).toBe('0.00');
    expect(formatAmount(1n, 'USDT')).toBe('0.000001');
    expect(formatAmount(1234567890n, 'USDT')).toBe('1234.567890');
  });

  it('es el inverso exacto de parseAmount', () => {
    for (const amount of ['1.00', '0.01', '1234.56', '9007199254740993.99']) {
      expect(formatAmount(parseAmount(amount, 'USD'), 'USD')).toBe(amount);
    }
  });
});

describe('parseDate', () => {
  it('acepta fechas de calendario validas y las normaliza', () => {
    expect(parseDate('2026-01-05')).toBe('2026-01-05');
    expect(parseDate('2026-02-28')).toBe('2026-02-28');
    expect(parseDate('2024-02-29')).toBe('2024-02-29');
    expect(parseDate(' 2026-12-31 ')).toBe('2026-12-31');
  });

  it('rechaza fechas que no existen o no siguen el formato', () => {
    for (const invalid of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '2026-1-5', '2026/01/05', '20260105', 'ayer', '']) {
      expect(() => parseDate(invalid)).toThrow(ValidationError);
    }
  });
});
