import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import { formatAmount } from '../domain/money';
import type { DebtView } from '../debts/debt.service';
import { AccountOption } from '../interpreter/interpreter';
import { DebtChoice, directionLabel } from './debt-draft';
import { Draft, DraftProblem } from './draft';

/** Longitud maxima de la etiqueta de una opcion de la lista de deudas. */
const MAX_CHOICE_LABEL_LENGTH = 140;

export const EMPTY_MESSAGE_REPLY = 'El mensaje esta vacio: no hay nada que registrar.';
export const NOTHING_TO_CONFIRM_REPLY = 'No hay ninguna operacion pendiente por confirmar.';
export const NOT_READY_REPLY =
  'La operacion pendiente no tiene un resumen vigente: envia el mensaje de nuevo para ver el resumen y despues confirma con /confirm.';
export const NOTHING_TO_CANCEL_REPLY = 'No hay ninguna operacion pendiente por cancelar.';
export const CANCELLED_REPLY = 'Operacion descartada. No se registro nada.';
export const CONVERSION_REPLY =
  'Las conversiones entre cuentas o monedas no se registran: no son un gasto ni un ingreso. Envia la compra o el ingreso por separado.';
export const MULTIPLE_OPERATIONS_REPLY =
  'Ese mensaje describe mas de una operacion. Envia una sola operacion por mensaje (importe, moneda y cuenta).';
export const UNSUPPORTED_REPLY =
  'Ese mensaje no parece un gasto ni un ingreso que se pueda registrar.';
export const UNCLEAR_REPLY =
  'No pude identificar una sola operacion en ese mensaje.';
export const NOT_CONFIGURED_REPLY =
  'La captura no esta configurada: falta OPENROUTER_API_KEY u OPENROUTER_MODEL. Configuralo y vuelve a enviar el mensaje.';
export const BUDGET_EXHAUSTED_REPLY =
  'Se alcanzo el limite diario de inferencia configurado. No se llamo al proveedor y no se registro nada.';
export const TOO_LONG_REPLY =
  'El mensaje es demasiado largo para interpretarlo. Envia uno mas corto.';
export const RETRY_REPLY = 'No pude interpretar el mensaje y no lo reintento automaticamente.';

/**
 * Una pregunta **contextual** ("¿y cuánto le debía inicialmente?") sin ventana de chat:
 * no hay a quien se refiere. Se pide la persona de forma explicita, sin listar todas
 * las deudas. No se registra nada y el borrador vivo no se toca.
 *
 * La peticion es **neutral**: se puede volver con la persona o con la consulta
 * completa del grupo.
 */
export const FOLLOW_UP_NO_CONTEXT_REPLY = [
  'No tengo el contexto de esa pregunta.',
  'Escribe la persona de la que habla (por ejemplo: "¿cuánto le debo a Luis?") o pide el grupo completo (por ejemplo: "muéstrame mis deudas por pagar").',
  'No se registro nada.',
].join('\n');

/**
 * La pregunta se entiende pero no se sabe de quien es (o hay varias personas
 * posibles). Se pide la persona, sin listar todas las deudas.
 *
 * La peticion es **neutral**: se puede volver con la persona o con la consulta
 * completa del grupo.
 */
export const FOLLOW_UP_CLARIFY_REPLY = [
  'No se sabe de quien es esa pregunta.',
  'Escribe la persona (por ejemplo: "¿cuánto le debo a Luis?") o pide el grupo completo (por ejemplo: "muéstrame mis deudas por pagar").',
  'No se registro nada.',
].join('\n');

/**
 * La consulta de seguimiento no se pudo resolver (el proveedor fallo, rechazo la
 * ventana o la respuesta no cumplio el contrato). Se pide repetir la pregunta: no se
 * reintenta solo y **no se cancela el borrador vivo**.
 */
export const FOLLOW_UP_REFORMULATE_REPLY = [
  'No pude resolver esa pregunta con el contexto del chat.',
  'Repitela con la persona (por ejemplo: "¿cuánto le debo a Luis?") o con el grupo completo (por ejemplo: "muéstrame mis deudas por pagar").',
  'No se registro nada.',
].join('\n');

/**
 * El borrador vivo se cancela cuando la interpretacion falla: un `/confirm` no puede
 * confirmar un borrador anterior a una correccion que no se pudo interpretar. El
 * usuario tiene que volver a enviar la operacion **completa**.
 */
