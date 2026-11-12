import { Injectable } from '@nestjs/common';
import { Account } from '../accounts/account.entity';
import { AccountService } from '../accounts/account.service';
import { BudgetService } from '../budgets/budget.service';
import { debtReportRow, DEBT_CLI_FALLBACK, formatDebtReport } from '../debts/debt-format';
import { canonicalName, DebtService } from '../debts/debt.service';
import { SavingsService } from '../savings/savings.service';
import { formatGoalStatus, formatSavingsStatus } from '../savings/savings-format';
import { CaptureService } from '../capture/capture.service';
import { DEFAULT_TIME_ZONE, InferenceBudgetService } from '../capture/inference-budget.service';
import { AiLimits } from '../config/configuration';
import { dateInTimeZone, parseDate, parseMonth } from '../domain/date';
import { NotFoundError, ValidationError } from '../domain/errors';
import { formatAmount, Currency } from '../domain/money';
import { boundedLines } from '../domain/bounded-text';
import { BalanceReconciliation } from '../financial/balance-reconciliation.entity';
import { FinancialService, MovementHistory } from '../financial/financial.service';
import { Movement } from '../financial/movement.entity';
import { MovementRevision } from '../financial/movement-revision.entity';
import { sanitizeTelegramText } from './bot-text';

/** Limite de Telegram para un mensaje de texto. */
export const MAX_REPLY_LENGTH = 4096;

/** Movimientos que muestra `/recent`. */
const RECENT_LIMIT = 10;

/** Longitud de la descripcion en la lista de movimientos. */
const MAX_DESCRIPTION_LENGTH = 40;

/**
 * El allowance local no es la factura del proveedor: la respuesta lo dice de forma
 * explicita para que nadie lo lea como un consumo real.
 */
const USAGE_LEGEND = 'Reserva local conservadora; no es la factura real del proveedor.';

