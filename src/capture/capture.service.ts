import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { Account } from '../accounts/account.entity';
import { isUniqueViolation } from '../data/unique-violation';
import { TransactionRunner } from '../data/transaction.runner';
import { dateInTimeZone, parseDate } from '../domain/date';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import { CURRENCY_CODES, Currency, formatAmount, isCurrency, parseAmount } from '../domain/money';
import { DebtDirection } from '../debts/debt.entity';
import { formatDebtReport } from '../debts/debt-format';
import { canonicalCounterparty, DebtService, DebtView } from '../debts/debt.service';
import { FinancialService } from '../financial/financial.service';
import { MovementKind } from '../financial/movement.entity';
import {
  AccountOption,
  DebtCandidate,
  InterpreterError,
  MAX_DEBT_CANDIDATES,
  OperationInterpreter,
  PendingOperation,
} from '../interpreter/interpreter';
import { Operation } from '../interpreter/operation.schema';
import { Capture, CaptureKind, CaptureState } from './capture.entity';
import { sourceKeyFor } from './source-key';
import { CaptureEvent } from './capture-event.entity';
import { DebtDraft, directionLabel, parseDebtDraft, serializeDebtDraft } from './debt-draft';
import { BudgetExhaustedError, DEFAULT_TIME_ZONE, InferenceBudgetService } from './inference-budget.service';
import { mentionsConversion, mentionsDebt, fullPaymentIntent, mentionsMultipleAmounts } from './text-signals';

/** Longitud maxima del texto original que se guarda mientras el borrador esta vivo. */
const MAX_SOURCE_TEXT_LENGTH = 1000;
/** Longitud maxima de la descripcion de una operacion (limite de `Movement`). */
const MAX_DESCRIPTION_LENGTH = 280;
/** Longitud maxima del importe guardado: un importe mas largo no es un importe. */
const MAX_AMOUNT_LENGTH = 40;
/** Longitud maxima de la contraparte de una deuda (limite de `Debt`). */
const MAX_COUNTERPARTY_LENGTH = 120;

const EMPTY_MESSAGE_REPLY = 'El mensaje esta vacio: no hay nada que registrar.';
const NOTHING_TO_CONFIRM_REPLY = 'No hay ninguna operacion pendiente por confirmar.';
const NOT_READY_REPLY =
  'La operacion pendiente no tiene un resumen vigente: envia el mensaje de nuevo para ver el resumen y despues confirma con /confirm.';
const NOTHING_TO_CANCEL_REPLY = 'No hay ninguna operacion pendiente por cancelar.';
const CANCELLED_REPLY = 'Operacion descartada. No se registro nada.';
const CONVERSION_REPLY =
  'Las conversiones entre cuentas o monedas no se registran: no son un gasto ni un ingreso. Envia la compra o el ingreso por separado.';
const MULTIPLE_OPERATIONS_REPLY =
  'Ese mensaje describe mas de una operacion. Envia una sola operacion por mensaje (importe, moneda y cuenta).';
const UNSUPPORTED_REPLY =
  'Ese mensaje no parece un gasto ni un ingreso que se pueda registrar.';
const UNCLEAR_REPLY =
  'No pude identificar una sola operacion en ese mensaje.';
const NOT_CONFIGURED_REPLY =
  'La captura no esta configurada: falta OPENROUTER_API_KEY u OPENROUTER_MODEL. Configuralo y vuelve a enviar el mensaje.';
const BUDGET_EXHAUSTED_REPLY =
  'Se alcanzo el limite diario de inferencia configurado. No se llamo al proveedor y no se registro nada.';
const TOO_LONG_REPLY =
  'El mensaje es demasiado largo para interpretarlo. Envia uno mas corto.';
const RETRY_REPLY = 'No pude interpretar el mensaje y no lo reintento automaticamente.';
/**
 * El borrador vivo se cancela cuando la interpretacion falla: un `/confirm` no puede
 * confirmar un borrador anterior a una correccion que no se pudo interpretar. El
 * usuario tiene que volver a enviar la operacion **completa**.
 */
const RESEND_REPLY =
  'Vuelve a enviar el mensaje completo (importe, moneda y cuenta) para preparar la operacion de nuevo.';

/**
 * Salvaguarda determinista: el mensaje habla de una deuda pero el modelo lo clasifico
 * como gasto o ingreso. No se registra nada: se pregunta que quiso decir.
 */
const DEBT_CLARIFY_REPLY = [
  'Ese mensaje parece hablar de una deuda (lo que debes o lo que te deben), no de un gasto ni de un ingreso.',
  'Dime cual es:',
  '  - una deuda nueva: "le debo 8$ a Carmen" o "Carmen me debe 8$"',
  '  - un pago de una deuda que ya existe: "le pagué 3 dólares a Carmen" o "ya le pagué todo"',
  '  - una consulta: "cuáles son mis deudas"',
  'No se registro nada.',
].join('\n');

/** El borrador de deuda guardado no se pudo leer: se pide de nuevo, sin mostrar nada. */
const BROKEN_DEBT_DRAFT_REPLY =
  'No se pudo leer el borrador pendiente de deuda. Vuelve a enviar el mensaje completo (importe, moneda, contraparte y cuenta si es un pago). No se registro nada.';

/**
 * Cola de la captura. El `handle` completo se serializa por conexion: asi no se
 * solapan dos inferencias ni dos escrituras sobre el mismo borrador.
 */
const queues = new WeakMap<DataSource, Promise<unknown>>();

export interface CaptureRequest {
  /** Identificador del evento en el transporte. Lo entrega la fuente autorizada. */
  eventId: string;
  /** Conversacion (chat o canal) del evento. */
  chatId: string;
  text: string;
  /** Marca de tiempo del mensaje. */
  receivedAt: string;
}

export interface CaptureOutcome {
  eventId: string;
  chatId: string;
  /** Estado del borrador de la conversacion despues de atender el evento. */
  captureState: CaptureState | null;
  /** Respuesta al usuario. Es durable: un evento repetido reproduce la misma. */
  reply: string;
  /** `true` si el evento ya estaba procesado y se devuelve la respuesta guardada. */
  replayed: boolean;
  /** Movimiento registrado por este evento, si hubo. */
  movementId: string | null;
}

