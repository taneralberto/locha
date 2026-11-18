import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { Account } from '../accounts/account.entity';
import { isUniqueViolation } from '../data/unique-violation';
import { TransactionRunner } from '../data/transaction.runner';
import { dateInTimeZone } from '../domain/date';
import { ValidationError } from '../domain/errors';
import { Currency, isCurrency, parseAmount } from '../domain/money';
import { DebtDirection } from '../debts/debt.entity';
import { DebtService } from '../debts/debt.service';
import { FinancialService } from '../financial/financial.service';
import { MovementKind } from '../financial/movement.entity';
import { AccountOption, InterpreterError, OperationInterpreter } from '../interpreter/interpreter';
import {
  DebtFollowUp,
  DebtFollowUpInterpreter,
  UnavailableDebtFollowUpInterpreter,
} from '../interpreter/debt-follow-up';
import { HistoryLoader, HistoryTurn } from '../interpreter/history-window';
import { Operation } from '../interpreter/operation.schema';
import { Capture, CaptureState } from './capture.entity';
import { CaptureEvent, CaptureEventState } from './capture-event.entity';
import {
  BROKEN_DEBT_DRAFT_REPLY,
  BUDGET_EXHAUSTED_REPLY,
  CANCELLED_REPLY,
  confirmationReply,
  CONVERSION_REPLY,
  debtCreatedReply,
  debtSettledReply,
  DEBT_CLARIFY_REPLY,
  detailsReply,
  EMPTY_MESSAGE_REPLY,
  FOLLOW_UP_CLARIFY_REPLY,
  FOLLOW_UP_NO_CONTEXT_REPLY,
  FOLLOW_UP_REFORMULATE_REPLY,
  MULTIPLE_OPERATIONS_REPLY,
  NOTHING_TO_CANCEL_REPLY,
  NOTHING_TO_CONFIRM_REPLY,
  NOT_CONFIGURED_REPLY,
  NOT_READY_REPLY,
  registeredReply,
  RESEND_REPLY,
  RETRY_REPLY,
  safeErrorMessage,
  TOO_LONG_REPLY,
  UNSUPPORTED_REPLY,
  unclearReply,
} from './capture-format';
import { choiceIndex, DebtCapture } from './debt-capture';
import { serializeDebtDraft } from './debt-draft';
import {
  Draft,
  DraftResult,
  draftOf,
  emptyDraft,
  normalizeAmount,
  normalizeCounterparty,
  normalizeDescription,
  PendingDraft,
  resolveDate,
  toPendingOperation,
  validateDebtDraft,
  validateDraft,
  withoutFullAuthorization,
} from './draft';
import { BudgetExhaustedError, DEFAULT_TIME_ZONE, InferenceBudgetService } from './inference-budget.service';
import { sourceKeyFor } from './source-key';
import {
  isReadOnlyDebtQuestion,
  mentionsConversion,
  mentionsDebt,
  mentionsMultipleAmounts,
} from './text-signals';

/** Longitud maxima del texto original que se guarda mientras el borrador esta vivo. */
const MAX_SOURCE_TEXT_LENGTH = 1000;

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
  /**
   * Carga **perezosa** del historial del chat. Solo se usa si el mensaje necesita
   * contexto (una pregunta de seguimiento): los comandos y las operaciones normales no
   * la piden. Sin historial, la pregunta se responde pidiendo la persona.
   */
  history?: HistoryLoader | null;
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

/**
 * Lo que la captura dice de un borrador vivo: su identidad, su conversacion y la clave
 * de su origen. Es lo unico que un transporte necesita para decidir si ese borrador
 * sigue siendo suyo: la captura no expone el borrador entero.
 */
export interface PendingOrigin {
  id: string;
  chatId: string;
  sourceKey: string;
}

interface NormalizedRequest {
  eventId: string;
  chatId: string;
  text: string;
  receivedAt: Date;
  /** La carga perezosa del historial: `null` si el transporte no lo trae. */
  history: HistoryLoader | null;
}

@Injectable()
export class CaptureService {
  /** La captura de deudas: prepara borradores, responde consultas y explica errores. */
  private readonly debtCapture: DebtCapture;

