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
 * `true` cuando el mensaje describe una obligacion entre personas y no un gasto ni un
 * ingreso ordinario. Es una salvaguarda: si el modelo clasifica como gasto o ingreso
 * un mensaje que habla de deudas, no se registra nada y se pregunta.
 *
 * Solo se aceptan palabras inequivocas: "debo", "me debe", "adeudo", "deuda" y
 * "préstamo". Un gasto normal con un comercio no se confunde con una deuda.
 */
const DEBT_WORDING =
  /\bdebo\b|\bme\s+debes?\b|\bme\s+deben\b|\badeudo\b|\badeud(?:[eo]|é)(?!\w)|\badeudado\b|\bdeudas?\b|\bpr[eé]stamos?\b|\bme\s+presta\w*|\bme\s+prest[oó]|\bme\s+preste\w*/i;

/**
 * `true` cuando el mensaje menciona una deuda de forma explicita. No depende del
 * modelo: ante la duda se pregunta al usuario en vez de registrar un gasto o un ingreso
 * que en realidad es una obligacion.
 */
export function mentionsDebt(text: string): boolean {
  if (text.trim().length === 0) {
    return false;
  }
  return DEBT_WORDING.test(text);
}

/**
 * Formas **afirmativas** de un pago completo. El objeto del verbo tiene que ser "todo"
 * ("le pagué todo", "Carmen me pagó todo", "lo pagué completo"): "le pagué a todos" no
 * es un pago completo, es un pago a varias personas.
 */
const COMPLETE_PAYMENT_OBJECT =
  /\b(?:pagu[eé]|pag[oó]|pagar|pagando|pagada|pagado)(?!\w)\s+(?:lo\s+|la\s+|los\s+|las\s+)?(?:todo|toda|todos|todas|completo|completa)\b/gi;

/** "ya saldé la deuda", "liquidé la deuda", "cerré la deuda". */
const COMPLETE_PAYMENT_DEBT =
  /\b(?:sald[eé]|saldada|saldado|liquid[eé]|liquidada|liquidado|cerr[eé]|cerrada|cerrado)(?!\w)[^.!?]{0,20}\b(?:deuda|obligaci[oó]n|todo|toda|todos|todas)\b/gi;

/** "ya está pagada", "ya está saldada". */
const COMPLETE_PAYMENT_STATE = /\bya\s+est[aá]\s+(?:pagad[oa]|saldad[oa])\b/gi;

/**
 * Palabras que niegan o dudan de un pago completo. Son conservadoras: ante la duda se
 * pregunta al usuario en vez de pagar el pendiente entero.
 */
const NEGATED_PAYMENT =
  /\b(?:no|nunca|jam[aá]s|todav[ií]a|a[uú]n|casi|falta|faltan|pendiente|pendientes|excepto|menos|deber[ií]a|deb[ií]o|quiz[aá]s|tal\s+vez|creo\s+que|puede\s+que|se\s+ve)\b/i;

/** Distancia maxima hacia atras para buscar la negacion de la frase. */
const NEGATION_WINDOW = 30;

/**
 * Intencion de pago completo: `yes` (el usuario lo dice de forma afirmativa), `no` (lo
 * niega o duda) o `none` (no habla de pagar todo).
 */
export type FullPaymentIntent = 'yes' | 'no' | 'none';

/**
 * Lee la intencion de pago completo del mensaje.
 *
 * Solo cuenta una forma afirmativa y **sin negacion**: "ya le pagué todo a Carmen" es
 * `yes`; "no le pagué todo a Carmen", "todavía no le pagué todo" o "casi le pagué
 * todo" son `no`; "le pagué a todos" no habla de un pago completo (`none`).
 */
export function fullPaymentIntent(text: string): FullPaymentIntent {
  if (text.trim().length === 0) {
    return 'none';
  }
  let negated = false;
  for (const pattern of [COMPLETE_PAYMENT_OBJECT, COMPLETE_PAYMENT_DEBT, COMPLETE_PAYMENT_STATE]) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const window = text.slice(Math.max(0, start - NEGATION_WINDOW), start);
      // La negacion solo cuenta en la misma frase: "no pagué el almuerzo. Le pagué todo".
      const clause = window.split(/[.!?;\n]/).pop() ?? '';
      if (NEGATED_PAYMENT.test(clause)) {
        negated = true;
        continue;
      }
      return 'yes';
    }
  }
  return negated ? 'no' : 'none';
}

/**
 * `true` cuando el mensaje dice de forma afirmativa que se paga todo. No depende del
 * modelo: sin esta frase no se paga el pendiente completo.
 */
export function mentionsFullPayment(text: string): boolean {
  return fullPaymentIntent(text) === 'yes';
}

/**
 * `true` cuando el mensaje describe mas de un importe, lo que sugiere mas de una
 * operacion. En ese caso se pide al usuario que envie una sola operacion por mensaje.
 */
export function mentionsMultipleAmounts(text: string): boolean {
  const written = text.match(AMOUNT_WITH_CODE) ?? [];
  const symbolic = text.match(AMOUNT_WITH_SYMBOL) ?? [];
  return written.length + symbolic.length > 1;
}
