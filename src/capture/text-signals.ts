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
  /\bdebo\b|\bme\s+debes?\b|\bme\s+deben\b|\badeudo\b|\badeud(?:[eo]|é)(?!\w)|\badeudado\b|\bdeudas?\b|\bpr[eé]stamos?\b|\bme\s+presta\w*|\bme\s+prest[oó]|\bme\s\preste\w*/i;

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
 * La parte de la forma que nombra la cuenta: "desde la cuenta Efectivo USD".
 */
const ACCOUNT_TAIL =
  '(?:\\s+(?:desde|en|de)\\s+(?:la\\s+)?(?:cuenta\\s+)?(?<account>[^.,;!?]+))?';

/**
 * Las **formas completas** de un pago total ya realizado. Son las unicas que autorizan
 * un pago del pendiente entero y el mensaje tiene que ser **una sola** de ellas: sin
 * negacion, sin duda, sin otra frase y sin otra persona.
 *
 * Cada forma nombra como mucho dos cosas: la persona ("a Carmen") y la cuenta ("desde
 * la cuenta Efectivo USD"). Lo que no entre en la forma deja el mensaje **sin
 * autorizacion**: "no le pagué todo", "voy a pagar todo", "pagué todo excepto cinco" y
 * "ya le pagué todo a Carmen. No, solo cinco" no son una forma completa.
 */
const COMPLETE_PAYMENT_FORMS: RegExp[] = [
  // "ya le pagué todo a Carmen"
  new RegExp(
    `^(?:ya\\s+)?le\\s+pagu[eé]\\s+(?:todo|toda)\\s+a\\s+(?<party>[^.,;!?]+?)${ACCOUNT_TAIL}$`,
    'i',
  ),
  // "ya le pagué todo"
  new RegExp(`^(?:ya\\s+)?le\\s+pagu[eé]\\s+(?:todo|toda)${ACCOUNT_TAIL}$`, 'i'),
  // "ya pagué todo a Carmen"
  new RegExp(
    `^(?:ya\\s+)?pagu[eé]\\s+(?:todo|toda)\\s+a\\s+(?<party>[^.,;!?]+?)${ACCOUNT_TAIL}$`,
    'i',
  ),
  // "ya pagué todo"
  new RegExp(`^(?:ya\\s+)?pagu[eé]\\s+(?:todo|toda)${ACCOUNT_TAIL}$`, 'i'),
  // "lo pagué completo"
  new RegExp(
    `^(?:ya\\s+)?lo\\s+pagu[eé]\\s+(?:completo|completa|todo|toda)${ACCOUNT_TAIL}$`,
    'i',
  ),
  // "la pagué completa"
  new RegExp(`^(?:ya\\s+)?la\\s+pagu[eé]\\s+(?:completa|toda)${ACCOUNT_TAIL}$`, 'i'),
  // "Carmen me pagó todo"
  new RegExp(`^(?<party>[^.,;!?]+?)\\s+me\\s+pag[oó]\\s+(?:todo|toda)${ACCOUNT_TAIL}$`, 'i'),
  // "ya saldé la deuda con Carmen"
  new RegExp(
    `^(?:ya\\s+)?(?:sald[eé]|liquid[eé]|cerr[eé])\\s+la\\s+deuda\\s+con\\s+(?<party>[^.,;!?]+?)${ACCOUNT_TAIL}$`,
    'i',
  ),
  // "ya liquidé la deuda"
  new RegExp(
    `^(?:ya\\s+)?(?:sald[eé]|liquid[eé]|cerr[eé])\\s+la\\s+deuda${ACCOUNT_TAIL}$`,
    'i',
  ),
  // "ya liquidé toda la deuda con Carmen"
  new RegExp(
    `^(?:ya\\s+)?(?:sald[eé]|liquid[eé])\\s+(?:todo|toda)\\s+la\\s+deuda(?:\\s+con\\s+(?<party>[^.,;!?]+?))?${ACCOUNT_TAIL}$`,
    'i',
  ),
  // "ya está pagada"
  new RegExp(
    `^(?:ya\\s+)?est[aá]\\s+(?:pagad[oa]|saldad[oa]|liquidad[oa])${ACCOUNT_TAIL}$`,
    'i',
  ),
];