interface NormalizedRequest {
  eventId: string;
  chatId: string;
  text: string;
  receivedAt: Date;
}

/** Borrador en memoria: los campos que el backend valida antes de pedir confirmacion. */
interface Draft {
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

interface DraftProblem {
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

/** Resultado de buscar la deuda que el usuario quiere pagar. */
type TargetResolution =
  | { kind: 'resolved'; debt: DebtView }
  | { kind: 'ask'; problems: DraftProblem[]; detail?: string };

@Injectable()
export class CaptureService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly transactions: TransactionRunner,
    private readonly financial: FinancialService,
    private readonly interpreter: OperationInterpreter,
    private readonly budget: InferenceBudgetService,
    private readonly debts: DebtService,
  ) {}

  /**
   * Atiende un evento del transporte y devuelve la respuesta al usuario.
   *
   * El evento es idempotente: repetirlo reproduce la respuesta guardada sin volver a
   * interpretar ni volver a gastar. Nada se registra en la base hasta que el usuario
   * confirma explicitamente con `/confirm`.
   */
  async handle(request: CaptureRequest): Promise<CaptureOutcome> {
    const input = normalizeRequest(request);
    const previous = queues.get(this.dataSource) ?? Promise.resolve();
    const result = previous.then(() => this.process(input));
    queues.set(
      this.dataSource,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  private async process(input: NormalizedRequest): Promise<CaptureOutcome> {
    const existing = await this.findEvent(input.eventId, input.chatId);
    if (existing) {
      if (existing.state === 'processing') {
        // La inferencia quedo interrumpida: no se vuelve a llamar al proveedor.
        return this.markUncertain(existing, input, RETRY_REPLY);
      }
      return replay(existing);
    }

    let event: CaptureEvent;
    try {
      event = await this.createEvent(input);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // Otra escritura registro el mismo evento: se reproduce su respuesta guardada.
      const winner = await this.findEvent(input.eventId, input.chatId);
      if (!winner) {
        throw error;
      }
      return winner.state === 'processing'
        ? this.markUncertain(winner, input, RETRY_REPLY)
        : replay(winner);
    }

    const command = detectCommand(input.text);
    if (command === 'confirm') {
      return this.confirm(event, input);
    }
    if (command === 'cancel') {
      return this.cancel(event, input);
    }
    if (input.text.trim().length === 0) {
      return this.complete(event, input, null, EMPTY_MESSAGE_REPLY);
    }
    if (!this.interpreter.enabled) {
      return this.markUncertain(event, input, NOT_CONFIGURED_REPLY);
    }

    const pending = await this.findPendingCapture(input.chatId);
    const accounts = await this.activeAccounts();
    const defaultDate = dateInTimeZone(input.receivedAt, DEFAULT_TIME_ZONE);
    const candidates = await this.debtCandidates();

    let operation: Operation;
    try {
      await this.budget.reserve();
      operation = await this.interpreter.interpret({
        text: input.text,
        accounts,
        defaultDate,
        pending: pending ? toPendingOperation(pending) : null,
        debts: candidates.debts,
        debtsTruncated: candidates.truncated,
      });
    } catch (error) {
      if (error instanceof BudgetExhaustedError) {
        return this.markUncertain(event, input, BUDGET_EXHAUSTED_REPLY);
      }
      if (error instanceof InterpreterError && error.reason === 'too_long') {
        return this.markUncertain(event, input, TOO_LONG_REPLY);
      }
      return this.markUncertain(event, input, RETRY_REPLY);
    }

    // Una consulta de deudas es de solo lectura: va antes de cualquier conversion,
    // operacion multiple o descarte, y no toca el borrador pendiente.
    if (operation.kind === 'debt_query') {
      return this.debtQueryReply(event, input, pending, operation);
    }

    if (operation.kind === 'transfer' || mentionsConversion(input.text)) {
      return this.discard(event, input, pending, CONVERSION_REPLY);
    }
    if (mentionsMultipleAmounts(input.text)) {
      return this.discard(event, input, pending, MULTIPLE_OPERATIONS_REPLY);
    }
    if (operation.kind === 'unsupported') {
      return this.discard(event, input, pending, UNSUPPORTED_REPLY);
    }
    if (operation.kind === 'unclear') {
      const draft = pending ? draftOf(pending) : emptyDraft();
      const isDebt = draft.kind === 'debt_create' || draft.kind === 'debt_settle';
      const problems = isDebt ? validateDebtDraft(draft, accounts) : validateDraft(draft, accounts);
      return this.saveDraft(
        event,
        input,
        pending,
        draft,
        'awaiting_details',
        unclearReply(problems, accounts),
      );
    }
    if (operation.kind === 'debt_create') {
      return this.debtCreateDraft(event, input, pending, operation, accounts, defaultDate);
    }
    if (operation.kind === 'debt_settle') {
      return this.debtSettleDraft(event, input, pending, operation, accounts, defaultDate);
    }

    // Salvaguarda: el mensaje habla de una deuda y el modelo lo clasifico como gasto o
    // ingreso. No se registra nada: se pregunta que quiso decir.
    if (mentionsDebt(input.text)) {
      return this.saveDraft(
        event,
        input,
        pending,
        emptyDraft(),
        'awaiting_details',
        DEBT_CLARIFY_REPLY,
      );
    }

    const draft: Draft = {
      kind: operation.kind,
      amount: normalizeAmount(operation.amount),
      currency: operation.currency === null ? null : operation.currency.trim(),
      accountId: operation.accountId === null ? null : operation.accountId.trim(),
      occurredOn: resolveDate(operation.occurredOn, defaultDate),
      description: normalizeDescription(operation.description),
      debt: null,
    };
    const problems = validateDraft(draft, accounts);
    if (problems.length > 0) {
      return this.saveDraft(event, input, pending, draft, 'awaiting_details', detailsReply(problems, accounts));
    }
    return this.saveDraft(
      event,
      input,
      pending,
      draft,
      'awaiting_confirmation',
      confirmationReply(draft, accounts),
    );
  }

  /**
   * Prepara el borrador de una deuda nueva. Crear una deuda **no** mueve dinero: no
   * hay cuenta, no hay movimiento y no hay saldo.
   */
  private async debtCreateDraft(
    event: CaptureEvent,
    input: NormalizedRequest,
    pending: Capture | null,
    operation: Operation,
    accounts: AccountOption[],
    defaultDate: string,
  ): Promise<CaptureOutcome> {
    const model = operation.debt;
    const debt: DebtDraft = {
      version: 1,
      kind: 'debt_create',
      direction: model?.direction ?? null,
      counterparty: normalizeCounterparty(model?.counterparty ?? null),
      debtId: null,
      settlementMode: null,
      amount: normalizeAmount(operation.amount),
      currency: operation.currency === null ? null : operation.currency.trim(),
      accountId: null,
      occurredOn: resolveDate(operation.occurredOn, defaultDate),
      description: normalizeDescription(operation.description),
      expectedOutstandingMinor: null,
      fullIntent: false,
    };
    const draft: Draft = {
      kind: 'debt_create',
      amount: debt.amount,
      currency: debt.currency,
      accountId: null,
      occurredOn: debt.occurredOn,
      description: debt.description,
      debt,
    };
    const problems = validateDebtCreate(draft);
    if (problems.length > 0) {
      return this.saveDraft(
        event,
        input,
        pending,
        draft,
        'awaiting_details',
        detailsReply(problems, accounts, 'Faltan datos para registrar la deuda:'),
      );
    }
    return this.saveDraft(
      event,
      input,
      pending,
      draft,
      'awaiting_confirmation',
      debtCreateReply(draft),
    );
  }

  /**
   * Prepara el borrador de un pago de deuda. El pendiente se **congela** al preparar el
   * pago: si despues cambia (otro pago o una anulacion), el `/confirm` se rechaza y hay
   * que volver a preparar el pago.
   */
  private async debtSettleDraft(
    event: CaptureEvent,
    input: NormalizedRequest,
    pending: Capture | null,
    operation: Operation,
    accounts: AccountOption[],
    defaultDate: string,
  ): Promise<CaptureOutcome> {
    const model = operation.debt;
    const direction = model?.direction ?? null;
    const counterparty = normalizeCounterparty(model?.counterparty ?? null);
    const rawCurrency = operation.currency === null ? null : operation.currency.trim();
    const modelAmount = normalizeAmount(operation.amount);
    const accountId = operation.accountId === null ? null : operation.accountId.trim();
    const pendingDraft = pending === null ? null : draftOf(pending);
    const pendingDebtId = pendingDraft?.debt?.debtId ?? null;

    const resolution = await this.resolveDebtTarget({
      direction,
      counterparty,
      currency: rawCurrency,
      userText: input.text,
      pendingDebtId,
    });

    // El pago total lo autoriza el **texto del usuario**, no el modelo. Se conserva la
    // autorizacion del borrador solo si el objetivo sigue siendo el mismo: cambiar de
    // deuda o de persona la borra. Una frase que niega el pago completo la revoca.
    const intent = fullPaymentIntent(input.text);
    const sameTarget =
      resolution.kind === 'resolved' &&
      pendingDebtId !== null &&
      resolution.debt.debt.id === pendingDebtId;
    const pendingFull = pendingDraft?.debt?.fullIntent === true && sameTarget;
    const groundedFull = intent === 'yes' || (intent === 'none' && pendingFull);

    const debt: DebtDraft = {
      version: 1,
      kind: 'debt_settle',
      direction,
      counterparty,
      debtId: resolution.kind === 'resolved' ? resolution.debt.debt.id : null,
      settlementMode: null,
      amount: modelAmount,
      currency: rawCurrency,
      accountId,
      occurredOn: resolveDate(operation.occurredOn, defaultDate),
      description: normalizeDescription(operation.description),
      expectedOutstandingMinor: null,
      fullIntent: resolution.kind === 'resolved' ? groundedFull : intent === 'yes',
    };
    const draft: Draft = {
      kind: 'debt_settle',
      amount: debt.amount,
      currency: debt.currency,
      accountId,
      occurredOn: debt.occurredOn,
      description: debt.description,
      debt,
    };

    if (resolution.kind === 'ask') {
      return this.saveDraft(
        event,
        input,
        pending,
        draft,
        'awaiting_details',
        detailsReply(resolution.problems, accounts, 'Faltan datos para registrar el pago:', resolution.detail),
      );
    }

    const target = resolution.debt;
    const debtCurrency = target.debt.currency;
    const problems: DraftProblem[] = [];

    // La moneda del pago es la de la deuda: si el mensaje no la dice, se usa la de la
    // deuda que el usuario acaba de señalar.
    const paymentCurrency: Currency =
      rawCurrency !== null && isCurrency(rawCurrency) ? rawCurrency : debtCurrency;
    if (rawCurrency !== null && !isCurrency(rawCurrency)) {
      problems.push({ field: 'currency', message: `la moneda "${rawCurrency}" no esta soportada` });
    } else if (rawCurrency !== null && rawCurrency !== debtCurrency) {
      problems.push({
        field: 'currency',
        message: `la deuda esta en ${debtCurrency} y el pago es en ${rawCurrency}`,
      });
    }
    debt.currency = rawCurrency ?? debtCurrency;
    draft.currency = debt.currency;

    // Modo e importe. El `settlementMode` del modelo es una lectura, no una
    // autorizacion: sin importe y sin que el usuario diga que paga todo, se pregunta.
    // Un importe explicito es un pago parcial; si coincide con el pendiente, salda la
    // deuda igual.
    const outstanding = formatAmount(target.outstandingMinor, debtCurrency);
    let mode: 'full' | 'partial' | null = null;
    let paymentAmount: string | null = modelAmount;
    if (modelAmount === null) {
      if (groundedFull) {
        mode = 'full';
        paymentAmount = outstanding;
      } else {
        problems.push({
          field: 'amount',
          message:
            'falta el importe del pago: di cuanto pagaste o di explicitamente que pagaste todo (por ejemplo, "ya le pagué todo")',
        });
      }
    } else {
      const minor = tryParseAmount(modelAmount, paymentCurrency);
      if (minor === null) {
        problems.push({ field: 'amount', message: `el importe "${modelAmount}" no es valido` });
        mode = 'partial';
      } else if (minor > target.outstandingMinor) {
        problems.push({
          field: 'amount',
          message: `el importe "${modelAmount}" supera el pendiente de la deuda (${outstanding})`,
        });
        mode = 'partial';
      } else if (groundedFull && minor !== target.outstandingMinor) {
        problems.push({
          field: 'amount',
          message: `dijiste que se pago todo, pero el importe "${modelAmount}" no coincide con el pendiente de la deuda (${outstanding})`,
        });
        mode = 'partial';
      } else if (groundedFull) {
        mode = 'full';
        paymentAmount = outstanding;
      } else {
        mode = 'partial';
      }
    }

    const account = accountId ? accounts.find((candidate) => candidate.id === accountId) : undefined;
    if (!account) {
      problems.push({ field: 'account', message: 'falta la cuenta' });
    } else if (account.currency !== paymentCurrency) {
      problems.push({
        field: 'currency',
        message: `la cuenta "${account.name}" opera en ${account.currency}, no en ${paymentCurrency}`,
      });
    }
    problems.push(...dateProblems(draft));
    if (draft.occurredOn !== null && isValidDate(draft.occurredOn) && draft.occurredOn < target.debt.occurredOn) {
      problems.push({
        field: 'date',
        message: `el pago no puede ser anterior a la fecha de la deuda (${target.debt.occurredOn})`,
      });
    }

    debt.direction = target.debt.direction;
    debt.counterparty = target.debt.counterparty;
    debt.debtId = target.debt.id;
    debt.settlementMode = mode;
    debt.amount = paymentAmount;
    debt.expectedOutstandingMinor = target.outstandingMinor.toString();
    debt.fullIntent = groundedFull;
    draft.amount = debt.amount;

    if (problems.length > 0) {
      return this.saveDraft(
        event,
        input,
        pending,
        draft,
        'awaiting_details',
        detailsReply(problems, accounts, 'Faltan datos para registrar el pago:'),
      );
    }
    return this.saveDraft(
      event,
      input,
      pending,
      draft,
      'awaiting_confirmation',
      debtSettleReply(draft, target, account),
    );
  }

  /**
   * Busca la deuda que el usuario quiere pagar.
   *
   * El id cuenta solo si el usuario **lo escribió en este mensaje**: manda sobre el
   * borrador vivo. Sin id escrito ahora, el del borrador vivo es una pista (tiene que
   * seguir siendo compatible) y, si no lo es, se busca por contraparte, direccion y
   * moneda exactas. Un id propuesto por el modelo nunca resuelve nada.
   */
  private async resolveDebtTarget(input: {
    direction: DebtDirection | null;
    counterparty: string | null;
    currency: string | null;
    userText: string;
    pendingDebtId: string | null;
  }): Promise<TargetResolution> {
    const written = idsInText(input.userText);
    if (written.length > 1) {
      // Varias deudas escritas en este mensaje: la ambiguedad se conserva, no se elige.
      return {
        kind: 'ask',
        problems: [{ field: 'debtId', message: 'el mensaje menciona varias deudas; indica cual es' }],
        detail: `  deudas mencionadas: ${written.join(', ')}`,
      };
    }
    if (written.length === 1) {
      return this.resolveWrittenDebt(written[0]!, input);
    }

    // Sin id escrito ahora: el del borrador vivo sirve solo si sigue encajando.
    if (input.pendingDebtId !== null) {
      const view = await this.debts.get(input.pendingDebtId).catch(() => null);
      if (view !== null && view.status !== 'paid' && !contradicts(view, input)) {
        return { kind: 'resolved', debt: view };
      }
    }

    const problems: DraftProblem[] = [];
    if (input.direction === null) {
      problems.push({ field: 'direction', message: 'falta indicar si la deuda es a pagar o a cobrar' });
    }
    if (input.counterparty === null) {
      problems.push({ field: 'counterparty', message: 'falta la contraparte' });
    }
    if (input.currency === null) {
      problems.push({ field: 'currency', message: `falta la moneda (${CURRENCY_CODES.join(', ')})` });
    } else if (!isCurrency(input.currency)) {
      problems.push({ field: 'currency', message: `la moneda "${input.currency}" no esta soportada` });
    }
    if (problems.length > 0) {
      return { kind: 'ask', problems };
    }

    const rows = await this.debts.list({
      direction: input.direction as DebtDirection,
      currency: input.currency as Currency,
      counterparty: input.counterparty as string,
    });
    const candidates = rows.filter((row) => row.status !== 'paid');
    if (candidates.length === 0) {
      return {
        kind: 'ask',
        problems: [
          {
            field: 'counterparty',
            message: `no hay ninguna deuda pendiente con "${input.counterparty}" en ${input.currency}`,
          },
        ],
      };
    }
    if (candidates.length > 1) {
      return {
        kind: 'ask',
        problems: [
          { field: 'debtId', message: 'hay varias deudas con esa contraparte; indica el id de la que quieres pagar' },
        ],
        detail: candidates
          .map(
            (row) =>
              `  ${row.debt.id} | ${row.debt.counterparty} | ${row.debt.currency} | pendiente ${formatAmount(row.outstandingMinor, row.debt.currency)} | ${row.status}`,
          )
          .join('\n'),
      };
    }
    return { kind: 'resolved', debt: candidates[0]! };
  }

  /**
   * Deuda que el usuario escribio en este mensaje. El id es del usuario, pero tiene que
   * encajar con lo que el mismo mensaje pide (contraparte, direccion y moneda): si no,
   * se pregunta y no se muta nada.
   */
  private async resolveWrittenDebt(
    id: string,
    input: { direction: DebtDirection | null; counterparty: string | null; currency: string | null },
  ): Promise<TargetResolution> {
    const view = await this.debts.get(id).catch(() => null);
    if (!view) {
      return {
        kind: 'ask',
        problems: [{ field: 'debtId', message: `no existe ninguna deuda con el id "${id}"` }],
      };
    }
    if (view.status === 'paid') {
      return {
        kind: 'ask',
        problems: [{ field: 'debtId', message: `la deuda "${id}" ya esta pagada` }],
      };
    }
    if (contradicts(view, input)) {
      return {
        kind: 'ask',
        problems: [
          {
            field: 'debtId',
            message:
              'la deuda indicada no coincide con la contraparte, la direccion o la moneda del pago',
          },
        ],
      };
    }
    return { kind: 'resolved', debt: view };
  }

  /**
   * Responde a una consulta de deudas. Es de solo lectura: no toca el borrador
   * pendiente y no registra nada.
   */
  private async debtQueryReply(
    event: CaptureEvent,
    input: NormalizedRequest,
    pending: Capture | null,
    operation: Operation,
  ): Promise<CaptureOutcome> {
    const model = operation.debt;
    const direction = model?.direction ?? null;
    const counterparty = normalizeCounterparty(model?.counterparty ?? null);
    const status = model?.status ?? null;
    const currency = operation.currency === null ? null : operation.currency.trim();
    const rows = await this.debts.list();

    const written = idsInText(input.text);
    const selected = written.length > 0
      ? rows.filter((row) => written.includes(row.debt.id))
      : rows.filter(
          (row) =>
            (direction === null || row.debt.direction === direction) &&
            (counterparty === null ||
              canonicalCounterparty(row.debt.counterparty) === canonicalCounterparty(counterparty)) &&
            (currency === null || row.debt.currency === currency) &&
            (status === null ? row.status !== 'paid' : row.status === status),
        );

    const reply = formatDebtReport(
      selected.map((row) => ({
        id: row.debt.id,
        direction: row.debt.direction,
        counterparty: row.debt.counterparty,
        currency: row.debt.currency,
        principalMinor: row.debt.principalMinor,
        paidMinor: row.paidMinor,
        outstandingMinor: row.outstandingMinor,
        status: row.status,
      })),
      {
        title: 'Deudas:',
        empty:
          status === null
            ? 'No hay deudas pendientes que coincidan con la consulta.'
            : 'No hay deudas que coincidan con la consulta.',
      },
    );
    return this.complete(event, input, pending?.state ?? null, reply);
  }

  /** Confirma el borrador vivo y registra el movimiento. */
  private async confirm(event: CaptureEvent, input: NormalizedRequest): Promise<CaptureOutcome> {
    const pending = await this.findPendingCapture(input.chatId);
    if (!pending) {
      return this.complete(event, input, null, NOTHING_TO_CONFIRM_REPLY);
    }
    if (pending.state !== 'awaiting_confirmation') {
      // El borrador no tiene un resumen vigente: hay que volver a enviarlo para verlo.
      return this.complete(event, input, 'awaiting_details', NOT_READY_REPLY);
    }
    if (pending.kind === 'debt_create' || pending.kind === 'debt_settle') {
      return this.confirmDebt(event, input, pending);
    }
    const accounts = await this.activeAccounts();
    const draft = draftOf(pending);
    const defaultDate = dateInTimeZone(input.receivedAt, DEFAULT_TIME_ZONE);
    const problems = validateDraft(draft, accounts);
    if (problems.length > 0) {
      return this.saveDraft(
        event,
        input,
        pending,
        draft,
        'awaiting_details',
        detailsReply(problems, accounts),
      );
    }

    const account = accounts.find((candidate) => candidate.id === pending.accountId);
    try {
      const reply = await this.transactions.run(async (manager) => {
        const result = await this.financial.register(
          {
            sourceKey: pending.sourceKey,
            accountId: pending.accountId as string,
            kind: pending.kind as MovementKind,
            money: {
              currency: pending.currency as Currency,
              minor: parseAmount(pending.amount as string, pending.currency as Currency),
            },
            occurredOn: pending.occurredOn ?? defaultDate,
            description: pending.description ?? undefined,
          },
          manager,
        );
        await manager.getRepository(Capture).update(
          { id: pending.id },
          { state: 'registered', sourceText: null },
        );
        const message = registeredReply(draft, account);
        await manager.getRepository(CaptureEvent).update(
          { id: event.id },
          { state: 'completed', reply: message, captureState: 'registered', movementId: result.movement.id },
        );
        return { message, movementId: result.movement.id };
      });
      return {
        eventId: input.eventId,
        chatId: input.chatId,
        captureState: 'registered',
        reply: reply.message,
        replayed: false,
        movementId: reply.movementId,
      };
    } catch (error) {
      // La transaccion se revirtio: no hay movimiento. El borrador sigue vivo y se
      // vuelve a pedir lo que falte. Solo se muestran los errores de dominio conocidos;
      // cualquier otro fallo se informa de forma generica para no filtrar detalles
      // internos de la base de datos.
      const message = safeErrorMessage(error);
      return this.saveDraft(
        event,
        input,
        pending,
        draft,
        'awaiting_details',
        `No se pudo registrar la operacion: ${message}`,
      );
    }
  }

  /**
   * Confirma un borrador de deuda. La escritura del dominio y el cierre del borrador
   * ocurren en la **misma transaccion**: o se guardan los dos, o no se guarda ninguno.
   */
  private async confirmDebt(
    event: CaptureEvent,
    input: NormalizedRequest,
    pending: Capture,
  ): Promise<CaptureOutcome> {
    const accounts = await this.activeAccounts();
    const draft = draftOf(pending);
    const debt = draft.debt;
    if (debt === null) {
      // El borrador guardado no se pudo leer: no se adivina nada.
      return this.saveDraft(
        event,
        input,
        pending,
        emptyDraft(),
        'awaiting_details',
        BROKEN_DEBT_DRAFT_REPLY,
      );
    }
    const problems = validateDebtDraft(draft, accounts);
    if (problems.length > 0) {
      const title =
        draft.kind === 'debt_create'
          ? 'Faltan datos para registrar la deuda:'
          : 'Faltan datos para registrar el pago:';
      return this.saveDraft(
        event,
        input,
        pending,
        draft,
        'awaiting_details',
        detailsReply(problems, accounts, title),
      );
    }

    try {
      const result = await this.transactions.run(async (manager) => {
        if (draft.kind === 'debt_create') {
          const created = await this.debts.create(
            {
              sourceKey: pending.sourceKey,
              direction: debt.direction as DebtDirection,
              counterparty: debt.counterparty as string,
              money: {
                currency: debt.currency as Currency,
                minor: parseAmount(debt.amount as string, debt.currency as Currency),
              },
              occurredOn: debt.occurredOn as string,
              description: debt.description ?? undefined,
            },
            manager,
          );
          await manager.getRepository(Capture).update(
            { id: pending.id },
            { state: 'registered', sourceText: null, debtPayload: null },
          );
          const message = debtCreatedReply(draft, created.debt.id);
          await manager.getRepository(CaptureEvent).update(
            { id: event.id },
            { state: 'completed', reply: message, captureState: 'registered', movementId: null },
          );
          return { message, movementId: null };
        }
        const settled = await this.debts.settle(
          {
            sourceKey: pending.sourceKey,
            debtId: debt.debtId as string,
            accountId: debt.accountId as string,
            money: {
              currency: debt.currency as Currency,
              minor: parseAmount(debt.amount as string, debt.currency as Currency),
            },
            occurredOn: debt.occurredOn as string,
            expectedOutstandingMinor: BigInt(debt.expectedOutstandingMinor as string),
            description: debt.description ?? undefined,
          },
          manager,
        );
        await manager.getRepository(Capture).update(
          { id: pending.id },
          { state: 'registered', sourceText: null, debtPayload: null },
        );
        const message = debtSettledReply(draft, settled.payment.id, settled.movement.id);
        await manager.getRepository(CaptureEvent).update(
          { id: event.id },
          {
            state: 'completed',
            reply: message,
            captureState: 'registered',
            movementId: settled.movement.id,
          },
        );
        return { message, movementId: settled.movement.id };
      });
      return {
        eventId: input.eventId,
        chatId: input.chatId,
        captureState: 'registered',
        reply: result.message,
        replayed: false,
        movementId: result.movementId,
      };
    } catch (error) {
      const message = await this.debtErrorMessage(error, draft);
      return this.saveDraft(
        event,
        input,
        pending,
        draft,
        'awaiting_details',
        `No se pudo registrar la operacion: ${message}`,
      );
    }
  }

  /** Descarta el borrador vivo sin registrar nada. */
  private async cancel(event: CaptureEvent, input: NormalizedRequest): Promise<CaptureOutcome> {
    const pending = await this.findPendingCapture(input.chatId);
    if (!pending) {
      return this.complete(event, input, null, NOTHING_TO_CANCEL_REPLY);
    }
    await this.transactions.run(async (manager) => {
      await manager.getRepository(Capture).update(
        { id: pending.id },
        { state: 'cancelled', sourceText: null, debtPayload: null },
      );
      await manager.getRepository(CaptureEvent).update(
        { id: event.id },
        { state: 'completed', reply: CANCELLED_REPLY, captureState: 'cancelled', movementId: null },
      );
    });
    return {
      eventId: input.eventId,
      chatId: input.chatId,
      captureState: 'cancelled',
      reply: CANCELLED_REPLY,
      replayed: false,
      movementId: null,
    };
  }

  /** Crea o actualiza el borrador de la conversacion y cierra el evento en una transaccion. */
  private async saveDraft(
    event: CaptureEvent,
    input: NormalizedRequest,
    pending: Capture | null,
    draft: Draft,
    state: 'awaiting_details' | 'awaiting_confirmation',
    reply: string,
  ): Promise<CaptureOutcome> {
    await this.transactions.run(async (manager) => {
      const repository = manager.getRepository(Capture);
      // Lo que no aplica al borrador se limpia: al cambiar de una operacion ordinaria a
      // una deuda (o al reves) no queda nada del borrador anterior.
      const values = {
        state,
        kind: draft.kind,
        amount: draft.amount,
        // Solo se persisten monedas soportadas: el resto se vuelve a pedir.
        currency: isCurrency(draft.currency) ? draft.currency : null,
        accountId: draft.accountId,
        occurredOn: draft.occurredOn,
        description: draft.description,
        debtPayload: draft.debt === null ? null : serializeDebtDraft(draft.debt),
      };
      if (pending) {
        await repository.update({ id: pending.id }, values);
      } else {
        await repository.save(
          repository.create({
            chatId: input.chatId,
            sourceKey: sourceKeyFor(input.chatId, event.eventId),
            ...values,
            sourceText: input.text.slice(0, MAX_SOURCE_TEXT_LENGTH),
          }),
        );
      }
      await manager.getRepository(CaptureEvent).update(
        { id: event.id },
        { state: 'completed', reply, captureState: state, movementId: null },
      );
    });
    return {
      eventId: input.eventId,
      chatId: input.chatId,
      captureState: state,
      reply,
      replayed: false,
      movementId: null,
    };
  }

  /** Descarta el borrador: el mensaje no se puede registrar. */
  private async discard(
    event: CaptureEvent,
    input: NormalizedRequest,
    pending: Capture | null,
    reply: string,
  ): Promise<CaptureOutcome> {
    await this.transactions.run(async (manager) => {
      if (pending) {
        await manager.getRepository(Capture).update(
          { id: pending.id },
          { state: 'unsupported', sourceText: null, debtPayload: null },
        );
      }
      await manager.getRepository(CaptureEvent).update(
        { id: event.id },
        { state: 'completed', reply, captureState: 'unsupported', movementId: null },
      );
    });
    return {
      eventId: input.eventId,
      chatId: input.chatId,
      captureState: 'unsupported',
      reply,
      replayed: false,
      movementId: null,
    };
  }

  /** Cierra el evento sin tocar el borrador de la conversacion. */
  private async complete(
    event: CaptureEvent,
    input: NormalizedRequest,
    captureState: CaptureState | null,
    reply: string,
  ): Promise<CaptureOutcome> {
    await this.transactions.run(async (manager) => {
      await manager.getRepository(CaptureEvent).update(
        { id: event.id },
        { state: 'completed', reply, captureState, movementId: null },
      );
    });
    return {
      eventId: input.eventId,
      chatId: input.chatId,
      captureState,
      reply,
      replayed: false,
      movementId: null,
    };
  }

  /**
   * Marca el evento como incierto: no se reintenta solo.
   *
   * El borrador vivo de la conversacion se cancela en la misma transaccion: si la
   * correccion fallo, un `/confirm` posterior no puede confirmar el borrador
   * anterior (razon de seguridad financiera). El usuario tiene que volver a enviar
   * la operacion completa.
   */
  private async markUncertain(
    event: CaptureEvent,
    input: NormalizedRequest,
    reply: string,
  ): Promise<CaptureOutcome> {
    const message = `${reply}\n\n${RESEND_REPLY}`;
    await this.transactions.run(async (manager) => {
      await manager.getRepository(Capture).update(
        { chatId: input.chatId, state: In(['awaiting_details', 'awaiting_confirmation']) },
        { state: 'cancelled', sourceText: null, debtPayload: null },
      );
      await manager.getRepository(CaptureEvent).update(
        { id: event.id },
        { state: 'uncertain', reply: message },
      );
    });
    return {
      eventId: input.eventId,
      chatId: input.chatId,
      captureState: null,
      reply: message,
      replayed: false,
      movementId: null,
    };
  }

  private async createEvent(input: NormalizedRequest): Promise<CaptureEvent> {
    return this.transactions.run(async (manager) => {
      const repository = manager.getRepository(CaptureEvent);
      return repository.save(
        repository.create({
          eventId: input.eventId,
          chatId: input.chatId,
          state: 'processing',
          reply: null,
          captureState: null,
          movementId: null,
        }),
      );
    });
  }

  private async findEvent(eventId: string, chatId: string): Promise<CaptureEvent | null> {
    return this.dataSource.getRepository(CaptureEvent).findOneBy({ eventId, chatId });
  }

  private async findPendingCapture(chatId: string): Promise<Capture | null> {
    return this.dataSource.getRepository(Capture).findOne({
      where: [
        { chatId, state: 'awaiting_details' },
        { chatId, state: 'awaiting_confirmation' },
      ],
    });
  }

  private async activeAccounts(): Promise<AccountOption[]> {
    const accounts = await this.dataSource.getRepository(Account).find({
      where: { active: true },
      order: { name: 'ASC' },
    });
    return accounts.map((account) => ({
      id: account.id,
      name: account.name,
      currency: account.currency,
    }));
  }

  /**
   * Resumenes acotados de las deudas que se pueden pagar. La lista es la que ve el
   * modelo; la fuente de verdad sigue siendo la base de datos del backend.
   */
  private async debtCandidates(): Promise<{ debts: DebtCandidate[]; truncated: boolean }> {
    const rows = await this.debts.list();
    const pending = rows.filter((row) => row.status !== 'paid');
    const debts = pending.slice(0, MAX_DEBT_CANDIDATES).map((row) => ({
      id: row.debt.id,
      direction: row.debt.direction,
      counterparty: row.debt.counterparty,
      currency: row.debt.currency,
      outstanding: formatAmount(row.outstandingMinor, row.debt.currency),
      status: row.status as 'open' | 'partial',
      occurredOn: row.debt.occurredOn,
      description: row.debt.description,
    }));
    return { debts, truncated: pending.length > MAX_DEBT_CANDIDATES };
  }

  /**
   * Mensaje de error de un pago de deuda. Si el pendiente cambio, se dice con todas las
   * letras: no se paga un total nuevo en silencio.
   */
  private async debtErrorMessage(error: unknown, draft: Draft): Promise<string> {
    if (error instanceof ConflictError && draft.debt?.expectedOutstandingMinor) {
      const currency = (draft.debt.currency ?? 'USD') as Currency;
      const expected = formatAmount(BigInt(draft.debt.expectedOutstandingMinor), currency);
      const current = await this.debts
        .get(draft.debt.debtId as string)
        .then((view) => formatAmount(view.outstandingMinor, view.debt.currency))
        .catch(() => null);
      return (
        `el pendiente de la deuda cambio: se preparo con ${expected}` +
        (current === null ? '' : ` y ahora es ${current}`) +
        '. Vuelve a enviar el mensaje para preparar el pago de nuevo; no se registro nada'
      );
    }
    return safeErrorMessage(error);
  }
}

function normalizeRequest(request: CaptureRequest): NormalizedRequest {
  const eventId = requireText(request?.eventId, 'eventId', 200);
  const chatId = requireText(request?.chatId, 'chatId', 200);
  const receivedAt = requireText(request?.receivedAt, 'receivedAt', 64);
  const instant = new Date(receivedAt);
  if (Number.isNaN(instant.getTime())) {
    throw new ValidationError('El campo "receivedAt" debe ser una marca de tiempo valida.');
  }
  return {
    eventId,
    chatId,
    text: typeof request?.text === 'string' ? request.text : '',
    receivedAt: instant,
  };
}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`El campo "${field}" es obligatorio.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError(`El campo "${field}" es obligatorio.`);
  }
  if (trimmed.length > maxLength) {
    throw new ValidationError(`El campo "${field}" supera los ${maxLength} caracteres.`);
  }
  return trimmed;
}

/** `/confirm` y `/cancel` se atienden sin llamar al modelo. */
function detectCommand(text: string): 'confirm' | 'cancel' | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed.length === 0) {
    return null;
  }
  const [first] = trimmed.split(/\s+/);
  const command = first?.split('@')[0];
  if (command === '/confirm') {
    return 'confirm';
  }
  if (command === '/cancel') {
    return 'cancel';
  }
  return null;
}

function emptyDraft(): Draft {
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
function draftOf(capture: Capture): Draft {
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

function toPendingOperation(capture: Capture): PendingOperation {
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

/** Ids de deuda que el usuario **escribio** en su mensaje. */
function idsInText(text: string): string[] {
  const matches = text.match(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/gi) ?? [];
  return [...new Set(matches.map((value) => value.toLowerCase()))];
}

/**
 * `true` si la contraparte, la direccion o la moneda del pago contradicen la deuda
 * indicada. La contraparte se compara de forma canonica (como en el dominio): solo
 * encaja si es la misma persona.
 */
function contradicts(
  debt: DebtView,
  input: { direction: DebtDirection | null; counterparty: string | null; currency: string | null },
): boolean {
  if (input.direction !== null && input.direction !== debt.debt.direction) {
    return true;
  }
  if (input.currency !== null && isCurrency(input.currency) && input.currency !== debt.debt.currency) {
    return true;
  }
  if (
    input.counterparty !== null &&
    canonicalCounterparty(input.counterparty) !== canonicalCounterparty(debt.debt.counterparty)
  ) {
    return true;
  }
  return false;
}

/**
 * La fecha por defecto (la del mensaje en la zona del usuario) se aplica **solo** cuando
 * el modelo no da fecha (`null`). Cualquier otro valor no nulo se conserva tal cual: una
 * fecha vacia, en blanco o que no existe en el calendario no se sustituye en silencio, se
 * pide una fecha valida y la operacion no se puede confirmar.
 */
function resolveDate(value: string | null, defaultDate: string): string | null {
  if (value === null) {
    return defaultDate;
  }
  return value.trim();
}

/** `true` si la fecha existe en el calendario. */
function isValidDate(value: string): boolean {
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
function normalizeAmount(value: string | null): string | null {
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
function normalizeCounterparty(value: string | null): string | null {
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
 * Mensaje seguro para el usuario. Solo los errores de dominio del backend (reglas de
 * negocio) se muestran tal cual; cualquier otro fallo se resume sin detalle.
 */
function safeErrorMessage(error: unknown): string {
  if (
    error instanceof ValidationError ||
    error instanceof ConflictError ||
    error instanceof NotFoundError
  ) {
    return error.message;
  }
  return 'ocurrio un error inesperado y no se registro nada.';
}

/**
 * La descripcion se guarda en una sola linea: se colapsan los espacios y se recortan los
 * saltos de linea del modelo. Se conserva un maximo de caracteres porque la columna
 * del movimiento es corta.
 */
function normalizeDescription(value: string | null): string | null {
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
function validateDraft(draft: Draft, accounts: AccountOption[]): DraftProblem[] {
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
function amountProblems(draft: Draft): DraftProblem[] {
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
function currencyProblems(draft: Draft, account: AccountOption | undefined): DraftProblem[] {
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
function dateProblems(draft: Draft): DraftProblem[] {
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
function validateDebtCreate(draft: Draft): DraftProblem[] {
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
function validateDebtDraft(draft: Draft, accounts: AccountOption[]): DraftProblem[] {
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
  if (debt.settlementMode === 'full' && debt.fullIntent !== true) {
    // Un pago total solo es valido si el usuario dijo que pago todo. Los borradores
    // escritos antes de existir la autorizacion no la tienen: se piden de nuevo.
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
function tryParseAmount(value: string, currency: Currency): bigint | null {
  try {
    return parseAmount(value, currency);
  } catch {
    return null;
  }
}

function detailsReply(
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
function unclearReply(problems: DraftProblem[], accounts: AccountOption[]): string {
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

function confirmationReply(draft: Draft, accounts: AccountOption[]): string {
  const account = accounts.find((candidate) => candidate.id === draft.accountId);
  return [
    'Entendi esta operacion:',
    `  - tipo: ${draft.kind === 'income' ? 'ingreso' : 'gasto'}`,
    `  - importe: ${draft.amount} ${draft.currency}`,
    `  - cuenta: ${account ? `${account.name} (${account.currency})` : draft.accountId}`,
    `  - fecha: ${draft.occurredOn}`,
    `  - descripcion: ${draft.description ?? '(sin descripcion)'}`,
    '',
    'Responde /confirm para registrarla o /cancel para descartarla.',
  ].join('\n');
}

/** Resumen de una deuda nueva: no hay cuenta porque todavia no se movio dinero. */
function debtCreateReply(draft: Draft): string {
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
function debtSettleReply(draft: Draft, debt: DebtView, account: AccountOption | undefined): string {
  const payload = draft.debt;
  const outstanding = formatAmount(debt.outstandingMinor, debt.debt.currency);
  return [
    'Entendi este pago de deuda:',
    `  - deuda: ${debt.debt.id} | ${debt.debt.counterparty} | ${directionLabel(payload?.direction ?? null)} | ${debt.debt.currency}`,
    `  - modo: ${payload?.settlementMode === 'full' ? 'pago total' : 'pago parcial'}`,
    `  - importe: ${payload?.amount} ${payload?.currency}`,
    `  - pendiente al preparar: ${outstanding} ${debt.debt.currency}`,
    `  - cuenta: ${account ? `${account.name} (${account.currency})` : payload?.accountId}`,
    `  - fecha: ${payload?.occurredOn}`,
    `  - descripcion: ${payload?.description ?? '(sin descripcion)'}`,
    '',
    'Responde /confirm para registrarlo o /cancel para descartarlo.',
  ].join('\n');
}

function registeredReply(draft: Draft, account: AccountOption | undefined): string {
  const where = account ? ` en la cuenta ${account.name}` : '';
  return `Registrado: ${draft.kind === 'income' ? 'ingreso' : 'gasto'} de ${draft.amount} ${draft.currency}${where} (${draft.occurredOn}).`;
}

/** Confirmacion de una deuda nueva: no hay movimiento, solo la obligacion. */
function debtCreatedReply(draft: Draft, debtId: string): string {
  const debt = draft.debt;
  return `Registrado: deuda de ${debt?.amount} ${debt?.currency} con ${debt?.counterparty} (${directionLabel(debt?.direction ?? null)}). Deuda: ${debtId}`;
}

/** Confirmacion de un pago de deuda: ids de la deuda, del pago y del movimiento. */
function debtSettledReply(draft: Draft, paymentId: string, movementId: string): string {
  const debt = draft.debt;
  return `Registrado: pago de ${debt?.amount} ${debt?.currency} de la deuda ${debt?.debtId} (${debt?.counterparty}). Pago: ${paymentId}. Movimiento: ${movementId}`;
}

function replay(event: CaptureEvent): CaptureOutcome {
  return {
    eventId: event.eventId,
    chatId: event.chatId,
    captureState: event.captureState,
    reply: event.reply ?? 'El evento ya fue procesado.',
    replayed: true,
    movementId: event.movementId,
  };
}