  constructor(
    private readonly dataSource: DataSource,
    private readonly transactions: TransactionRunner,
    private readonly financial: FinancialService,
    private readonly interpreter: OperationInterpreter,
    private readonly budget: InferenceBudgetService,
    private readonly debts: DebtService,
    /**
     * La via de seguimiento. Es **opcional**: sin ella la pregunta contextual se
     * responde pidiendo la persona de forma explicita, sin tocar el borrador.
     */
    private readonly followUp: DebtFollowUpInterpreter = new UnavailableDebtFollowUpInterpreter(),
  ) {
    this.debtCapture = new DebtCapture(this.debts);
  }

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

  /**
   * Los borradores vivos de las conversaciones, con su origen.
   *
   * La captura es la unica que sabe que borrador esta vivo: quien los necesita (el
   * transporte, al revisar que trabajo sigue autorizado) los pide aqui y decide que
   * hacer con ellos. El `manager` es obligatorio: la lectura comparte transaccion con
   * la decision que se tome sobre ellos.
   */
  async pendingOrigins(manager: EntityManager): Promise<PendingOrigin[]> {
    const rows = await manager.getRepository(Capture).find({
      where: { state: In(['awaiting_details', 'awaiting_confirmation']) },
    });
    return rows.map((row) => ({ id: row.id, chatId: row.chatId, sourceKey: row.sourceKey }));
  }

  /**
   * Cancela el borrador vivo de una conversacion: no queda texto original ni datos de
   * deuda. Solo se toca el borrador **vivo**: lo ya registrado no se toca.
   *
   * El `manager` es obligatorio: la cancelacion comparte transaccion con lo que la
   * acompaña (la limpieza del transporte, por ejemplo). Cancelar por conversacion es lo
   * mismo que cancelar por id: hay un unico borrador vivo por conversacion.
   */
  async cancelPending(chatId: string, manager: EntityManager): Promise<void> {
    await manager.getRepository(Capture).update(
      { chatId, state: In(['awaiting_details', 'awaiting_confirmation']) },
      { state: 'cancelled', sourceText: null, debtPayload: null },
    );
  }

