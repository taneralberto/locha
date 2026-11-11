import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { Capture } from '../capture/capture.entity';
import { sourceKeyFor } from '../capture/source-key';
import { TelegramSettings } from '../config/configuration';
import { TransactionRunner } from '../data/transaction.runner';
import { TelegramClient, TelegramError } from './telegram-client';
import { TelegramCommands } from './telegram-commands';
import { POLLING_CURSOR_ID, TelegramCursor } from './telegram-cursor.entity';
import { TelegramInbox } from './telegram-inbox.entity';
import { TelegramOutbox } from './telegram-outbox.entity';
import { TelegramUpdate, telegramEventId } from './telegram-update';

/** Espera minima entre sondeos cuando no llega nada (evita un bucle rapido). */
const POLL_IDLE_MS = 1_000;
/** Espera inicial tras un fallo de transporte o de entrega. */
const BACKOFF_BASE_MS = 1_000;
/** Tope de la espera entre reintentos. */
const BACKOFF_MAX_MS = 60_000;
/** Escalon maximo del retardo: a partir de ahi la espera es siempre el tope. */
const MAX_BACKOFF_STEP = 10;
/** Techo del contador de intentos: nunca se desborda. */
const MAX_ATTEMPTS = 1_000_000;
/** Longitud maxima del texto original que se guarda en la bandeja de entrada. */
const MAX_INBOX_TEXT_LENGTH = 4_096;

interface AcceptedMessage {
  chatId: string;
  userId: string;
  text: string;
  receivedAt: string;
}

/**
 * Chat con un fallo de procesamiento: la espera hasta el proximo intento. Solo es un
 * **reloj**: lo que hay pendiente se lee siempre de la bandeja de entrada.
 */
interface ChatBackoff {
  /** Intentos fallidos: el retardo crece con ellos. */
  attempts: number;
  /** Momento en el que se puede volver a intentar. */
  nextAttemptAt: number;
}

/**
 * Bot de Telegram en modo long polling.
 *
 * El ciclo es durable y tiene tres pasos separados:
 *
 * 1. **Aceptar** (durable): la actualizacion autorizada se guarda en la bandeja de
 *    entrada y el cursor avanza, en una sola transaccion. Si la aceptacion falla, el
 *    lote se corta y el cursor no avanza.
 * 2. **Procesar**: se lee la bandeja de entrada **en orden de actualizacion** y se
 *    procesa lo pendiente. Es la **unica** via de procesamiento: si no se puede leer
 *    lo pendiente, no se procesa nada nuevo, y un `/confirm` nunca se aplica a un
 *    borrador anterior a una correccion pendiente.
 * 3. **Entregar**: las respuestas pendientes se envian por orden de chat. Si una
 *    entrega anterior esta retrasada o falla de forma transitoria, las siguientes de
 *    ese chat esperan.
 *
 * Solo se acepta lo que viene del chat privado y del usuario autorizados, y la
 * autorizacion ocurre **antes** de guardar el texto, de interpretar y de responder.
 * Tambien se vuelve a comprobar al recuperar trabajo pendiente: si la lista de
 * autorizados cambio, lo que quedo guardado se descarta sin interpretar ni responder.
 */
