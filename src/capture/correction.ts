import { Currency } from '../domain/money';
import { TelegramButtonRows } from '../telegram/telegram-buttons';

/**
 * Correccion de un gasto ya confirmado, **por botones**.
 *
 * Solo hay una ruta visible: el boton `Corregir este gasto` del aviso de gasto
 * registrado. A partir de ahi, el usuario responde con el valor y el boton decide.
 * Ninguna correccion se aplica por texto.
 */

/** Lo que el usuario responde al boton: el importe y su moneda. */
export interface CorrectionValue {
  /** Importe en decimal exacto, sin signo. */
  amount: string;
  /** Moneda del importe. `null` si el mensaje no la nombra (un decimal suelto). */
  currency: Currency | null;
}

/** El resultado de leer un valor escrito por el usuario. */
export type CorrectionValueResult =
  | { kind: 'value'; value: CorrectionValue }
  | { kind: 'invalid'; problem: string };

/** Lo que significa un boton pulsado. */
export type CorrectionAction =
  | { type: 'start' }
  | { type: 'amount' }
  | { type: 'account'; index: number }
  | { type: 'apply' }
  | { type: 'cancel' };

/**
 * Los metadatos de un evento de captura: que se puede hacer con el y desde donde.
 *
 * Van **con el evento** y se guardan con su respuesta, en la misma transaccion: el
 * menu de una fase se puede reproducir tal cual estaba, sin reconstruirlo con los
 * datos de ahora.
 */
export interface CorrectionMetadata {
  /** Fase del prompt. */
  kind: 'offer' | 'amount' | 'accounts' | 'review';
  /**
   * Clave del origen de la correccion (`sourceKeyFor` del evento que la ofrecio).
   * Una pulsacion solo vale si su prompt trae la misma clave.
   */
  origin: string;
  /** Cuentas ordenadas de la fase de cuentas. */
  accounts?: { id: string; label: string }[];
  /** El antes y el despues de la revision. */
  review?: { before: string; after: string };
}

/** La accion de un boton de correccion, o `null` si el boton no es de este flujo. */
export function correctionActionOf(data: string): CorrectionAction | null {
  switch (data) {
    case 'corr:iniciar':
      return { type: 'start' };
    case 'corr:importe':
      return { type: 'amount' };
    case 'corr:aplicar':
      return { type: 'apply' };
    case 'corr:cancelar':
      return { type: 'cancel' };
    default: {
      const match = /^corr:cuenta:(\d{1,3})$/.exec(data);
      if (!match) {
        return null;
      }
      const index = Number(match[1]);
      return Number.isSafeInteger(index) && index >= 0 ? { type: 'account', index } : null;
    }
  }
}

/** Los botones de un prompt de correccion. */
export function correctionButtons(metadata: CorrectionMetadata | null): TelegramButtonRows {
  if (metadata === null) {
    return [];
  }
  switch (metadata.kind) {
    case 'offer':
      return [[{ text: 'Corregir este gasto', data: 'corr:iniciar' }]];
    case 'amount':
      return [[{ text: 'Cancelar', data: 'corr:cancelar' }]];
    case 'accounts':
      return [
        ...(metadata.accounts ?? []).map((account, index) => [
          { text: account.label, data: `corr:cuenta:${index}` },
        ]),
        [{ text: 'Cancelar', data: 'corr:cancelar' }],
      ];
    case 'review':
      return [
        [
          { text: 'Aplicar correccion', data: 'corr:aplicar' },
          { text: 'Cancelar', data: 'corr:cancelar' },
        ],
        [{ text: 'Cambiar importe', data: 'corr:importe' }],
      ];
  }
}

/** Una moneda escrita con nombre. */
const CURRENCY_WORDS: Array<[RegExp, Currency]> = [
  [/^usdt(?!\w)/i, 'USDT'],
  [/^usd(?!\w)/i, 'USD'],
  [/^ves(?!\w)/i, 'VES'],
  [/^bs\.?(?!\w)/i, 'VES'],
  [/^bol[ií]var(?:es)?(?!\w)/i, 'VES'],
  [/^d[oó]lar(?:es)?(?!\w)/i, 'USD'],
];

