/**
 * Senales del texto que se aplican sin depender del modelo. Son conservadoras: ante la
 * duda se pregunta al usuario en vez de registrar algo que este mal.
 */

/** Palabras que nombran una moneda o una unidad monetaria. */
const MONEY_WORD = /(?:usd|usdt|ves|bol[ií]var(?:es)?|d[oó]lar(?:es)?|\bbs\b)/i;

/**
 * Verbos y sustantivos de mover dinero.
 *
 * - `cambi`, `convert` e `intercambi` con una moneda cerca ("cambié 50 USDT").
 * - `transfer` y `traslad` en forma verbal ("transferí 50 USD"): la forma sustantiva
 *   "transferencia" queda aparte porque tambien es un medio de pago.
 * - `mov` exige ademas un origen y un destino ("moví 50 USD de Efectivo a Banco"): un
 *   "movimiento" suelto no es una transferencia.
 * - `transferencia` como sustantivo solo cuenta si el mensaje dice a donde va el dinero
 *   ("transferencia de 100 USD a la cuenta Banco"); "pague por transferencia" es un medio
 *   de pago de un gasto normal y no se rechaza.
 */
const TRANSFER_VERBS: Array<{ pattern: RegExp; needsDestination: boolean }> = [
  { pattern: /(?:cambi|convert|intercambi)\w*/i, needsDestination: false },
  { pattern: /(?:transfer(?!encia|ido)|traslad)\w*/i, needsDestination: false },
  { pattern: /mov\w*/i, needsDestination: true },
  { pattern: /transferencias?\b/i, needsDestination: true },
];

/** "de USD a VES", "de dolares a bolívares". */
const CURRENCY_PAIR = new RegExp(
  `${MONEY_WORD.source}[^.]{0,20}?\\ba\\s+(?:usd|usdt|ves|bol[ií]var(?:es)?|d[oó]lar(?:es)?)\\b`,
  'i',
);

/** "pasé 50 USD a VES". */
const PASSED_TO_CURRENCY = new RegExp(
  `\\bpas(?:e|é|ó|ar)\\b[^.]{0,40}?\\ba\\s+(?:usd|usdt|ves|bol[ií]var(?:es)?|d[oó]lar(?:es)?)\\b`,
  'i',
);

/** "de la cuenta Efectivo a la cuenta Banco". */
const ACCOUNT_MOVEMENT = /\bde\s+(?:la\s+)?cuenta\s+[^,.;]{1,30}?\s+a\s+(?:la\s+)?cuenta\b/i;

/** "de Efectivo a Banco": hay un origen y un destino. */
const FROM_TO = /\bde\s+[^,.;]{1,30}?\s+a\s+[^,.;]{1,30}/i;

/** Destino explicito: "a la cuenta Banco". */
const DESTINATION_ACCOUNT = /\ba\s+(?:la\s+)?cuenta\s+[^,.;]{1,30}/i;

/** Importe con moneda escrita: "2 dolares", "3500 Bs", "10 USD". */
const AMOUNT_WITH_CODE =
  /\d+(?:[.,]\d+)?\s*(?:usd|usdt|ves|bol[ií]var(?:es)?|d[oó]lar(?:es)?|\bbs\.?)/gi;

/** Importe con simbolo: "$10", "€10". */
const AMOUNT_WITH_SYMBOL = /(?:us\$|\$|€)\s*\d+(?:[.,]\d+)?/gi;

/**
 * `true` cuando el mensaje describe un cambio o conversion de dinero. No depende del
 * modelo: una conversione nunca es un movimiento.
 */
export function mentionsConversion(text: string): boolean {
  if (text.trim().length === 0) {
    return false;
  }
  if (
    CURRENCY_PAIR.test(text) ||
    PASSED_TO_CURRENCY.test(text) ||
    ACCOUNT_MOVEMENT.test(text)
  ) {
    return true;
  }
  for (const { pattern, needsDestination } of TRANSFER_VERBS) {
    for (const match of text.matchAll(new RegExp(pattern.source, 'gi'))) {
      const start = Math.max(0, (match.index ?? 0) - 40);
      const end = Math.min(text.length, (match.index ?? 0) + match[0].length + 60);
      const window = text.slice(start, end);
      const hasMoney = MONEY_WORD.test(window);
      const hasDestination =
        FROM_TO.test(window) || DESTINATION_ACCOUNT.test(window);
      if (hasDestination || (hasMoney && !needsDestination)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * `true` cuando el mensaje menciona mas de un importe, lo que sugiere mas de una
 * operacion. En ese caso se pide al usuario que envie una sola operacion por mensaje.
 */
export function mentionsMultipleAmounts(text: string): boolean {
  const written = text.match(AMOUNT_WITH_CODE) ?? [];
  const symbolic = text.match(AMOUNT_WITH_SYMBOL) ?? [];
  return written.length + symbolic.length > 1;
}