  private async process(input: NormalizedRequest): Promise<CaptureOutcome> {
    // La forma de la pregunta de consulta de deuda que no depende del modelo. Si el
    // clasificador falla, una pregunta de lectura **no** cancela el borrador: no es una
    // correccion. La señal es grammatical y conservadora (ver `text-signals`) y se
    // calcula **una sola vez**, antes de crear el evento: decide con que estado nace.
    const readOnlyQuestion = isReadOnlyDebtQuestion(input.text);

    const existing = await this.findEvent(input.eventId, input.chatId);
    if (existing) {
      if (existing.state === 'processing') {
        // La inferencia quedo interrumpida: no se vuelve a llamar al proveedor.
        return this.markUncertain(existing, input, RETRY_REPLY);
      }
      if (existing.state === 'reading') {
        // La consulta de seguimiento quedo a medias: se completa sin volver a gastar
        // y sin tocar el borrador.
        return this.recoverReading(existing, input);
      }
      return replay(existing);
    }

    let event: CaptureEvent;
    try {
      event = await this.createEvent(input, readOnlyQuestion ? 'reading' : 'processing');
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // Otra escritura registro el mismo evento: se reproduce su respuesta guardada.
      const winner = await this.findEvent(input.eventId, input.chatId);
      if (!winner) {
        throw error;
      }
      if (winner.state === 'processing') {
        return this.markUncertain(winner, input, RETRY_REPLY);
      }
      if (winner.state === 'reading') {
        return this.recoverReading(winner, input);
      }
      return replay(winner);
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

    const pending = await this.findPendingCapture(input.chatId);
    const pendingDraft = pending === null ? null : this.pendingOf(pending);

    // Una eleccion de la lista de deudas se resuelve **antes** del modelo: el numero
    // es la fuente de verdad (el id guardado es el que se paga) y asi no se gasta
    // inferencia en un mensaje que ya esta dicho.
    if (pending !== null && pendingDraft !== null) {
      const choice = choiceIndex(input.text, pendingDraft.draft.debt?.choices ?? []);
      if (choice !== null) {
        return this.debtChoice(event, input, pending, pendingDraft, choice);
      }
    }

    // La forma de la pregunta de consulta de deuda que no depende del modelo ya se
    // calculo al principio (ver `readOnlyQuestion`): si el clasificador falla, una
    // pregunta de lectura **no** cancela el borrador: no es una correccion.

    if (!this.interpreter.enabled) {
      // Una pregunta de lectura no cancela el borrador: no es una correccion.
      return readOnlyQuestion
        ? this.complete(event, input, pending?.state ?? null, NOT_CONFIGURED_REPLY)
        : this.markUncertain(event, input, NOT_CONFIGURED_REPLY);
    }

    const accounts = await this.activeAccounts();
    const defaultDate = dateInTimeZone(input.receivedAt, DEFAULT_TIME_ZONE);
    const candidates = await this.debtCapture.candidates();

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
      if (readOnlyQuestion) {
        // La pregunta no se pudo clasificar: se responde sin tocar el borrador (no es
        // una correccion) y sin reintentar.
        if (error instanceof BudgetExhaustedError) {
          return this.complete(event, input, pending?.state ?? null, BUDGET_EXHAUSTED_REPLY);
        }
        if (error instanceof InterpreterError && error.reason === 'too_long') {
          return this.complete(event, input, pending?.state ?? null, TOO_LONG_REPLY);
        }
        return this.complete(event, input, pending?.state ?? null, RETRY_REPLY);
      }
      if (error instanceof BudgetExhaustedError) {
        return this.markUncertain(event, input, BUDGET_EXHAUSTED_REPLY);
      }
      if (error instanceof InterpreterError && error.reason === 'too_long') {
        return this.markUncertain(event, input, TOO_LONG_REPLY);
      }
      return this.markUncertain(event, input, RETRY_REPLY);
    }

    // Una pregunta de lectura que el clasificador resuelve como otra cosa (una
    // operacion, un pago, una duda) **no se escribe**: la rama es de solo lectura.
    if (readOnlyQuestion && operation.kind !== 'debt_follow_up' && operation.kind !== 'debt_query') {
      return this.complete(event, input, pending?.state ?? null, FOLLOW_UP_REFORMULATE_REPLY);
    }

    // Una consulta de deudas es de solo lectura: va antes de cualquier conversion,
    // operacion multiple o descarte, y no toca el borrador pendiente.
    if (operation.kind === 'debt_query') {
      // La forma inequivoca de la pregunta de seguimiento **no** es una consulta
      // general: depende de un turno anterior del chat. Se resuelve con la ventana (o
      // se pide la persona), nunca con una lista de deudas: un nombre que venga del
      // modelo no se usa.
      if (readOnlyQuestion) {
        return this.debtFollowUp(event, input, pending, accounts);
      }
      const reply = await this.debtCapture.query({
        operation,
        accounts,
        text: input.text,
      });
      return this.complete(event, input, pending?.state ?? null, reply);
    }

    // Una pregunta contextual ("¿y cuánto le debía inicialmente?") se resuelve con la
    // ventana del chat. Tambien es de solo lectura: no toca el borrador pendiente.
    if (operation.kind === 'debt_follow_up') {
      return this.debtFollowUp(event, input, pending, accounts);
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
      const draft = pendingDraft?.draft ?? emptyDraft();
      // Un mensaje que no se entiende no conserva ni la autorizacion de pago total ni el
      // importe derivado de ella: se vuelve a pedir el pago.
      const cleared = withoutFullAuthorization(draft);
      const isDebt = cleared.kind === 'debt_create' || cleared.kind === 'debt_settle';
      const problems = isDebt
        ? validateDebtDraft(cleared, accounts)
        : validateDraft(cleared, accounts);
      return this.saveDraft(event, input, pending, {
        draft: cleared,
        state: 'awaiting_details',
        reply: unclearReply(problems, accounts),
      });
    }
    if (operation.kind === 'debt_create') {
      const prepared = await this.debtCapture.prepareCreate({ operation, accounts, defaultDate });
      return this.saveDraft(event, input, pending, prepared);
    }
    if (operation.kind === 'debt_settle') {
      const prepared = await this.debtCapture.prepareSettle({
        operation,
        accounts,
        defaultDate,
        text: input.text,
        pending: pendingDraft,
        resolved: null,
      });
      return this.saveDraft(event, input, pending, prepared);
    }

    // Salvaguarda: el mensaje habla de una deuda y el modelo lo clasifico como gasto o
    // ingreso. No se registra nada: se pregunta que quiso decir.
    if (mentionsDebt(input.text)) {
      return this.saveDraft(event, input, pending, {
        draft: emptyDraft(),
        state: 'awaiting_details',
        reply: DEBT_CLARIFY_REPLY,
      });
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
      return this.saveDraft(event, input, pending, {
        draft,
        state: 'awaiting_details',
        reply: detailsReply(problems, accounts),
      });
    }
    return this.saveDraft(event, input, pending, {
      draft,
      state: 'awaiting_confirmation',
      reply: confirmationReply(draft, accounts),
    });
  }