@Injectable()
export class TelegramService implements OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private running = false;
  private loop: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private delivering = false;
  /** Espera de reintento por chat, tras un fallo de procesamiento. */
  private readonly backoff = new Map<string, ChatBackoff>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly transactions: TransactionRunner,
    private readonly commands: TelegramCommands,
    private readonly client: TelegramClient,
    private readonly settings: TelegramSettings,
  ) {}

  /** `true` solo con token, usuario y chat configurados. */
  get enabled(): boolean {
    return this.settings.enabled;
  }

  /** `true` si hay configuracion parcial: el bot queda desactivado. */
  get partial(): boolean {
    return this.settings.partial;
  }

  /** Arranca el sondeo. No bloquea: el ciclo corre en segundo plano. */
  async start(): Promise<void> {
    if (!this.enabled || this.running) {
      return;
    }
    this.running = true;
    this.abort = new AbortController();
    // El ciclo nunca rechaza: un fallo inesperado lo detiene sin tumbar el proceso.
    this.loop = this.run().catch((error: unknown) => {
      this.running = false;
      this.logger.warn(`El ciclo del bot se detuvo (${reasonOf(error)}).`);
    });
  }

  /** Detiene el sondeo y espera a que el ciclo termine. */
  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    const loop = this.loop;
    this.loop = null;
    if (loop) {
      await loop;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  private async run(): Promise<void> {
    let pollFailures = 0;
    let batchFailures = 0;
    while (this.running) {
      // La limpieza de lo revocado va antes de procesar: mientras no se haya
      // logrado, no se procesa nada (tampoco se confirma ningun borrador).
      const cleaned = await this.cleanRevokedWork();
      await this.resumePending(cleaned);
      await this.deliverPending();

      let updates: TelegramUpdate[];
      try {
        updates = await this.poll();
      } catch (error) {
        if (!this.running) {
          break;
        }
        pollFailures = Math.min(pollFailures + 1, MAX_ATTEMPTS);
        this.logger.warn(
          `No se pudo consultar Telegram (${reasonOf(error)}). Reintento con espera.`,
        );
        await this.sleep(backoffMs(pollFailures));
        continue;
      }
      pollFailures = 0;

      for (const update of updates) {
        if (!this.running) {
          break;
        }
        try {
          await this.handle(update);
        } catch (error) {
          // La actualizacion no se pudo guardar: se deja pendiente y **se corta el
          // lote**: el cursor no puede avanzar mas alla de una actualizacion que no
          // se pudo atender.
          batchFailures = Math.min(batchFailures + 1, MAX_ATTEMPTS);
          this.logger.warn(
            `No se pudo guardar una actualizacion de Telegram (${reasonOf(error)}). Se reintentara.`,
          );
          await this.sleep(backoffMs(batchFailures));
          break;
        }
        batchFailures = 0;
      }

      // Lo que se acaba de aceptar se procesa ya, sin esperar al siguiente ciclo.
      await this.resumePending(cleaned);
      await this.deliverPending();
      if (updates.length === 0) {
        await this.sleep(POLL_IDLE_MS);
      }
    }
  }

  /** Consulta las actualizaciones posteriores al cursor. */
  private async poll(): Promise<TelegramUpdate[]> {
    const cursor = await this.dataSource.getRepository(TelegramCursor).findOneBy({
      id: POLLING_CURSOR_ID,
    });
    const offset = (cursor?.lastUpdateId ?? 0) + 1;
    return this.client.getUpdates(offset, this.settings.pollTimeoutSeconds, this.abort?.signal);
  }

  /**
   * Descarta, de forma durable y en una sola transaccion, el trabajo pendiente que ya
   * no esta autorizado: la actualizacion aceptada, la respuesta pendiente y el
   * borrador vivo cuya origen en Telegram ya no esta autorizado. Los movimientos ya
   * registrados y el historial de eventos **no** se tocan: no se borra nada de lo que
   * ya ocurrio.
   *
   * Devuelve `false` si la limpieza no se pudo hacer: hasta que se logre, no se
   * procesa nada (no se puede saber que trabajo sigue autorizado).
   */
  private async cleanRevokedWork(): Promise<boolean> {
    try {
      await this.transactions.run(async (manager) => {
        const inbox = manager.getRepository(TelegramInbox);
        const outbox = manager.getRepository(TelegramOutbox);

        const accepted = await inbox.find({ where: { state: 'accepted' } });
        for (const row of accepted) {
          if (this.isAllowed(row.chatId, row.userId)) {
            continue;
          }
          await inbox.update({ updateId: row.updateId }, { state: 'discarded', text: null });
        }

        const pending = await outbox.find({ where: { state: 'pending' } });
        for (const row of pending) {
          if (this.isAllowed(row.chatId, row.userId)) {
            continue;
          }
          await outbox.update(
            { id: row.id },
            { state: 'discarded', text: '', lastError: 'not_allowed', nextAttemptAt: 0 },
          );
        }

        await this.cancelUnauthorizedDrafts(manager, inbox);
      });
      return true;
    } catch (error) {
      this.logger.warn(
        `No se pudo limpiar el trabajo que ya no esta autorizado (${reasonOf(error)}).`,
      );
      return false;
    }
  }

  /**
   * Cancela el borrador vivo cuya **origen en Telegram** ya no esta autorizada: un
   * `/confirm` posterior no puede confirmar un borrador revocado.
   *
   * El origen se busca por la clave del borrador (`sourceKey`), que es estable y esta
   * ligada al evento que lo creo. Asi:
   *
   * - un borrador **nuevo** del usuario vigente no se cancela por las filas
   *   historicas de otro usuario del mismo chat;
   * - los borradores de **otros transportes** (sin evidencia de que vengan de
   *   Telegram) no se tocan.
   */
  private async cancelUnauthorizedDrafts(
    manager: EntityManager,
    inbox: Repository<TelegramInbox>,
  ): Promise<void> {
    const drafts = await manager.getRepository(Capture).find({
      where: { state: In(['awaiting_details', 'awaiting_confirmation']) },
    });
    for (const draft of drafts) {
      const rows = await inbox.find({ where: { chatId: draft.chatId } });
      const origin = rows.find(
        (row) => sourceKeyFor(row.chatId, telegramEventId(row.updateId)) === draft.sourceKey,
      );
      if (!origin) {
        // Sin evidencia de que este borrador venga de Telegram: no se toca.
        continue;
      }
      if (this.isAllowed(origin.chatId, origin.userId)) {
        continue;
      }
      await manager
        .getRepository(Capture)
        .update({ id: draft.id }, { state: 'cancelled', sourceText: null });
    }
  }

  /**
   * Procesa lo pendiente, en el orden durable de las actualizaciones. Es la **unica**
   * via de procesamiento: nada se procesa fuera de aqui, de modo que el orden de lo
   * aceptado se respeta siempre y un `/confirm` nunca se aplica a un borrador
   * anterior a una correccion pendiente.
   *
   * `canProcess` es `false` mientras la limpieza de lo revocado no se haya logrado:
   * entonces no se procesa nada.
   */
  private async resumePending(canProcess: boolean): Promise<void> {
    if (!canProcess) {
      return;
    }
    let pending: TelegramInbox[];
    try {
      pending = await this.dataSource.getRepository(TelegramInbox).find({
        where: { state: 'accepted' },
        order: { updateId: 'ASC' },
      });
    } catch (error) {
      // Sin la lectura no se sabe que hay pendiente: no se procesa nada nuevo.
      this.logger.warn(`No se pudo leer la bandeja de entrada (${reasonOf(error)}).`);
      return;
    }
    /** Chats con una actualizacion anterior sin superar en esta pasada. */
    const blocked = new Set<string>();
    for (const row of pending) {
      if (!this.running) {
        return;
      }
      if (blocked.has(row.chatId)) {
        // Hay trabajo anterior de este chat sin superar: nada mas de este chat se
        // procesa hasta que se recupere.
        continue;
      }
      if (!(await this.processAccepted(row.updateId, row.chatId))) {
        blocked.add(row.chatId);
      }
    }
  }

  /**
   * Atiende una actualizacion. Lo que no está autorizado se ignora de forma durable
   * (el cursor avanza); lo autorizado se acepta en la bandeja de entrada.
   *
   * Aqui **no** se procesa nada: el procesamiento sale de la lectura ordenada de lo
   * pendiente, para que el orden durable se respete siempre.
   */
  private async handle(update: TelegramUpdate): Promise<void> {
    const accepted = this.authorize(update);
    if (!accepted) {
      await this.advanceCursor(update.updateId);
      return;
    }
    // La aceptacion es durable: si falla, el lote se corta y el cursor no avanza.
    await this.accept(update.updateId, accepted);
  }

  /**
   * Autorizacion: chat privado, chat autorizado y usuario autorizado. Se decide antes
   * de guardar el texto, antes de interpretar y antes de responder.
   */
  private authorize(update: TelegramUpdate): AcceptedMessage | null {
    const message = update.message;
    if (!message) {
      return null;
    }
    if (message.chatType !== 'private') {
      return null;
    }
    if (!message.userId || !this.isAllowed(message.chatId, message.userId)) {
      return null;
    }
    if (message.isBot) {
      return null;
    }
    if (message.text === null) {
      return null;
    }
    return {
      chatId: message.chatId,
      userId: message.userId,
      text: message.text.slice(0, MAX_INBOX_TEXT_LENGTH),
      receivedAt: message.receivedAt,
    };
  }

  /** `true` si el chat y el usuario estan autorizados **con la configuracion vigente**. */
  private isAllowed(chatId: string, userId: string): boolean {
    return (
      chatId === String(this.settings.allowedChatId) &&
      userId === String(this.settings.allowedUserId)
    );
  }

  /** Guarda la actualizacion aceptada y avanza el cursor, en una sola transaccion. */
  private async accept(updateId: number, accepted: AcceptedMessage): Promise<void> {
    await this.transactions.run(async (manager) => {
      const inbox = manager.getRepository(TelegramInbox);
      const existing = await inbox.findOneBy({ updateId });
      if (!existing) {
        await inbox.save(
          inbox.create({
            updateId,
            chatId: accepted.chatId,
            userId: accepted.userId,
            text: accepted.text,
            receivedAt: accepted.receivedAt,
            state: 'accepted',
          }),
        );
      }
      await this.advanceCursorWith(manager, updateId);
    });
  }

  /** Avanza el cursor del polling: nunca retrocede. */
  private async advanceCursor(updateId: number): Promise<void> {
    await this.transactions.run(async (manager) => {
      await this.advanceCursorWith(manager, updateId);
    });
  }

  private async advanceCursorWith(manager: EntityManager, updateId: number): Promise<void> {
    const repository = manager.getRepository(TelegramCursor);
    const cursor =
      (await repository.findOneBy({ id: POLLING_CURSOR_ID })) ??
      repository.create({ id: POLLING_CURSOR_ID, lastUpdateId: 0 });
    if (updateId > cursor.lastUpdateId) {
      cursor.lastUpdateId = updateId;
      await repository.save(cursor);
    }
  }

  /**
   * Procesa una actualizacion aceptada: responde y deja la respuesta en la bandeja de
   * salida. Si el proceso se interrumpe antes, la actualizacion sigue pendiente y al
   * arrancar se vuelve a procesar: la captura es idempotente, asi que no se duplica
   * ningun movimiento.
   */
  private async process(updateId: number): Promise<void> {
    const inbox = this.dataSource.getRepository(TelegramInbox);
    const row = await inbox.findOneBy({ updateId });
    if (!row || row.state !== 'accepted') {
      return;
    }
    if (!this.isAllowed(row.chatId, row.userId)) {
      // La lista vigente ya no autoriza a ese chat o a ese usuario: el mensaje se
      // borra sin interpretarlo y sin responder.
      await inbox.update({ updateId }, { state: 'discarded', text: null });
      return;
    }
    const reply = await this.commands.answer({
      eventId: telegramEventId(updateId),
      chatId: row.chatId,
      text: row.text ?? '',
      receivedAt: row.receivedAt,
    });
    await this.transactions.run(async (manager) => {
      const outbox = manager.getRepository(TelegramOutbox);
      const existing = await outbox.findOneBy({ updateId });
      if (!existing) {
        await outbox.save(
          outbox.create({
            updateId,
            chatId: row.chatId,
            userId: row.userId,
            text: reply,
            state: 'pending',
            attempts: 0,
            nextAttemptAt: 0,
            lastError: null,
          }),
        );
      }
      await manager.getRepository(TelegramInbox).update({ updateId }, { state: 'done', text: null });
    });
  }

  /**
   * Procesa una actualizacion aislando el fallo: si no se puede procesar, la
   * actualizacion se conserva y su chat espera un rato acotado antes de volver a
   * intentarlo. El ciclo sigue: se sigue sondeando, aceptando y entregando.
   *
   * Devuelve `false` si la actualizacion no se pudo procesar (o todavia no toca
   * reintentarla): el chat queda bloqueado para el resto de la pasada.
   */
  private async processAccepted(updateId: number, chatId: string): Promise<boolean> {
    const wait = this.backoff.get(chatId);
    if (wait && wait.nextAttemptAt > Date.now()) {
      // Todavia no toca reintentar este chat.
      return false;
    }
    try {
      await this.process(updateId);
      this.backoff.delete(chatId);
      return true;
    } catch (error) {
      const attempts = Math.min((wait?.attempts ?? 0) + 1, MAX_ATTEMPTS);
      this.backoff.set(chatId, {
        attempts,
        nextAttemptAt: Date.now() + backoffMs(attempts),
      });
      this.logger.warn(
        `No se pudo procesar la actualizacion ${updateId} de Telegram (${reasonOf(error)}). Su chat queda bloqueado hasta que se recupere.`,
      );
      return false;
    }
  }

  /**
   * Envia las respuestas pendientes. Un envio fallido se reintenta mas tarde, con
   * espera acotada y **sin perder la respuesta**: la entrega queda pendiente y el
   * siguiente intento no puede adelantarse a su hora. El envio es "al menos una vez":
   * una interrupcion puede repetir una respuesta, pero nunca duplica un movimiento.
   *
   * Las respuestas de un chat se envian **en orden**: si una anterior esta retrasada o
   * falla de forma transitoria, las siguientes de ese chat esperan su turno.
   */
  private async deliverPending(): Promise<void> {
    if (this.delivering || !this.running) {
      return;
    }
    this.delivering = true;
    try {
      const outbox = this.dataSource.getRepository(TelegramOutbox);
      const pending = await outbox.find({
        where: { state: 'pending' },
        order: { updateId: 'ASC' },
      });
      /** Chats con una entrega anterior que todavia no esta resuelta. */
      const waiting = new Set<string>();
      for (const row of pending) {
        if (!this.running) {
          return;
        }
        if (!this.isAllowed(row.chatId, row.userId)) {
          // Lo que ya no esta autorizado se descarta **antes** de mirar el plazo:
          // su texto no se queda pendiente.
          await outbox.update(
            { id: row.id },
            { state: 'discarded', text: '', lastError: 'not_allowed', nextAttemptAt: 0 },
          );
          continue;
        }
        if (waiting.has(row.chatId)) {
          // Hay una respuesta anterior de este chat sin entregar: no se adelanta.
          continue;
        }
        if (row.nextAttemptAt > Date.now()) {
          // Todavia no toca reintentar: el retraso se respeta entre vueltas y
          // tambien despues de un reinicio.
          waiting.add(row.chatId);
          continue;
        }
        try {
          await this.client.sendMessage(row.chatId, row.text, this.abort?.signal);
          await outbox.update({ id: row.id }, { state: 'sent', lastError: null, nextAttemptAt: 0 });
        } catch (error) {
          const attempts = Math.min(row.attempts + 1, MAX_ATTEMPTS);
          const permanent = isPermanentFailure(error);
          await outbox.update(
            { id: row.id },
            {
              state: permanent ? 'discarded' : 'pending',
              // Un discarded ya no guarda la respuesta: el texto se vacia.
              text: permanent ? '' : row.text,
              attempts,
              lastError: reasonOf(error),
              nextAttemptAt: Date.now() + backoffMs(attempts),
            },
          );
          if (!permanent) {
            // La respuesta sigue pendiente: las siguientes de este chat esperan.
            waiting.add(row.chatId);
          }
          this.logger.warn(
            `No se pudo enviar una respuesta de Telegram (${reasonOf(error)}). ${
              permanent ? 'Se descarta.' : 'Se reintentara.'
            }`,
          );
        }
      }
    } catch (error) {
      // Un fallo de la base no puede tumbar el ciclo: se reintenta en la vuelta
      // siguiente.
      this.logger.warn(`No se pudo revisar la bandeja de salida (${reasonOf(error)}).`);
    } finally {
      this.delivering = false;
    }
  }

  /** Espera que se corta en cuanto el bot se detiene. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.abort?.signal;
      if (signal?.aborted) {
        // El bot ya esta detenido: no se espera nada.
        resolve();
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** Espera acotada entre reintentos: nunca se desborda y nunca pasa del tope. */
function backoffMs(attempts: number): number {
  const step = Math.min(Math.max(Math.trunc(attempts), 1), MAX_BACKOFF_STEP);
  return Math.min(BACKOFF_BASE_MS * 2 ** (step - 1), BACKOFF_MAX_MS);
}

/** Motivo del fallo, sin detalle: nunca contiene la credencial ni el mensaje. */
function reasonOf(error: unknown): string {
  return error instanceof TelegramError ? error.reason : 'error';
}

/**
 * `true` si el fallo no se puede recuperar: Telegram rechazo la peticion (4xx que no
 * son 408 ni 429). Un fallo de red o de plazo **si** se puede recuperar y la
 * respuesta sigue pendiente.
 */
function isPermanentFailure(error: unknown): boolean {
  if (!(error instanceof TelegramError) || error.reason !== 'http') {
    return false;
  }
  const status = error.status;
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}
