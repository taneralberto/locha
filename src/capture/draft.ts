import { parseDate } from '../domain/date';
import { CURRENCY_CODES, Currency, isCurrency, parseAmount } from '../domain/money';
import { AccountOption, PendingOperation } from '../interpreter/interpreter';
import { Capture, CaptureKind, CaptureState } from './capture.entity';
import { DebtDraft, FULL_AUTHORIZATION_VERSION, parseDebtDraft } from './debt-draft';

/** Longitud maxima del importe guardado: un importe mas largo no es un importe. */
const MAX_AMOUNT_LENGTH = 40;
/** Longitud maxima de la descripcion de una operacion (limite de `Movement`). */
const MAX_DESCRIPTION_LENGTH = 280;
/** Longitud maxima de la contraparte de una deuda (limite de `Debt`). */
const MAX_COUNTERPARTY_LENGTH = 120;

/**
 * Borrador en memoria: los campos que el backend valida antes de pedir confirmacion.
 *
 * Es el contrato **interno** de la captura: no es el `DebtDraft` que se persiste (ese
 * lo define `debt-draft.ts`) ni el `PendingOperation` que ve el modelo (ese lo define
 * el interprete). Los tres se parecen, pero cada uno tiene su propio contrato.
 */
export interface Draft {
  kind: CaptureKind | null;
  amount: string | null;
  /** Moneda tal como la entendio el modelo: puede no estar soportada. */
  currency: string | null;
  accountId: string | null;
  occurredOn: string | null;
  description: string | null;
  /** Datos de deuda: `null` en los borradores que no son de deuda. */
  debt: DebtDraft | null;
}

/** Lo que falta en un borrador para poder confirmarlo. */
export interface DraftProblem {
  field:
    | 'kind'
    | 'amount'
    | 'currency'
    | 'account'
    | 'date'
    | 'direction'
    | 'counterparty'
    | 'debtId'
    | 'mode';
  message: string;
}

/** El estado que deja un borrador preparado: falta algo o esta listo para confirmar. */
export type DraftState = 'awaiting_details' | 'awaiting_confirmation';

/**
 * Borrador preparado: su contenido, el estado que deja y la respuesta al usuario.
 * Quien lo prepara **no lo guarda**: solo lo describe.
 */
export interface DraftResult {
  draft: Draft;
  state: DraftState;
  reply: string;
}

/** El borrador vivo de una conversacion: su contenido y el estado que tiene. */
export interface PendingDraft {
  draft: Draft;
  state: CaptureState;
}

/** Borrador vacio: todavia no se sabe que operacion es. */
export function emptyDraft(): Draft {
  return {
    kind: null,
    amount: null,
    currency: null,
    accountId: null,
    occurredOn: null,
    description: null,
    debt: null,
  };
}

/**
 * Lee el borrador guardado. Para un borrador de deuda manda el JSON validado: si el
 * JSON esta roto, el borrador se considera ilegible y no se adivina nada.
 */
export function draftOf(capture: Capture): Draft {
  const isDebt = capture.kind === 'debt_create' || capture.kind === 'debt_settle';
  const debt = isDebt ? parseDebtDraft(capture.debtPayload) : null;
  if (debt !== null) {
    return {
      kind: capture.kind,
      amount: debt.amount,
      currency: debt.currency,
      accountId: debt.accountId,
      occurredOn: debt.occurredOn,
      description: debt.description,
      debt,
    };
  }
  return {
    kind: isDebt ? null : capture.kind,
    amount: capture.amount,
    currency: capture.currency,
    accountId: capture.accountId,
    occurredOn: capture.occurredOn,
    description: capture.description,
    debt: null,
  };
}

/** El borrador vivo, como contexto para el modelo. */
export function toPendingOperation(capture: Capture): PendingOperation {
  const draft = draftOf(capture);
  const pending: PendingOperation = {
    kind: draft.kind === 'income' || draft.kind === 'expense' ? draft.kind : null,
    amount: draft.amount,
    currency: draft.currency,
    accountId: draft.accountId,
    occurredOn: draft.occurredOn,
    description: draft.description,
    sourceText: capture.sourceText ?? '',
  };
  if (draft.debt !== null) {
    pending.debt = {
      kind: draft.debt.kind,
      direction: draft.debt.direction,
      counterparty: draft.debt.counterparty,
      debtId: draft.debt.debtId,
      settlementMode: draft.debt.settlementMode,
      amount: draft.debt.amount,
      currency: draft.debt.currency,
      accountId: draft.debt.accountId,
      occurredOn: draft.debt.occurredOn,
      description: draft.debt.description,
    };
  }
  return pending;
}