export const RESEND_REPLY =
  'Vuelve a enviar el mensaje completo (importe, moneda y cuenta) para preparar la operacion de nuevo.';

/**
 * Salvaguarda determinista: el mensaje habla de una deuda pero el modelo lo clasifico
 * como gasto o ingreso. No se registra nada: se pregunta que quiso decir.
 */
export const DEBT_CLARIFY_REPLY = [
  'Ese mensaje parece hablar de una deuda (lo que debes o lo que te deben), no de un gasto ni de un ingreso.',
  'Dime cual es:',
  '  - una deuda nueva: "le debo 8$ a Carmen" o "Carmen me debe 8$"',
  '  - un pago de una deuda que ya existe: "le pagué 3 dólares a Carmen" o "ya le pagué todo"',
  '  - una consulta: "cuáles son mis deudas"',
  'No se registro nada.',
].join('\n');

/** El borrador de deuda guardado no se pudo leer: se pide de nuevo, sin mostrar nada. */
export const BROKEN_DEBT_DRAFT_REPLY =
  'No se pudo leer el borrador pendiente de deuda. Vuelve a enviar el mensaje completo (importe, moneda, contraparte y cuenta si es un pago). No se registro nada.';

/**
 * Los datos que faltan y las cuentas que hay. El orden de los problemas es el del
 * backend: primero lo que el modelo no dio, despues la cuenta.
 */
export function detailsReply(
  problems: DraftProblem[],
  accounts: AccountOption[],
  title = 'Faltan datos para registrar la operacion:',
  detail?: string,
): string {
  const lines = problems.map((problem) => `  - ${problem.message}`);
  if (problems.some((problem) => problem.field === 'account') && accounts.length > 0) {
    lines.push(`  cuentas: ${accounts.map((account) => `${account.name} (${account.currency})`).join(', ')}`);
  }
  const body = [title, ...lines];
  if (detail !== undefined) {
    body.push(detail);
  }
  body.push('', 'Escribe los datos que faltan.');
  return body.join('\n');
}

/**
 * Respuesta a un mensaje que el modelo no pudo interpretar como una sola operacion.
 * Es util aunque el borrador conserve datos completos: el resumen vigente se vuelve a
 * pedir antes de poder confirmar.
 */
export function unclearReply(problems: DraftProblem[], accounts: AccountOption[]): string {
  const lines = [UNCLEAR_REPLY];
  if (problems.length > 0) {
    lines.push('Ademas sigue faltando:');
    lines.push(...problems.map((problem) => `  - ${problem.message}`));
    if (problems.some((problem) => problem.field === 'account') && accounts.length > 0) {
      lines.push(
        `  cuentas: ${accounts.map((account) => `${account.name} (${account.currency})`).join(', ')}`,
      );
    }
  }
  lines.push('Envia una sola operacion por mensaje (importe, moneda y cuenta).');
  return lines.join('\n');
}

/** El resumen que el usuario ve antes de confirmar. */
export function confirmationReply(draft: Draft, accounts: AccountOption[]): string {
  const account = accounts.find((candidate) => candidate.id === draft.accountId);
  return [
    'Entendi esta operacion:',
    `  - tipo: ${draft.kind === 'income' ? 'ingreso' : 'gasto'}`,
    `  - importe: ${draft.amount} ${draft.currency}`,
    `  - cuenta: ${account ? `${account.name} (${account.currency})` : '(sin cuenta)'}`,
    `  - fecha: ${draft.occurredOn}`,
    `  - descripcion: ${draft.description ?? '(sin descripcion)'}`,
    '',
    'Responde /confirm para registrarla o /cancel para descartarla.',
  ].join('\n');
}

/** Resumen de una deuda nueva: no hay cuenta porque todavia no se movio dinero. */
export function debtCreateReply(draft: Draft): string {
  const debt = draft.debt;
  return [
    'Entendi esta deuda:',
    `  - tipo: ${directionLabel(debt?.direction ?? null)}`,
    `  - contraparte: ${debt?.counterparty ?? '(sin dato)'}`,
    `  - importe: ${draft.amount} ${draft.currency}`,
    `  - fecha: ${draft.occurredOn}`,
    `  - descripcion: ${draft.description ?? '(sin descripcion)'}`,
    '',
    'Crear la deuda no mueve dinero: no hay cuenta ni movimiento.',
    'Responde /confirm para registrarla o /cancel para descartarla.',
  ].join('\n');
}