  /**
   * Pregunta **contextual**: el mensaje depende de un turno anterior del chat ("¿y
   * cuánto le debia inicialmente?").
   *
   * Se resuelve con una llamada propia que ve la ventana del chat como **datos**, y
   * la respuesta sale de la base de datos: el historial nunca aporta importes ni
   * estados. La rama es de **solo lectura**: no toca el borrador, no registra nada y
   * no elige deudas.
   *
   * Si no hay ventana, o no se puede resolver de quien es la pregunta, se pide la
   * persona de forma explicita (sin listar todas las deudas). Un fallo del proveedor
   * **no** cancela el borrador: se pide repetir la pregunta.
   *
   * Tambien se resuelve aqui un **grupo por direccion** ("lo que debo nada mas"): no
   * tiene persona, asi que su filtro es la direccion; sin estado explicito solo
   * salen las pendientes (tambien en el detalle) y no se usa ningun id escrito.
   */
  private async debtFollowUp(
    event: CaptureEvent,
    input: NormalizedRequest,
    pending: Capture | null,
    accounts: AccountOption[],
  ): Promise<CaptureOutcome> {
    // El evento queda en 'reading' **antes de cualquier carga**: si la ventana no se
    // puede leer, o si la llamada se interrumpe, la reentrada ve este estado y completa
    // la respuesta **sin volver a gastar** y sin tocar el borrador. La forma inequivoca
    // ya nacio en 'reading' (no hay transicion que repetir); una pregunta que solo el
    // modelo reconocio viene en 'processing' y se marca aqui.
    if (event.state !== 'reading') {
      await this.markReading(event);
    }

    let window: HistoryTurn[];
    try {
      window = await this.readHistoryWindow(input);
    } catch (error) {
      // El historial no se pudo leer: se pide repetir la pregunta. No se reserva ni se
      // llama al proveedor, y el borrador no se toca.
      return this.complete(event, input, pending?.state ?? null, FOLLOW_UP_REFORMULATE_REPLY);
    }
    if (window.length === 0) {
      // Sin ventana no hay referencia que resolver: se pide la persona.
      return this.complete(event, input, pending?.state ?? null, FOLLOW_UP_NO_CONTEXT_REPLY);
    }

    let answer: DebtFollowUp;
    try {
      await this.budget.reserve();
      answer = await this.followUp.resolve({ text: input.text, history: window });
    } catch (error) {
      if (error instanceof BudgetExhaustedError) {
        return this.complete(event, input, pending?.state ?? null, BUDGET_EXHAUSTED_REPLY);
      }
      return this.complete(event, input, pending?.state ?? null, FOLLOW_UP_REFORMULATE_REPLY);
    }

    const counterparty = normalizeCounterparty(answer.counterparty);
    const isGroup = answer.kind === 'debt_group';
    if (answer.kind === 'clarify') {
      // No se sabe de quien es la pregunta (o hay varias personas posibles): se pide,
      // sin listar todas las deudas.
      return this.complete(event, input, pending?.state ?? null, FOLLOW_UP_CLARIFY_REPLY);
    }
    if (isGroup) {
      // Un **grupo** por direccion: la direccion tiene que estar clara y no hay
      // persona. La contraparte se comprueba **literalmente**: un grupo no admite una
      // persona, ni siquiera una cadena vacia. Un grupo sin direccion, o con una
      // persona, es contradictorio: se pide y no se lista nada (fail-closed: nunca se
      // amplia a todas las deudas).
      if (answer.direction === null || answer.counterparty !== null) {
        return this.complete(event, input, pending?.state ?? null, FOLLOW_UP_CLARIFY_REPLY);
      }
    } else if (counterparty === null) {
      // Una consulta de una persona sin persona no se amplia: se pide la persona,
      // aunque la direccion este clara.
      return this.complete(event, input, pending?.state ?? null, FOLLOW_UP_CLARIFY_REPLY);
    }

    // La consulta la responde el backend con los datos **actuales**: la misma consulta
    // de deudas, con los filtros que resolved la pregunta. El grupo filtra por
    // direccion y deja la contraparte en null.
    let reply: string;
    try {
      reply = await this.debtCapture.query({
        operation: {
          kind: 'debt_query',
          amount: null,
          currency: answer.currency,
          accountId: null,
          occurredOn: null,
          description: null,
          debt: {
            direction: answer.direction,
            counterparty,
            debtId: null,
            settlementMode: null,
            // En el grupo el estado es explicito por defecto: sin el, el detalle
            // dejaria pasar tambien las deudas saldadas. Un estado pedido de forma
            // explicita manda. Las vistas nominales conservan su politica previa.
            status: isGroup ? (answer.status ?? 'pending') : answer.status,
            queryDetail: answer.queryDetail,
          },
        },
        accounts,
        // El id escrito manda sobre los filtros de una **consulta nominal**: es su
        // politica previa y no se toca. En el grupo no se extraen ids: un id escrito
        // sustituiria la direccion y podria devolver el lado contrario.
        text: isGroup ? '' : input.text,
      });
    } catch (error) {
      // Fallo de **solo lectura**: la respuesta se pide de nuevo y el borrador no se
      // toca. Esta rama no registra nada ni elige deudas.
      return this.complete(event, input, pending?.state ?? null, FOLLOW_UP_REFORMULATE_REPLY);
    }
    return this.complete(event, input, pending?.state ?? null, reply);
  }