/**
 * La fecha por defecto (la del mensaje en la zona del usuario) se aplica **solo** cuando
 * el modelo no da fecha (`null`). Cualquier otro valor no nulo se conserva tal cual: una
 * fecha vacia, en blanco o que no existe en el calendario no se sustituye en silencio, se
 * pide una fecha valida y la operacion no se puede confirmar.
 */
export function resolveDate(value: string | null, defaultDate: string): string | null {
  if (value === null) {
    return defaultDate;
  }
  return value.trim();
}

/** `true` si la fecha existe en el calendario. */
export function isValidDate(value: string): boolean {
  try {
    parseDate(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * El importe se guarda como decimal corto. Un valor que no cabe no es un importe: se
 * descarta y se vuelve a pedir.
 */
export function normalizeAmount(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_AMOUNT_LENGTH) {
    return null;
  }
  return trimmed;
}

/** La contraparte se guarda como texto corto y con espacios colapsados. */
export function normalizeCounterparty(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    return null;
  }
  return normalized.slice(0, MAX_COUNTERPARTY_LENGTH);
}

/**
 * La descripcion se guarda en una sola linea: se colapsan los espacios y se recortan los
 * saltos de linea del modelo. Se conserva un maximo de caracteres porque la columna
 * del movimiento es corta.
 */
export function normalizeDescription(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    return null;
  }
  return normalized.slice(0, MAX_DESCRIPTION_LENGTH);
}

/**
 * Valida el borrador con las reglas del backend: cuenta existente y activa, moneda
 * soportada y coherente con la cuenta, importe exacto para la escala de la moneda.
 * Lo que falta se pide al usuario: no se inventa ningun dato.
 */
export function validateDraft(draft: Draft, accounts: AccountOption[]): DraftProblem[] {
  const problems: DraftProblem[] = [];
  const account = draft.accountId
    ? accounts.find((candidate) => candidate.id === draft.accountId)
    : undefined;

  if (draft.kind === null) {
    problems.push({ field: 'kind', message: 'falta indicar si es un gasto o un ingreso' });
  }
  problems.push(...amountProblems(draft));
  problems.push(...currencyProblems(draft, account));

  if (!account) {
    problems.push({ field: 'account', message: 'falta la cuenta' });
  }
  problems.push(...dateProblems(draft));

  return problems;
}

/** Importe: presente, positivo y con la escala exacta de la moneda. */
export function amountProblems(draft: Draft): DraftProblem[] {
  const problems: DraftProblem[] = [];
  if (draft.amount === null) {
    problems.push({ field: 'amount', message: 'falta el importe' });
  } else if (!isPositiveDecimal(draft.amount)) {
    problems.push({ field: 'amount', message: `el importe "${draft.amount}" no es valido` });
  } else if (draft.currency !== null && isCurrency(draft.currency)) {
    try {
      parseAmount(draft.amount, draft.currency);
    } catch (error) {
      problems.push({
        field: 'amount',
        message: error instanceof Error ? error.message : 'el importe no es valido',
      });
    }
  }
  return problems;
}

/** Moneda: presente, soportada y coherente con la cuenta elegida. */
export function currencyProblems(draft: Draft, account: AccountOption | undefined): DraftProblem[] {
  const problems: DraftProblem[] = [];
  if (draft.currency === null) {
    problems.push({ field: 'currency', message: `falta la moneda (${CURRENCY_CODES.join(', ')})` });
  } else if (!isCurrency(draft.currency)) {
    problems.push({
      field: 'currency',
      message: `la moneda "${draft.currency}" no esta soportada`,
    });
  } else if (account && account.currency !== draft.currency) {
    problems.push({
      field: 'currency',
      message: `la cuenta "${account.name}" opera en ${account.currency}, no en ${draft.currency}`,
    });
  }
  return problems;
}

