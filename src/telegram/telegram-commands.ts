import { Injectable } from '@nestjs/common';
import { AccountService } from '../accounts/account.service';
import { CaptureService } from '../capture/capture.service';
import { DEFAULT_TIME_ZONE } from '../capture/inference-budget.service';
import { dateInTimeZone, parseMonth } from '../domain/date';
import { ValidationError } from '../domain/errors';
import { formatAmount } from '../domain/money';
import { FinancialService } from '../financial/financial.service';

/** Limite de Telegram para un mensaje de texto. */
export const MAX_REPLY_LENGTH = 4096;

/** Movimientos que muestra `/recent`. */
const RECENT_LIMIT = 10;

/** Longitud de la descripcion en la lista de movimientos. */
const MAX_DESCRIPTION_LENGTH = 40;

const HELP_TEXT = [
  'Comandos disponibles:',
  '  /help o /start   Muestra esta ayuda',
  '  /accounts        Lista tus cuentas',
  '  /recent          Lista los ultimos movimientos',
  '  /summary         Totales del mes actual (o /summary YYYY-MM)',
  '  /confirm         Registra la operacion que te mostre',
  '  /cancel          Descarta la operacion pendiente',
  '',
  'Tambien puedes escribir un gasto o un ingreso en palabras:',
  'el bot te muestra un resumen y tu lo confirmas con /confirm.',
].join('\n');

export interface CommandRequest {
  /** Identidad estable del evento en Telegram. */
  eventId: string;
  chatId: string;
  text: string;
  receivedAt: string;
}

interface ParsedCommand {
  name: string;
  argument: string;
}

/**
 * Comandos deterministas del bot. Las consultas (`/accounts`, `/recent`, `/summary`)
 * se calculan con los datos guardados: **nunca** llaman al modelo. Solo `/confirm` y
 * `/cancel` van a la captura, que tambien los resuelve sin llamar al modelo.
 */
@Injectable()
export class TelegramCommands {
  constructor(
    private readonly capture: CaptureService,
    private readonly financial: FinancialService,
    private readonly accounts: AccountService,
  ) {}

  /** Responde a un mensaje autorizado. */
  async answer(request: CommandRequest): Promise<string> {
    const command = parseCommand(request.text);
    if (command === null) {
      return this.fromCapture(request);
    }
    switch (command.name) {
      case 'help':
      case 'start':
        return HELP_TEXT;
      case 'accounts':
        return this.accountsReply();
      case 'recent':
        return this.recentReply();
      case 'summary':
        return this.summaryReply(command.argument);
      case 'confirm':
      case 'cancel':
        return this.fromCapture(request);
      default:
        // Un comando desconocido no se interpreta: se muestra la ayuda.
        return HELP_TEXT;
    }
  }

  /** Pasa el mensaje a la captura durable y agrega el id del movimiento registrado. */
  private async fromCapture(request: CommandRequest): Promise<string> {
    const outcome = await this.capture.handle({
      eventId: request.eventId,
      chatId: request.chatId,
      text: request.text,
      receivedAt: request.receivedAt,
    });
    const movement = outcome.movementId ? `\n\nMovimiento: ${outcome.movementId}` : '';
    return clamp(`${outcome.reply}${movement}`);
  }

  private async accountsReply(): Promise<string> {
    const accounts = await this.accounts.list();
    if (accounts.length === 0) {
      return 'No hay cuentas registradas. Crea una con: npm run account:add -- --name Efectivo --currency USD';
    }
    const lines = accounts.map(
      (account) =>
        `  ${account.id} | ${account.name} | ${account.currency} | ${account.active ? 'activa' : 'inactiva'}`,
    );
    return ['Tus cuentas:', ...lines].join('\n');
  }

  private async recentReply(): Promise<string> {
    const movements = await this.financial.recent(RECENT_LIMIT);
    if (movements.length === 0) {
      return 'Todavia no hay movimientos registrados.';
    }
    const accounts = await this.accounts.list();
    const names = new Map(accounts.map((account) => [account.id, account.name]));
    const lines = movements.map((movement) => {
      const account = names.get(movement.accountId) ?? movement.accountId;
      const kind = movement.kind === 'income' ? 'ingreso' : 'gasto';
      const description =
        movement.description && movement.description.length > 0
          ? ` | ${movement.description.slice(0, MAX_DESCRIPTION_LENGTH)}`
          : '';
      return `  ${movement.occurredOn} | ${kind} | ${formatAmount(movement.amountMinor, movement.currency)} ${movement.currency} | ${account} | id ${movement.id}${description}`;
    });
    return ['Movimientos recientes:', ...lines].join('\n');
  }

  private async summaryReply(argument: string): Promise<string> {
    let month: string;
    try {
      month = argument.length > 0 ? parseMonth(argument) : currentMonth();
    } catch (error) {
      const detail = error instanceof ValidationError ? error.message : 'Mes invalido.';
      return `${detail}\nUsa /summary YYYY-MM (por ejemplo, /summary 2026-11).`;
    }
    const totals = await this.financial.summary(month);
    const active = totals.filter((entry) => entry.income !== 0n || entry.expense !== 0n);
    if (active.length === 0) {
      return [
        `No hay movimientos registrados en ${month}.`,
        'Estos son totales de la actividad registrada; no son el saldo de tus cuentas.',
      ].join('\n');
    }
    const lines = active.map(
      (entry) =>
        `  ${entry.currency}: ingresos ${formatAmount(entry.income, entry.currency)}, gastos ${formatAmount(entry.expense, entry.currency)}, neto ${formatAmount(entry.net, entry.currency)}`,
    );
    return [
      `Totales de ${month} (actividad registrada):`,
      ...lines,
      'Estos son totales de los movimientos registrados del mes; no son el saldo de tus cuentas.',
    ].join('\n');
  }
}

/** `/comando argumento`. Devuelve `null` si el texto no es un comando. */
function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }
  const [head, ...rest] = trimmed.split(/\s+/);
  if (head === undefined) {
    return null;
  }
  // El sufijo "@nombre_del_bot" se ignora: Telegram lo anade en grupos.
  const name = (head.split('@')[0] ?? '').replace(/^\/+/, '').toLowerCase();
  if (name.length === 0) {
    return null;
  }
  return { name, argument: rest.join(' ') };
}

/** Mes actual en la zona del usuario, en formato `YYYY-MM`. */
function currentMonth(): string {
  return dateInTimeZone(new Date(), DEFAULT_TIME_ZONE).slice(0, 7);
}

/** Recorta la respuesta al limite de Telegram. */
function clamp(text: string): string {
  if (text.length <= MAX_REPLY_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_REPLY_LENGTH - 1)}…`;
}