const HELP_TEXT = [
  'Comandos disponibles:',
  '  /help o /start   Muestra esta ayuda',
  '  /accounts        Lista tus cuentas',
  '  /balances        Saldos a hoy (o /balances YYYY-MM-DD)',
  '  /budgets [YYYY-MM-DD]   Presupuestos activos (solo lectura)',
  '  /goals [nombre]  Metas y progreso nominal actual (solo lectura)',
  '  /savings         Reservas y disponibles actuales (solo lectura)',
  '  Metas y reservas se crean/liberan solo por CLI, no por lenguaje natural.',
  '  /recent          Lista los ultimos movimientos',
  '  /movement [ultimo]   Original y estado efectivo (solo lectura)',
  '  /history [ultimo]    Historial auditado (solo lectura)',
  '  /reconciliations [cuenta]   Conciliaciones (solo lectura)',
  '  /debts [persona] Deudas registradas y su pendiente (solo lectura)',
  '  Correcciones y conciliaciones: CLI; no se escriben desde Telegram.',
  '  Las deudas se crean y se pagan escribiendo en lenguaje natural.',
  '  /summary         Totales del mes actual (o /summary YYYY-MM)',
  '  /usage           Consumo reservado de inferencia del dia',
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
 * Comandos deterministas del bot. Las consultas (`/accounts`, `/recent`, `/summary`,
 * `/balances`, `/budgets`, `/usage`) se calculan con los datos guardados: **nunca** llaman al modelo. Solo
 * `/confirm` y `/cancel` van a la captura, que tambien los resuelve sin llamar al
 * modelo.
 *
 * Las respuestas del bot muestran **nombres, fechas, importes y estados**: los
 * identificadores tecnicos son de la CLI. Lo que sale de aqui pasa por `sanitizeTelegramText`,
 * que tampoco deja pasar un id que venga de una respuesta guardada antes.
 */
@Injectable()
export class TelegramCommands {
  constructor(
    private readonly capture: CaptureService,
    private readonly financial: FinancialService,
    private readonly accounts: AccountService,
    private readonly budget: InferenceBudgetService,
    private readonly limits: AiLimits,
    private readonly budgets: BudgetService,
    private readonly savings: SavingsService,
    private readonly debts: DebtService,
  ) {}

  /** Responde a un mensaje autorizado. */
  async answer(request: CommandRequest): Promise<string> {
    return sanitizeTelegramText(await this.reply(request));
  }

  private async reply(request: CommandRequest): Promise<string> {
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
      case 'balances':
        return this.balancesReply(command.argument);
      case 'budgets':
        return this.budgetsReply(command.argument);
      case 'goals':
        return this.goalsReply(command.argument);
      case 'savings':
        return this.savingsReply(command.argument);
      case 'debts':
        return this.debtsReply(command.argument);
      case 'recent':
        return this.recentReply();
      case 'movement':
      case 'history':
        return this.movementReply(command.argument, command.name);
      case 'reconciliations':
        return this.reconciliationsReply(command.argument);
      case 'summary':
        return this.summaryReply(command.argument);
      case 'usage':
        return this.usageReply();
      case 'confirm':
      case 'cancel':
        return this.fromCapture(request);
      default:
        // Un comando desconocido no se interpreta: se muestra la ayuda.
        return HELP_TEXT;
    }
  }

  /** Pasa el mensaje a la captura durable. */
  private async fromCapture(request: CommandRequest): Promise<string> {
    const outcome = await this.capture.handle({
      eventId: request.eventId,
      chatId: request.chatId,
      text: request.text,
      receivedAt: request.receivedAt,
    });
    const reply = outcome.reply;
    // Diagnostico actual de entrega; el resultado durable de captura no se modifica.
    if (outcome.movementId) {
      const warnings = await this.savings.warnings({ names: true });
      if (warnings.length > 0) {
        const detailed = [reply, ...warnings].join('\n\n');
        if (detailed.length <= MAX_REPLY_LENGTH) return detailed;
        const diagnostic = '\n\nADVERTENCIA: revisa deficits actuales en /savings; reservas preservadas; detalle omitido por el limite de Telegram.';
        return `${clamp(reply, MAX_REPLY_LENGTH - diagnostic.length)}${diagnostic}`;
      }
    }
    return clamp(reply);
  }

  private async accountsReply(): Promise<string> {
    const accounts = await this.accounts.list();
    if (accounts.length === 0) {
      return 'No hay cuentas registradas. Crea una con: npm run account:add -- --name Efectivo --currency USD';
    }
    const lines = accounts.map(
      (account) => `  ${account.name} | ${account.currency} | ${account.active ? 'activa' : 'inactiva'}`,
    );
    return ['Tus cuentas:', ...lines].join('\n');
  }

  private async recentReply(): Promise<string> {
    const movements = await this.financial.recent(RECENT_LIMIT);
    if (movements.length === 0) {
      return 'Todavia no hay movimientos registrados.';
    }
    const names = await this.accountNames();
    const lines = movements.map((movement) => {
      const account = names.get(movement.accountId) ?? '(cuenta desconocida)';
      const kind = movement.kind === 'income' ? 'ingreso' : 'gasto';
      const description =
        movement.description && movement.description.length > 0
          ? ` | ${movement.description.slice(0, MAX_DESCRIPTION_LENGTH)}`
          : '';
      const category = movement.category === null ? '' : ` | categoria ${movement.category}`;
      return `  ${movement.occurredOn} | ${kind} | ${formatAmount(movement.amountMinor, movement.currency)} ${movement.currency} | ${account}${description}${category}`;
    });
    return boundedLines(['Movimientos recientes:', ...lines], MAX_REPLY_LENGTH, 'Usa CLI movement:recent para el detalle completo.');
  }

  /**
   * Original y estado efectivo de un movimiento. Por defecto, el ultimo: el usuario no
   * necesita ids. Un id escrito sigue funcionando (es lo que usaba antes), pero no se
   * muestra en la respuesta.
   */
  private async movementReply(argument: string, command: string): Promise<string> {
    const asked = argument.trim();
    if (/\s/.test(asked)) return `Usa /${command} [ultimo].`;
    let history: MovementHistory;
    try {
      history = await this.financial.movementHistory(await this.movementId(asked));
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ValidationError) {
        return `No hay ningun movimiento con ese dato.\nUsa /${command} [ultimo].`;
      }
      throw error;
    }
    const names = await this.accountNames();
    const currency = history.original.currency;
    const lines = [
      'Movimiento (original, efectivo e historial):',
      `  Original: ${this.movementLine(history.original, names)}`,
      `  Efectivo: ${this.movementLine(history.effective, names, history.effective.category)} | revision ${history.effective.revision} | ${history.effective.voided ? 'anulado' : 'vigente'}`,
      `  Comision: ${history.feeOwner === null ? 'ninguna' : 'de una operacion de comision'}`,
      ...history.revisions.map((row) => `  Revision ${row.revision}: ${this.revisionLine(row, currency)}`),
    ];
    return boundedLines(lines, MAX_REPLY_LENGTH, 'Detalle completo: CLI movement:show o movement:history.');
  }

  /**
   * Una revision legible: que se hizo, cuando, con que importe, con que descripcion y
   * con que categoria, y por que. Una anulacion no tiene esos datos: solo el motivo.
   */
  private revisionLine(row: MovementRevision, currency: Currency): string {
    if (row.kind === 'void') {
      return `anulacion | motivo: ${row.reason}`;
    }
    return [
      'edicion',
      row.occurredOn ?? '(sin fecha)',
      row.amountMinor === null ? '(sin importe)' : `${formatAmount(row.amountMinor, currency)} ${currency}`,
      `descripcion: ${row.description ?? '(sin descripcion)'}`,
      `categoria: ${row.category ?? '(sin categoria)'}`,
      `motivo: ${row.reason}`,
    ].join(' | ');
  }

  /** El movimiento que se consulta: el ultimo, o el que el usuario escribe. */
  private async movementId(argument: string): Promise<string> {
    if (argument.length === 0 || argument.toLowerCase() === 'ultimo') {
      const [latest] = await this.financial.recent(1);
      if (!latest) {
        throw new NotFoundError('No hay movimientos registrados.');
      }
      return latest.id;
    }
    return argument;
  }

  private async reconciliationsReply(argument: string): Promise<string> {
    const asked = argument.trim();
    const accounts = await this.accounts.list();
    const names = new Map(accounts.map((account) => [account.id, account.name]));
    let rows: BalanceReconciliation[];
    try {
      if (asked.length > 0) {
        const found = this.findAccount(asked, accounts);
        if (found.ambiguous) {
          return `Hay varias cuentas con el nombre "${asked}". Indica el nombre exacto.`;
        }
        if (found.account === null) {
          return `No hay ninguna cuenta llamada "${asked}".\nUsa /reconciliations [cuenta].`;
        }
        rows = await this.financial.reconciliations(found.account.id);
      } else {
        rows = await this.financial.reconciliations();
      }
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ValidationError) {
        return `No hay ninguna conciliacion de esa cuenta.\nUsa /reconciliations [cuenta].`;
      }
      throw error;
    }
    const lines = ['Conciliaciones (delta fijo; actividad retroactiva puede causar deriva):'];
    if (rows.length === 0) lines.push('No hay conciliaciones.');
    for (const row of rows) {
      lines.push(`${row.occurredOn} | ${names.get(row.accountId) ?? '(cuenta desconocida)'} | ${row.currency} | objetivo ${formatAmount(row.targetMinor, row.currency)} | antes ${formatAmount(row.beforeMinor, row.currency)} | delta ${formatAmount(row.deltaMinor, row.currency)} | ${row.reason}`);
    }
    return boundedLines(lines, MAX_REPLY_LENGTH, 'Detalle completo: CLI reconciliation:list.');
  }

  private async budgetsReply(argument: string): Promise<string> {
    try {
      const on = argument ? parseDate(argument) : dateInTimeZone(new Date(), DEFAULT_TIME_ZONE);
      const rows = await this.budgets.status({ on });
      const lines = [`Presupuestos activos al ${on}:`];
      if (rows.length === 0) lines.push('No hay presupuestos activos.');
      for (const { budget, spent, remaining, overspent } of rows) {
        lines.push(`${budget.name} | ${budget.currency} | ${budget.category === null ? 'global' : `categoria ${budget.category}`} | ${budget.startsOn}..${budget.endsOn} | limite ${formatAmount(budget.limitMinor, budget.currency)} | gastado ${formatAmount(spent, budget.currency)} | restante ${formatAmount(remaining, budget.currency)}${overspent ? ' | excedido' : ''}`);
      }
      return boundedLines(lines, MAX_REPLY_LENGTH, 'Limites informativos, no saldo bancario; sin rollover. No sumar restantes entre alcances o monedas. Detalle: CLI budget:status.');
    } catch (error) {
      if (error instanceof ValidationError) return `${error.message}\nUsa /budgets [YYYY-MM-DD].`;
      throw error;
    }
  }

  private async balancesReply(argument: string): Promise<string> {
    let on: string;
    try {
      on = argument.length > 0 ? parseDate(argument) : dateInTimeZone(new Date(), DEFAULT_TIME_ZONE);
    } catch (error) {
      const detail = error instanceof ValidationError ? error.message : 'Fecha invalida.';
      return `${detail}\nUsa /balances YYYY-MM-DD.`;
    }
    const savingsRows = on === dateInTimeZone(new Date(), DEFAULT_TIME_ZONE) ? await this.savings.status() : null;
    const rows = savingsRows ?? await this.financial.balances(on);
    const current = savingsRows === null ? null : new Map(savingsRows.map((row) => [row.accountId, row]));
    const lines = [`Saldos al ${on} (${DEFAULT_TIME_ZONE}):`];
    if (savingsRows?.some((row) => row.deficit > 0n)) lines.push('ADVERTENCIA: hay cuentas deficitarias; reservas preservadas. Detalle completo: CLI savings:status.');
    if (rows.length === 0) {
      lines.push('No hay cuentas registradas.');
    }
    const legend = 'Aperturas aditivas; sin apertura el saldo puede estar incompleto. No se suman monedas distintas. ' +
      (current === null ? 'Reservas/disponibles solo actuales: /savings (no historicos).' : 'Reservas preservadas incluso con deficit; detalle actual: /savings.');
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const savings = current?.get(row.accountId);
      const line = `  ${row.name} | ${formatAmount(row.balance, row.currency)} ${row.currency} | apertura ${row.hasOpening ? 'si' : 'no'}` +
        (savings === undefined ? '' : ` | reservado ${formatAmount(savings.reserved, row.currency)} | disponible ${formatAmount(savings.available, row.currency)} | deficit ${formatAmount(savings.deficit, row.currency)}${savings.deficit > 0n ? ' | ADVERTENCIA' : ''}`);
      const remaining = `... ${rows.length - index} cuentas mas; usa balance:list en la CLI.`;
      if ([...lines, line, remaining, legend].join('\n').length > MAX_REPLY_LENGTH) {
        lines.push(remaining);
        break;
      }
      lines.push(line);
    }
    return [...lines, legend].join('\n');
  }

  /**
   * Metas y su progreso. La consulta es por **nombre** (comparacion canonica y exacta):
   * si hay varias metas con ese nombre se muestran todas, sin elegir ninguna.
   */
  private async goalsReply(argument: string): Promise<string> {
    const asked = argument.trim();
    const rows = await this.savings.goalStatus();
    const selected =
      asked.length === 0
        ? rows
        : rows.filter(
            (row) =>
              canonicalName(row.goal.name) === canonicalName(asked) ||
              row.goal.id.toLowerCase() === asked.toLowerCase(),
          );
    if (asked.length > 0 && selected.length === 0) {
      return `No hay ninguna meta llamada "${asked}".\nUsa /goals [nombre].`;
    }
    return boundedLines(['Metas actuales:', ...(selected.length ? selected.map((row) => formatGoalStatus(row, { showIds: false })) : ['No hay metas registradas.'])], MAX_REPLY_LENGTH,
      'Reservas nominales, no garantia; progreso puede superar 100%, sin prorratear deficits. Crear/reservar/liberar: solo CLI. Detalle: CLI goal:status.');
  }

  private async savingsReply(argument: string): Promise<string> {
    if (argument) return 'Usa /savings sin argumentos; solo estado actual.';
    const rows = await this.savings.status();
    const lines = ['Reservas virtuales actuales:'];
    if (rows.some((row) => row.deficit > 0n)) lines.push('ADVERTENCIA: hay cuentas deficitarias; reservas preservadas. Detalle completo: CLI savings:status.');
    return boundedLines([...lines, ...(rows.length ? rows.map((row) => `${formatSavingsStatus(row, { showIds: false })}${row.deficit > 0n ? ' | ADVERTENCIA: reservas preservadas' : ''}`) : ['No hay cuentas registradas.'])], MAX_REPLY_LENGTH,
      'No son transferencias. No sumar monedas distintas. Crear/reservar/liberar: solo CLI. Detalle: CLI savings:status.');
  }

  /**
   * Deudas registradas. Es de solo lectura y **no llama al modelo**: los totales y las
   * filas salen de los datos guardados. La consulta es por **persona** (comparacion
   * canonica y exacta): si tiene deudas en varias direcciones o monedas, se muestran
   * todas.
   */
  private async debtsReply(argument: string): Promise<string> {
    const asked = argument.trim();
    try {
      if (asked.length > 0) {
        const rows = await this.debts.list({ counterparty: asked });
        if (rows.length > 0) {
          return formatDebtReport(rows.map(debtReportRow), {
            title: 'Deudas:',
            showIds: false,
            fallback: DEBT_CLI_FALLBACK,
          });
        }
        const view = await this.debts.get(asked).catch(() => null);
        if (view !== null) {
          return formatDebtReport([debtReportRow(view)], {
            title: 'Deuda:',
            showIds: false,
            fallback: DEBT_CLI_FALLBACK,
          });
        }
        return `No hay ninguna deuda con esa persona.\nUsa /debts [persona].`;
      }
      const rows = await this.debts.list();
      return formatDebtReport(rows.map(debtReportRow), {
        title: 'Deudas:',
        showIds: false,
        fallback: DEBT_CLI_FALLBACK,
      });
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ValidationError) {
        return `No hay ninguna deuda con esa persona.\nUsa /debts [persona].`;
      }
      throw error;
    }
  }

  /**
   * Consumo reservado de inferencia del dia. Es solo lectura: no llama al
   * proveedor, no reserva nada y no toca el borrador de la conversacion.
   */
  private async usageReply(): Promise<string> {
    const usage = await this.budget.current();
    const day = usage?.day ?? dateInTimeZone(new Date(), DEFAULT_TIME_ZONE);
    return [
      `Consumo reservado del dia ${day} (${DEFAULT_TIME_ZONE}):`,
      `  - llamadas reservadas: ${usage?.requests ?? 0} de ${this.limits.maxRequestsPerDay}`,
      `  - tokens de entrada reservados: ${usage?.inputTokens ?? 0} (maximo por llamada: ${this.limits.maxInputTokensPerCall})`,
      `  - tokens de salida reservados: ${usage?.outputTokens ?? 0} (maximo por llamada: ${this.limits.maxOutputTokensPerCall})`,
      `  - costo reservado: ${usage?.costMicroUsd ?? 0} microUSD de ${this.limits.dailyBudgetMicroUsd} microUSD`,
      `  - reserva maxima por llamada: ${this.limits.maxCostMicroUsdPerCall} microUSD`,
      '',
      USAGE_LEGEND,
    ].join('\n');
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

  /** Los nombres de las cuentas, por id: el bot muestra nombres, no ids. */
  private async accountNames(): Promise<Map<string, string>> {
    const accounts = await this.accounts.list();
    return new Map(accounts.map((account) => [account.id, account.name]));
  }

  /** Una linea legible de un movimiento: fecha, tipo, importe, cuenta y descripcion. */
  private movementLine(
    movement: Movement,
    names: Map<string, string>,
    category: string | null = null,
  ): string {
    const parts = [
      movement.occurredOn,
      movement.kind === 'income' ? 'ingreso' : 'gasto',
      `${formatAmount(movement.amountMinor, movement.currency)} ${movement.currency}`,
      names.get(movement.accountId) ?? '(cuenta desconocida)',
    ];
    if (category !== null && category.length > 0) {
      parts.push(`categoria ${category}`);
    }
    if (movement.description !== null && movement.description.length > 0) {
      parts.push(movement.description);
    }
    return parts.join(' | ');
  }

  /**
   * La cuenta que nombra el usuario: por id (lo que se usaba antes) o por nombre
   * canonico. Con dos cuentas del mismo nombre no se elige ninguna: se pregunta.
   */
  private findAccount(
    asked: string,
    accounts: Account[],
  ): { account: Account | null; ambiguous: boolean } {
    const byId = accounts.find((account) => account.id.toLowerCase() === asked.toLowerCase());
    if (byId) {
      return { account: byId, ambiguous: false };
    }
    const canonical = canonicalName(asked);
    const matches = accounts.filter((account) => canonicalName(account.name) === canonical);
    if (matches.length === 1) {
      return { account: matches[0]!, ambiguous: false };
    }
    return { account: null, ambiguous: matches.length > 1 };
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
function clamp(text: string, limit = MAX_REPLY_LENGTH): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1)}…`;
}