/**
 * Lee el valor que el usuario responde tras el boton.
 *
 * Es **estricto**: el mensaje entero tiene que ser el valor ("2 USDT", "2$ por USDT",
 * "$2 por USDT"). No se aceptan negativos, importes agrupados, dos simbolos, monedas
 * en conflicto, varios importes ni colas: lo que no se entiende no se inventa.
 *
 * Un decimal sin moneda ("2") se devuelve con la moneda en `null`: el backend la
 * conserva del gasto original. Un "$" suelto es ambiguo y se rechaza.
 */
export function parseCorrectionValue(text: string): CorrectionValueResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { kind: 'invalid', problem: 'falta el importe' };
  }
  if (trimmed.startsWith('-') || trimmed.startsWith('\u2212')) {
    return { kind: 'invalid', problem: 'el importe no puede ser negativo' };
  }
  let rest = trimmed;
  let symbols = 0;
  if (rest.startsWith('$')) {
    symbols += 1;
    rest = rest.slice(1).trim();
  }
  const amount = /^(\d+)(?:([.,])(\d+))?/.exec(rest);
  if (!amount) {
    return { kind: 'invalid', problem: 'falta el importe' };
  }
  const whole = amount[1] ?? '';
  const separator = amount[2];
  const fraction = amount[3];
  if (separator !== undefined && fraction !== undefined && fraction.length === 3) {
    // "1.500" puede ser 1500 o 1,5: no se adivina.
    return { kind: 'invalid', problem: 'el importe parece agrupado: escribe el importe sin separador de miles' };
  }
  const decimal = separator === undefined ? whole : `${whole}.${fraction ?? ''}`;
  rest = rest.slice(amount[0].length).trim();
  if (rest.startsWith('$')) {
    symbols += 1;
    rest = rest.slice(1).trim();
  } else if (rest.startsWith('\u20ac')) {
    return { kind: 'invalid', problem: 'el euro no esta soportado' };
  }
  if (symbols > 1) {
    return { kind: 'invalid', problem: 'el importe lleva dos simbolos' };
  }

  let currency: Currency | null = null;
  let rest2 = rest;
  const named = CURRENCY_WORDS.find(([pattern]) => pattern.test(rest2));
  if (named) {
    currency = named[1];
    rest2 = rest2.replace(named[0], '').trim();
  }
  // El medio: "por USDT".
  let medium: Currency | null = null;
  const por = /^por\s+/i.exec(rest2);
  if (por) {
    const after = rest2.slice(por[0].length);
    const mediumNamed = CURRENCY_WORDS.find(([pattern]) => pattern.test(after));
    if (!mediumNamed) {
      return { kind: 'invalid', problem: 'el medio de pago no es una moneda soportada' };
    }
    medium = mediumNamed[1];
    rest2 = after.replace(mediumNamed[0], '').trim();
  }
  if (currency !== null && medium !== null && currency !== medium) {
    return { kind: 'invalid', problem: 'el importe y el medio son de monedas distintas' };
  }
  if (rest2.length > 0) {
    // Una cola que no se reconoce (una fecha, otra palabra, otro importe).
    return { kind: 'invalid', problem: 'no se entiende el resto del mensaje' };
  }
  if (currency === null && medium === null && symbols === 0) {
    // Un decimal suelto: la moneda la conserva el original.
    return { kind: 'value', value: { amount: decimal, currency: null } };
  }
  const resolved = medium ?? currency;
  if (resolved === null) {
    // Solo hay "$": no se sabe la moneda.
    return { kind: 'invalid', problem: 'falta la moneda: escribe el codigo (por ejemplo, USDT)' };
  }
  return { kind: 'value', value: { amount: decimal, currency: resolved } };
}
