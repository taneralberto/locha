import {
  And,
  DataSource,
  EntityManager,
  LessThan,
  LessThanOrEqual,
  MoreThanOrEqual,
} from 'typeorm';
import { TelegramHistory, TelegramHistoryRole } from './telegram-history.entity';

/**
 * Ventana del historial: **una hora**, medida desde el instante de cada mensaje.
 *
 * No es una hora de inactividad: el chat puede seguir vivo todo el tiempo, pero un
 * mensaje de hace mas de una hora queda fuera de la ventana igual. La ventana es
 * estricta y se mira hacia atras desde el momento de la lectura o de la purga.
 */
export const TELEGRAM_HISTORY_WINDOW_MS = 60 * 60 * 1000;

/**
 * `true` si el instante del mensaje sigue dentro de la ventana.
 *
 * La ventana es exactamente `[now - 1h, now]`: un mensaje mas viejo que la ventana
 * queda fuera y un instante futuro tambien (un desfase del reloj no amplia la
 * ventana).
 */
export function isWithinHistoryWindow(sentAt: number, now: number): boolean {
  return sentAt >= now - TELEGRAM_HISTORY_WINDOW_MS && sentAt <= now;
}

/**
 * `true` si el instante ya es mas viejo que la ventana.
 *
 * Es el criterio de **antiguedad** solamente: no mira el futuro. Se usa para la
 * escritura de una entrega **ya confirmada** por Telegram, donde un reloj que
 * retrocede un instante no puede hacer que la respuesta se pierda: la fila se guarda
 * con su instante original y la **lectura** (que si mira el futuro) la oculta hasta
 * que el reloj se recupere.
 */
export function isOlderThanHistoryWindow(sentAt: number, now: number): boolean {
  return sentAt < now - TELEGRAM_HISTORY_WINDOW_MS;
}

/** Una entrada del historial, lista para una consulta. */
export interface TelegramHistoryEntry {
  /** Actualizacion de Telegram de la que viene la entrada. */
  updateId: number;
  /** Quien escribio el texto. */
  role: TelegramHistoryRole;
  /** Texto original del usuario o respuesta exacta del bot. */
  text: string;
  /** Instante del mensaje, en milisegundos desde epoch. */
  sentAt: number;
}

/** Lo que se guarda de un mensaje. */
export interface TelegramHistoryRecord {
  updateId: number;
  chatId: string;
  userId: string;
  /** Texto tal como se recibio o salio, sin recortar. */
  text: string;
  /** Instante del mensaje, en milisegundos desde epoch. */
  sentAt: number;
}

/**
 * Guardado del historial temporal de Telegram.
 *
 * Es una clase ordinaria con **una sola dependencia** (la conexion): escribe y lee
 * una sola tabla, la del historial. No conoce el ciclo del bot ni decide que se
 * guarda: eso lo decide quien la usa (la aceptacion y la entrega).
 *
 * La escritura es **idempotente**: la clave es la actualizacion y el rol, asi que un
 * reintento o una repeticion no dejan dos textos del mismo mensaje.
 */
export class TelegramHistoryStore {
  constructor(private readonly dataSource: DataSource) {}

  /** Guarda el texto del usuario. Una fila por actualizacion. */
  async recordUser(manager: EntityManager, record: TelegramHistoryRecord): Promise<void> {
    await this.record(manager, 'user', record);
  }

  /** Guarda la respuesta del bot. Una fila por actualizacion. */
  async recordBot(manager: EntityManager, record: TelegramHistoryRecord): Promise<void> {
    await this.record(manager, 'bot', record);
  }

  /**
   * Guarda una entrada. Si ya hay una fila de esa actualizacion y ese rol, **no se
   * escribe otra**: la repeticion no duplica nada.
   */
  private async record(
    manager: EntityManager,
    role: TelegramHistoryRole,
    record: TelegramHistoryRecord,
  ): Promise<void> {
    await manager
      .getRepository(TelegramHistory)
      .createQueryBuilder()
      .insert()
      .values({
        updateId: record.updateId,
        role,
        chatId: record.chatId,
        userId: record.userId,
        text: record.text,
        sentAt: record.sentAt,
      })
      .orIgnore()
      .execute();
  }

  /**
   * Purga lo que ya no sirve: lo que se salio de la ventana y lo que pertenece a un
   * chat o a un usuario que ya no estan autorizados.
   *
   * Es una operacion **durable y aparte**: no toca la bandeja de entrada, la de salida
   * ni los borradores, y no reescribe nada de lo que ya ocurrio.
   *
   * Solo se borra por **edad** y por **autorizacion**: una fila con un instante
   * futuro (un reloj que retrocede) no se borra, porque puede volver a estar en
   * ventana cuando el reloj se recupere.
   */
  async purge(authorized: { chatId: string; userId: string }, now: number): Promise<number> {
    const result = await this.dataSource
      .getRepository(TelegramHistory)
      .createQueryBuilder()
      .delete()
      .from(TelegramHistory)
      .where('sentAt < :expiry', { expiry: now - TELEGRAM_HISTORY_WINDOW_MS })
      .orWhere('chatId <> :chatId', { chatId: authorized.chatId })
      .orWhere('userId <> :userId', { userId: authorized.userId })
      .execute();
    return result.affected ?? 0;
  }

  /**
   * Lee el historial de un sujeto (su chat y su usuario) para una consulta.
   *
   * - Solo devuelve lo de **ese** chat y **ese** usuario: lo de otro no se lee.
   * - Solo devuelve lo anterior a `beforeUpdateId`: la actualizacion actual y las
   *   siguientes quedan fuera, tambien las que ya estan en la bandeja de entrada.
   * - Aplica el filtro de la ventana **al leer**, aunque la purga no se haya podido
   *   hacer: lo que quedo en la base no se ve si ya se salio de la ventana, y un
   *   instante futuro tampoco (un desfase del reloj no amplia la ventana).
   * - El orden es estable: primero el tiempo real del mensaje y, a igualdad, la
   *   actualizacion y el rol (el texto del usuario antes que la respuesta del bot).
   *
   * No pagina ni recorta: devuelve todo lo que hay en la ventana.
   */
  async read(
    subject: { chatId: string; userId: string; beforeUpdateId: number },
    now: number,
  ): Promise<TelegramHistoryEntry[]> {
    const rows = await this.dataSource.getRepository(TelegramHistory).find({
      where: {
        chatId: subject.chatId,
        userId: subject.userId,
        updateId: LessThan(subject.beforeUpdateId),
        sentAt: And(
          MoreThanOrEqual(now - TELEGRAM_HISTORY_WINDOW_MS),
          LessThanOrEqual(now),
        ),
      },
      order: { sentAt: 'ASC', updateId: 'ASC' },
    });
    return rows
      .map((row) => ({
        updateId: row.updateId,
        role: row.role,
        text: row.text,
        sentAt: row.sentAt,
      }))
      .sort(compareEntries);
  }
}

/** Orden estable del historial: tiempo real y, a igualdad, actualizacion y rol. */
function compareEntries(left: TelegramHistoryEntry, right: TelegramHistoryEntry): number {
  if (left.sentAt !== right.sentAt) {
    return left.sentAt - right.sentAt;
  }
  if (left.updateId !== right.updateId) {
    return left.updateId - right.updateId;
  }
  return roleOrder(left.role) - roleOrder(right.role);
}

/** El texto del usuario va antes que la respuesta del bot del mismo mensaje. */
function roleOrder(role: TelegramHistoryRole): number {
  return role === 'user' ? 0 : 1;
}
