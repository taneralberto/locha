import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { Account } from '../accounts/account.entity';
import { isUniqueViolation } from '../data/unique-violation';
import { TransactionRunner } from '../data/transaction.runner';
import { dateInTimeZone, parseDate } from '../domain/date';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import { CURRENCY_CODES, Currency, isCurrency, parseAmount } from '../domain/money';
import { FinancialService } from '../financial/financial.service';
import {
  AccountOption,
  InterpreterError,
  OperationInterpreter,
  PendingOperation,
} from '../interpreter/interpreter';
import { Operation } from '../interpreter/operation.schema';
import { Capture, CaptureKind, CaptureState } from './capture.entity';
import { sourceKeyFor } from './source-key';
import { CaptureEvent } from './capture-event.entity';
import { BudgetExhaustedError, DEFAULT_TIME_ZONE, InferenceBudgetService } from './inference-budget.service';
import { mentionsConversion, mentionsMultipleAmounts } from './text-signals';

/** Longitud maxima del texto original que se guarda mientras el borrador esta vivo. */
const MAX_SOURCE_TEXT_LENGTH = 1000;
/** Longitud maxima de la descripcion de una operacion (limite de `Movement`). */
const MAX_DESCRIPTION_LENGTH = 280;
/** Longitud maxima del importe guardado: un importe mas largo no es un importe. */
const MAX_AMOUNT_LENGTH = 40;

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
}

interface DraftProblem {
  field: 'kind' | 'amount' | 'currency' | 'account' | 'date';
  message: string;
}

@Injectable()
export class CaptureService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly transactions: TransactionRunner,
    private readonly financial: FinancialService,
    private readonly interpreter: OperationInterpreter,
    private readonly budget: InferenceBudgetService,
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

    let operation: Operation;
    try {
      await this.budget.reserve();
      operation = await this.interpreter.interpret({
        text: input.text,
        accounts,
        defaultDate,
        pending: pending ? toPendingOperation(pending) : null,
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
      const problems = validateDraft(draft, accounts);
      return this.saveDraft(
        event,
        input,
        pending,
        draft,
        'awaiting_details',
        unclearReply(problems, accounts),
      );
    }

    const draft: Draft = {
      kind: operation.kind,
      amount: normalizeAmount(operation.amount),
      currency: operation.currency === null ? null : operation.currency.trim(),
      accountId: operation.accountId === null ? null : operation.accountId.trim(),
      occurredOn: resolveDate(operation.occurredOn, defaultDate),
      description: normalizeDescription(operation.description),
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
            kind: pending.kind as CaptureKind,
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

  /** Descarta el borrador vivo sin registrar nada. */
  private async cancel(event: CaptureEvent, input: NormalizedRequest): Promise<CaptureOutcome> {
    const pending = await this.findPendingCapture(input.chatId);
    if (!pending) {
      return this.complete(event, input, null, NOTHING_TO_CANCEL_REPLY);
    }
    await this.transactions.run(async (manager) => {
      await manager.getRepository(Capture).update(
        { id: pending.id },
        { state: 'cancelled', sourceText: null },
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
      if (pending) {
        await repository.update(
          { id: pending.id },
          {
            state,
            kind: draft.kind,
            amount: draft.amount,
            // Solo se persisten monedas soportadas: el resto se vuelve a pedir.
            currency: isCurrency(draft.currency) ? draft.currency : null,
            accountId: draft.accountId,
            occurredOn: draft.occurredOn,
            description: draft.description,
          },
        );
      } else {
        await repository.save(
          repository.create({
            chatId: input.chatId,
            sourceKey: sourceKeyFor(input.chatId, event.eventId),
            state,
            kind: draft.kind,
            amount: draft.amount,
            currency: isCurrency(draft.currency) ? draft.currency : null,
            accountId: draft.accountId,
            occurredOn: draft.occurredOn,
            description: draft.description,
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
          { state: 'unsupported', sourceText: null },
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
        { state: 'cancelled', sourceText: null },
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
  };
}

function draftOf(capture: Capture): Draft {
  return {
    kind: capture.kind,
    amount: capture.amount,
    currency: capture.currency,
    accountId: capture.accountId,
    occurredOn: capture.occurredOn,
    description: capture.description,
  };
}

function toPendingOperation(capture: Capture): PendingOperation {
  const draft = draftOf(capture);
  return {
    kind: draft.kind,
    amount: draft.amount,
    currency: draft.currency,
    accountId: draft.accountId,
    occurredOn: draft.occurredOn,
    description: draft.description,
    sourceText: capture.sourceText ?? '',
  };
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
 * La descripcion se guarda en una sola linea: se colapsan los espacios y se recortan
 * los saltos de linea del modelo. Se conserva un maximo de caracteres porque la columna
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

  if (!account) {
    problems.push({ field: 'account', message: 'falta la cuenta' });
  }

  if (draft.occurredOn !== null && !isValidDate(draft.occurredOn)) {
    problems.push({
      field: 'date',
      message:
        draft.occurredOn.length === 0
          ? 'falta la fecha (se espera YYYY-MM-DD)'
          : `la fecha "${draft.occurredOn}" no es valida (se espera YYYY-MM-DD)`,
    });
  }

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

function detailsReply(problems: DraftProblem[], accounts: AccountOption[]): string {
  const lines = problems.map((problem) => `  - ${problem.message}`);
  if (problems.some((problem) => problem.field === 'account') && accounts.length > 0) {
    lines.push(`  cuentas: ${accounts.map((account) => `${account.name} (${account.currency})`).join(', ')}`);
  }
  return [
    'Faltan datos para registrar la operacion:',
    ...lines,
    '',
    'Escribe los datos que faltan.',
  ].join('\n');
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

function registeredReply(draft: Draft, account: AccountOption | undefined): string {
  const where = account ? ` en la cuenta ${account.name}` : '';
  return `Registrado: ${draft.kind === 'income' ? 'ingreso' : 'gasto'} de ${draft.amount} ${draft.currency}${where} (${draft.occurredOn}).`;
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