  /**
   * La ventana del chat del mensaje actual. Se carga **una vez** y solo cuando hace
   * falta: los comandos y las operaciones normales no la piden.
   *
   * Solo viajan el rol y el texto: ningun metadato interno del transporte sale de aqui.
   */
  private async readHistoryWindow(input: NormalizedRequest): Promise<HistoryTurn[]> {
    const loader = input.history;
    if (loader === null) {
      return [];
    }
    const turns = await loader();
    return turns.map((turn) => ({ role: turn.role, text: turn.text }));
  }

  /**
   * Elige una deuda de la lista numerada que quedo pendiente y prepara el pago con
   * ella. La lista y el pago los prepara la captura de deudas; aqui solo se guarda
   * lo que devuelve.
   */
  private async debtChoice(
    event: CaptureEvent,
    input: NormalizedRequest,
    pending: Capture,
    pendingDraft: PendingDraft,
    index: number,
  ): Promise<CaptureOutcome> {
    const accounts = await this.activeAccounts();
    const defaultDate = dateInTimeZone(input.receivedAt, DEFAULT_TIME_ZONE);
    const prepared = await this.debtCapture.choose({
      pending: pendingDraft,
      index,
      accounts,
      defaultDate,
      text: input.text,
    });
    return this.saveDraft(event, input, pending, prepared);
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
      return this.saveDraft(event, input, pending, {
        draft,
        state: 'awaiting_details',
        reply: detailsReply(problems, accounts),
      });
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
      return this.saveDraft(event, input, pending, {
        draft,
        state: 'awaiting_details',
        reply: `No se pudo registrar la operacion: ${message}`,
      });
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
      return this.saveDraft(event, input, pending, {
        draft: emptyDraft(),
        state: 'awaiting_details',
        reply: BROKEN_DEBT_DRAFT_REPLY,
      });
    }
    const problems = validateDebtDraft(draft, accounts);
    if (problems.length > 0) {
      const title =
        draft.kind === 'debt_create'
          ? 'Faltan datos para registrar la deuda:'
          : 'Faltan datos para registrar el pago:';
      // Un pago total sin autorizacion vigente no se queda guardado como tal: la
      // invalidacion se persiste para que el borrador no pueda volver a confirmar.
      return this.saveDraft(event, input, pending, {
        draft: withoutFullAuthorization(draft),
        state: 'awaiting_details',
        reply: detailsReply(problems, accounts, title),
      });
    }