/**
 * La estructura de un pago completo en cualquier parte del mensaje ("no le pagué todo",
 * "le pagué a todos", "voy a pagar todo"): el mensaje habla de un pago completo aunque
 * el mensaje entero no sea una forma afirmativa completa.
 *
 * El cierre del verbo es `(?!\w)` y no `\b`: en JavaScript las letras con tilde no son
 * caracteres de palabra y el limite de palabra nunca cae despues de "pagué".
 */
const COMPLETE_PAYMENT_STRUCTURE =
  /\b(?:pagu[eé]|pag[oó]|pagada|pagado|pagar|pagando|sald[eé]|saldada|saldado|liquid[eé]|liquidada|liquidado|cerr[eé]|cerrada|cerrado)(?!\w)[^.!?;]{0,40}\b(?:todo|toda|todos|todas|completo|completa|deuda)\b/i;

/**
 * Intencion de pago completo: `yes` (el mensaje entero es una forma afirmativa
 * completa), `no` (el mensaje habla de un pago completo pero no lo afirma: lo niega, lo
 * duda, lo aplaza o se contradice) o `none` (no habla de pagar todo).
 */
export type FullPaymentIntent = 'yes' | 'no' | 'none';

/**
 * Lo que nombra una forma completa de pago: la persona y la cuenta. Lo que no nombra se
 * deja en `null`: una forma sin persona no obliga a que el mensaje nombre a alguien.
 */
export interface CompletePaymentForm {
  /** Persona nombrada por la forma ("a Carmen"): `null` si la forma no la nombra. */
  party: string | null;
  /** Cuenta nombrada por la forma ("desde la cuenta Efectivo USD"): `null` si no la nombra. */
  account: string | null;
}

/**
 * El mensaje se compara sin la puntuacion final: "ya le pagué todo a Carmen." es la
 * misma frase que "ya le pagué todo a Carmen". El interrogante **no** se quita: una
 * pregunta no autoriza un pago.
 */
function normalizeMessage(text: string): string {
  return text.trim().replace(/[.,;:!]+$/, '').trim();
}

/**
 * La forma completa de pago total que describe **todo** el mensaje, o `null` si el
 * mensaje no es una sola forma afirmativa completa.
 *
 * Es la base de la autorizacion de un pago del pendiente entero: la decide el texto
 * entero del usuario, no una frase suelta dentro de el. La persona que nombra la forma
 * la valida despues el backend contra la contraparte de la deuda resuelta.
 */
export function completePaymentForm(text: string): CompletePaymentForm | null {
  const normalized = normalizeMessage(text);
  if (normalized.length === 0) {
    return null;
  }
  for (const form of COMPLETE_PAYMENT_FORMS) {
    const match = form.exec(normalized);
    if (!match) {
      continue;
    }
    const groups = match.groups ?? {};
    return {
      party: cleanGroup(groups.party),
      account: cleanGroup(groups.account),
    };
  }
  return null;
}

/**
 * Lee la intencion de pago completo del mensaje.
 *
 * `yes` solo si el **mensaje entero** es una forma afirmativa completa ("ya le pagué
 * todo a Carmen"). `no` si el mensaje habla de un pago completo pero no lo afirma
 * ("no le pagué todo", "le pagué a todos", "voy a pagar todo", "pagué todo, pero me
 * falta pagar cinco") y `none` si no habla de pagar todo.
 */
export function fullPaymentIntent(text: string): FullPaymentIntent {
  if (text.trim().length === 0) {
    return 'none';
  }
  if (completePaymentForm(text) !== null) {
    return 'yes';
  }
  return COMPLETE_PAYMENT_STRUCTURE.test(text) ? 'no' : 'none';
}

/**
 * El nombre de la cuenta que nombra el mensaje **con la formula** ("en la cuenta
 * Efectivo USD" -> "Efectivo USD"). `null` si el mensaje no nombra una cuenta asi: el
 * nombre a secas ("Efectivo USD") lo resuelve el backend contra las cuentas conocidas.
 */
export function accountPhrase(text: string): string | null {
  const match = /^(?:(?:desde|en|de)\s+)(?:la\s+)?(?:cuenta\s+)?(?<name>[^,;!?]+)$/.exec(
    text.trim(),
  );
  return cleanGroup(match?.groups?.name);
}

/**
 * Los numeros que escribe el usuario ("5 dolares", "$10"): los importes que el modelo
 * propone tienen que aparecer aqui para ser los importes del pago.
 */
export function amountsInText(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)?/g) ?? []).map((value) => value.replace(',', '.'));
}

/** Un grupo de una forma que esta vacio no nombra nada. */
function cleanGroup(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
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