/** Resumen de un pago de deuda: muestra el pendiente congelado del momento. */
export function debtSettleReply(draft: Draft, debt: DebtView, account: AccountOption | undefined): string {
  const payload = draft.debt;
  const currency = debt.debt.currency;
  const outstanding = formatAmount(debt.outstandingMinor, currency);
  const original = formatAmount(debt.debt.principalMinor, currency);
  return [
    'Entendi este pago de deuda:',
    `  - deuda: ${debt.debt.counterparty} | ${directionLabel(payload?.direction ?? null)} | ${currency}`,
    `  - original: ${original} ${currency} | pendiente: ${outstanding} ${currency} | fecha de la deuda: ${debt.debt.occurredOn}`,
    `  - modo: ${payload?.settlementMode === 'full' ? 'pago total' : 'pago parcial'}`,
    `  - importe: ${payload?.amount} ${payload?.currency}`,
    `  - cuenta: ${account ? `${account.name} (${account.currency})` : '(sin cuenta)'}`,
    `  - fecha: ${payload?.occurredOn}`,
    `  - descripcion: ${payload?.description ?? '(sin descripcion)'}`,
    '',
    'Responde /confirm para registrarlo o /cancel para descartarlo.',
  ].join('\n');
}

/** Confirmacion de una operacion ordinaria. */
export function registeredReply(draft: Draft, account: AccountOption | undefined): string {
  const where = account ? ` en la cuenta ${account.name}` : '';
  return `Registrado: ${draft.kind === 'income' ? 'ingreso' : 'gasto'} de ${draft.amount} ${draft.currency}${where} (${draft.occurredOn}).`;
}

/** Confirmacion de una deuda nueva: no hay movimiento, solo la obligacion. */
export function debtCreatedReply(draft: Draft): string {
  const debt = draft.debt;
  return `Registrado: deuda de ${debt?.amount} ${debt?.currency} con ${debt?.counterparty} (${directionLabel(debt?.direction ?? null)}).`;
}

/** Confirmacion de un pago de deuda: la persona, el importe y el pendiente. */
export function debtSettledReply(draft: Draft): string {
  const debt = draft.debt;
  return `Registrado: pago de ${debt?.amount} ${debt?.currency} de la deuda con ${debt?.counterparty} (${directionLabel(debt?.direction ?? null)}).`;
}

/** Etiqueta de una deuda: fecha, pendiente, direccion, persona y descripcion. */
export function debtChoiceLabel(row: DebtView): string {
  const currency = row.debt.currency;
  const parts = [
    row.debt.occurredOn,
    `pendiente ${formatAmount(row.outstandingMinor, currency)} ${currency}`,
    directionLabel(row.debt.direction),
    row.debt.counterparty,
  ];
  const description = row.debt.description;
  if (description !== null && description.length > 0) {
    parts.push(description);
  }
  return parts.join(' | ').slice(0, MAX_CHOICE_LABEL_LENGTH);
}

/** La lista de deudas que ve el usuario: numerada y sin identificadores. */
export function choicePrompt(choices: DebtChoice[], more = false): string {
  return [
    'Elige la deuda (responde solo con el numero de la opcion):',
    ...choices.map((choice, index) => `  ${index + 1}. ${choice.label}`),
    ...(more ? ['Hay mas deudas con esa persona: di el importe o la fecha para saber cual es.'] : []),
  ].join('\n');
}

/**
 * Mensaje del problema de la cuenta: falta la cuenta, o la que nombra el usuario no
 * existe o hay varias con ese nombre. Un nombre que no vale no se reemplaza por la
 * cuenta que propone el modelo: se pregunta.
 */
export function accountProblem(candidate: string, explicit: string | null, ambiguous: boolean): string {
  if (ambiguous) {
    return `falta la cuenta: hay varias cuentas con el nombre "${candidate}"`;
  }
  if (explicit !== null) {
    return `falta la cuenta: la cuenta "${explicit}" no existe`;
  }
  return 'falta la cuenta';
}

/**
 * Mensaje seguro para el usuario. Solo los errores de dominio del backend (reglas de
 * negocio) se muestran tal cual; cualquier otro fallo se resume sin detalle.
 */
export function safeErrorMessage(error: unknown): string {
  if (
    error instanceof ValidationError ||
    error instanceof ConflictError ||
    error instanceof NotFoundError
  ) {
    return error.message;
  }
  return 'ocurrio un error inesperado y no se registro nada.';
}