    try {
      const result = await this.transactions.run(async (manager) => {
        if (draft.kind === 'debt_create') {
          await this.debts.create(
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
          const message = debtCreatedReply(draft);
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
        const message = debtSettledReply(draft);
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
      const message = await this.debtCapture.errorMessage(error, draft);
      return this.saveDraft(event, input, pending, {
        draft,
        state: 'awaiting_details',
        reply: `No se pudo registrar la operacion: ${message}`,
      });
    }
  }

  /** Descarta el borrador vivo sin registrar nada. */
  private async cancel(event: CaptureEvent, input: NormalizedRequest): Promise<CaptureOutcome> {
    const pending = await this.findPendingCapture(input.chatId);
    if (!pending) {
      return this.complete(event, input, null, NOTHING_TO_CANCEL_REPLY);
    }
    await this.transactions.run(async (manager) => {
      await this.cancelPending(input.chatId, manager);
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
    result: DraftResult,
  ): Promise<CaptureOutcome> {
    const { draft, state, reply } = result;
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
      await this.cancelPending(input.chatId, manager);
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

  /**
   * El evento queda **leyendo** el contexto: la consulta de seguimiento esta en
   * curso. Si el proceso se cae aqui, la reentrada ve este estado y completa la
   * respuesta sin volver a llamar al proveedor.
   */
  private async markReading(event: CaptureEvent): Promise<void> {
    await this.transactions.run(async (manager) => {
      await manager.getRepository(CaptureEvent).update({ id: event.id }, { state: 'reading' });
    });
  }

  /**
   * La consulta de seguimiento quedo interrumpida: se completa **sin volver a gastar**
   * y **sin tocar el borrador** (a diferencia del evento 'processing', que cancela el
   * borrador porque era una correccion que no se pudo interpretar).
   *
   * La respuesta pide repetir la pregunta con la persona.
   */
  private async recoverReading(event: CaptureEvent, input: NormalizedRequest): Promise<CaptureOutcome> {
    await this.transactions.run(async (manager) => {
      await manager.getRepository(CaptureEvent).update(
        { id: event.id },
        {
          state: 'completed',
          reply: FOLLOW_UP_REFORMULATE_REPLY,
          captureState: null,
          movementId: null,
        },
      );
    });
    return {
      eventId: input.eventId,
      chatId: input.chatId,
      captureState: null,
      reply: FOLLOW_UP_REFORMULATE_REPLY,
      replayed: false,
      movementId: null,
    };
  }

  /**
   * Crea el evento con el estado con el que **nace**.
   *
   * La pregunta de lectura nace en 'reading': no hay un paso transitorio por
   * 'processing', asi que una interrupcion (o un fallo) despues de esta escritura
   * deja el evento en 'reading' y la reentrada completa la respuesta **sin volver a
   * clasificar ni gastar** y sin tocar el borrador.
   */
  private async createEvent(input: NormalizedRequest, state: CaptureEventState): Promise<CaptureEvent> {
    return this.transactions.run(async (manager) => {
      const repository = manager.getRepository(CaptureEvent);
      return repository.save(
        repository.create({
          eventId: input.eventId,
          chatId: input.chatId,
          state,
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

  /** El borrador vivo de la conversacion, con su estado. */
  private pendingOf(pending: Capture): PendingDraft {
    return { draft: draftOf(pending), state: pending.state };
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
    history: request?.history ?? null,
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