/** Fecha: presente y existente en el calendario. */
export function dateProblems(draft: Draft): DraftProblem[] {
  if (draft.occurredOn === null || isValidDate(draft.occurredOn)) {
    return [];
  }
  return [
    {
      field: 'date',
      message:
        draft.occurredOn.length === 0
          ? 'falta la fecha (se espera YYYY-MM-DD)'
          : `la fecha "${draft.occurredOn}" no es valida (se espera YYYY-MM-DD)`,
    },
  ];
}

/** Deuda nueva: direccion, contraparte, importe, moneda y fecha. */
export function validateDebtCreate(draft: Draft): DraftProblem[] {
  const problems: DraftProblem[] = [];
  const debt = draft.debt;
  if (debt === null || debt.direction === null) {
    problems.push({ field: 'direction', message: 'falta indicar si la deuda es a pagar o a cobrar' });
  }
  if (debt === null || debt.counterparty === null) {
    problems.push({ field: 'counterparty', message: 'falta la contraparte' });
  }
  problems.push(...amountProblems(draft));
  problems.push(...currencyProblems(draft, undefined));
  problems.push(...dateProblems(draft));
  return problems;
}

/** Pago de deuda: cuenta activa, importe, moneda y fecha. */
export function validateDebtDraft(draft: Draft, accounts: AccountOption[]): DraftProblem[] {
  const debt = draft.debt;
  if (debt === null) {
    return [{ field: 'kind', message: 'falta el borrador de la deuda' }];
  }
  if (debt.kind === 'debt_create') {
    return validateDebtCreate(draft);
  }
  const problems: DraftProblem[] = [];
  if (debt.debtId === null) {
    problems.push({ field: 'debtId', message: 'falta la deuda que se quiere pagar' });
  }
  if (debt.settlementMode === 'full' && !hasFullAuthorization(debt)) {
    // Un pago total solo es valido si el mensaje entero del usuario lo autorizo. Los
    // borradores escritos antes de existir la autorizacion no la tienen: se piden de
    // nuevo, aunque su `fullIntent` diga que si.
    problems.push({
      field: 'mode',
      message:
        'el pago total no tiene la autorizacion del usuario: pide de nuevo el pago para que confirme que pago todo',
    });
  }
  if (debt.amount === null) {
    problems.push({ field: 'amount', message: 'falta el importe del pago' });
  }
  const account = debt.accountId
    ? accounts.find((candidate) => candidate.id === debt.accountId)
    : undefined;
  if (!account) {
    problems.push({ field: 'account', message: 'falta la cuenta' });
  }
  problems.push(...currencyProblems(draft, account));
  problems.push(...dateProblems(draft));
  return problems;
}

function isPositiveDecimal(value: string): boolean {
  const match = /^\d+(?:\.\d+)?$/.exec(value.trim());
  if (!match) {
    return false;
  }
  const [whole = '0', fraction = '0'] = match[0].split('.');
  return BigInt(whole) > 0n || BigInt(fraction) > 0n;
}

/** Importe en unidades menores, o `null` si no es un importe valido para la moneda. */
export function tryParseAmount(value: string, currency: Currency): bigint | null {
  try {
    return parseAmount(value, currency);
  } catch {
    return null;
  }
}

/**
 * `true` cuando el borrador tiene una autorizacion de pago total vigente: la que da el
 * mensaje entero del usuario. Un borrador escrito antes de existir esa autorizacion
 * (`fullIntent` en `true` pero sin version) no la tiene.
 */
export function hasFullAuthorization(debt: DebtDraft): boolean {
  return debt.fullIntent === true && debt.fullAuthorizationVersion === FULL_AUTHORIZATION_VERSION;
}

/**
 * Un pago total sin autorizacion vigente (un borrador viejo, o una autorizacion que el
 * mensaje nuevo ha dejado sin efecto) no puede seguir guardado como un pago total: se
 * borran el modo, el importe derivado y la autorizacion.
 */
export function withoutFullAuthorization(draft: Draft): Draft {
  const debt = draft.debt;
  if (debt === null || (debt.settlementMode !== 'full' && !debt.fullIntent)) {
    return draft;
  }
  const cleared: DebtDraft = {
    ...debt,
    settlementMode: null,
    amount: null,
    fullIntent: false,
    fullAuthorizationVersion: null,
  };
  return { ...draft, amount: cleared.amount, debt: cleared };
}
