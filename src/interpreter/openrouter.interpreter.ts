import { AiConfig } from '../config/configuration';
import { boundedFetch, BoundedFetchError } from '../http/bounded-fetch';
import {
  InterpreterError,
  InterpreterRequest,
  OperationInterpreter,
} from './interpreter';
import { OPERATION_JSON_SCHEMA, Operation, OperationSchema } from './operation.schema';

const CHAT_COMPLETIONS_PATH = '/chat/completions';

/**
 * Tope del **contexto** que se envia junto al mensaje (cuentas, deudas y borrador).
 *
 * Es un tope propio y fijo: el limite de `maxInputChars` sigue aplicando al mensaje del
 * usuario y no se toca. El contexto se recorta por lineas enteras y siempre avisa cuando
 * recorta: nunca se recorta en silencio un dato financiero.
 */
const MAX_CONTEXT_CHARS = 6_000;
/** Presupuesto del bloque de cuentas. */
const MAX_ACCOUNTS_CHARS = 1_500;
/** Presupuesto del bloque de deudas candidatas. */
const MAX_DEBTS_CHARS = 3_000;
/** Presupuesto del bloque del borrador vivo. */
const MAX_PENDING_CHARS = 1_200;
/** Numero maximo de deudas candidatas que se envian al modelo. */
const MAX_DEBT_CANDIDATES = 20;
/** Longitud maxima de la descripcion de una candidata. */
const MAX_CANDIDATE_DESCRIPTION = 80;

const SYSTEM_PROMPT = [
  'Eres un asistente que extrae UNA sola operacion financiera de un mensaje del usuario.',
  'Respondes solo con el esquema indicado y no usas herramientas.',
  'Reglas:',
  '- kind "income" si el mensaje describe una sola entrada de dinero.',
  '- kind "expense" si el mensaje describe una sola salida de dinero.',
  '- kind "transfer" si el mensaje describe un cambio, una conversion o un paso de dinero entre cuentas o monedas.',
  '- kind "unclear" si falta informacion para registrar la operacion o si el mensaje describe mas de una operacion.',
  '- kind "unsupported" si el mensaje no describe una operacion financiera.',
  '- amount: solo el numero decimal con punto, sin simbolo ni separador de miles. Null si el mensaje no da un importe.',
  '- currency: "VES", "USD" o "USDT". Null si no se puede determinar.',
  '- accountId: el id de una de las cuentas listadas. Null si el mensaje no permite elegir una.',
  '- occurredOn: la fecha en formato YYYY-MM-DD, resolviendo referencias relativas con la fecha de hoy indicada. Null si el mensaje no menciona una fecha.',
  '- description: descripcion breve del gasto o del ingreso, o null.',
  'Reglas de deudas:',
  '- kind "debt_create" si el usuario quiere dejar registrada una obligacion (lo que debe o lo que le deben).',
  '  Ejemplo: "le debo 8$ a Carmen de dos tortas" -> kind "debt_create", debt.direction "payable", debt.counterparty "Carmen", amount "8.00", currency "USD", accountId null.',
  '  Ejemplo: "Carmen me debe 8$" -> kind "debt_create", debt.direction "receivable", debt.counterparty "Carmen", amount "8.00", currency "USD", accountId null.',
  '- Crear una deuda NO es un gasto ni un ingreso: no hay cuenta, no hay movimiento y no se mueve dinero. accountId null.',
  '- kind "debt_settle" si el usuario paga o cobra una obligacion que ya existe.',
  '  Ejemplo: "le pagué 3 dólares" -> kind "debt_settle", debt.settlementMode "partial", amount "3.00", debt.counterparty "Carmen" si el mensaje lo nombra.',
  '  Ejemplo: "Carmen me pagó" -> kind "debt_settle", debt.settlementMode null, amount null: no se sabe cuanto se pagó.',
  '  Ejemplo: "ya le pagué todo" -> kind "debt_settle", debt.settlementMode "full", amount null.',
  '- debt.settlementMode "full" solo si el usuario dice de forma explicita que paga todo ("ya le pagué todo", "lo pagué completo", "ya saldé la deuda"). Si no lo dice, null: nunca se paga todo sin que el usuario lo pida.',
  '- amount: null cuando el usuario no da un importe. Si el usuario dice que pagó todo, el importe es null.',
  '- debt.debtId: solo si el usuario escribe el id de la deuda. Nunca elijas un id de la lista de deudas por tu cuenta.',
  '- kind "debt_query" si el usuario pregunta por sus deudas. Son consultas de solo lectura: no registres nada.',
  '  Ejemplos: "cuáles son mis deudas", "quién me debe", "qué le debo a Carmen" -> kind "debt_query", con debt.direction, debt.counterparty o debt.status segun lo que pregunte.',
  '- debt.status: "open", "partial" o "paid" si el usuario filtra por estado; null si no filtra.',
  '- Si el mensaje habla de una deuda ("debo", "me debe", "adeudo", "préstamo") y no puedes distinguirla de un gasto o de un ingreso, usa kind "unclear".',
  '- Moneda: "$" y "dólares" son USD, "bolívares" son VES y "USDT" es USDT. No inventes la moneda: null si no se puede determinar.',
  'Nunca inventes datos: usa null cuando la informacion no este en el mensaje.',
].join('\n');

/**
 * Interpreta mensajes contra OpenRouter usando salidas estructuradas (`response_format`).
 * Una sola llamada por mensaje: no hay reintentos automaticos y el tiempo de espera esta
 * acotado. Ni la credencial, ni el mensaje, ni la respuesta del proveedor se registran.
 */
export class OpenRouterInterpreter extends OperationInterpreter {
  readonly enabled: boolean;

  constructor(private readonly config: AiConfig) {
    super();
    this.enabled =
      config.openrouter.apiKey.trim().length > 0 && config.openrouter.model.trim().length > 0;
  }

  async interpret(request: InterpreterRequest): Promise<Operation> {
    if (!this.enabled) {
      throw new InterpreterError(
        'not_configured',
        'Falta OPENROUTER_API_KEY u OPENROUTER_MODEL.',
      );
    }
    if (request.text.length > this.config.openrouter.maxInputChars) {
      throw new InterpreterError(
        'too_long',
        `El mensaje excede ${this.config.openrouter.maxInputChars} caracteres.`,
      );
    }

    const body = {
      model: this.config.openrouter.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(request) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'operation',
          strict: true,
          schema: OPERATION_JSON_SCHEMA,
        },
      },
      max_tokens: this.config.limits.maxOutputTokensPerCall,
      temperature: 0,
    };

    const payload = await this.call(body);
    return parseOperation(payload);
  }

  /**
   * Una sola llamada al proveedor. El plazo abarca **toda** la llamada: las cabeceras
   * y la lectura del cuerpo. Si el proveedor manda las cabeceras y despues se queda
   * colgado, la lectura se aborta y no se queda esperando para siempre.
   *
   * Los fallos de red, de cancelacion y de lectura se informan sin detalle: el mensaje
   * de error nunca incluye la respuesta del proveedor ni el texto enviado.
   */
  private async call(body: unknown): Promise<string> {
    const url = `${this.config.openrouter.baseUrl.replace(/\/+$/, '')}${CHAT_COMPLETIONS_PATH}`;
    try {
      const response = await boundedFetch({
        url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.openrouter.apiKey}`,
        },
        body: JSON.stringify(body),
        timeoutMs: this.config.openrouter.timeoutMs,
        maxResponseBytes: this.config.openrouter.maxResponseBytes,
      });
      return response.text;
    } catch (error) {
      throw toInterpreterError(error);
    }
  }
}

/** Traduce el fallo de la llamada HTTP a un fallo de inferencia, sin detalle. */
function toInterpreterError(error: unknown): InterpreterError {
  if (error instanceof BoundedFetchError) {
    if (error.reason === 'timeout') {
      return new InterpreterError('timeout', 'El proveedor no respondio a tiempo.');
    }
    if (error.reason === 'http') {
      return new InterpreterError('http', `El proveedor respondio con estado ${error.status}.`);
    }
    if (error.reason === 'too_large') {
      return new InterpreterError('invalid', 'La respuesta del proveedor excede el limite permitido.');
    }
  }
  return new InterpreterError('network', 'No se pudo completar la llamada al proveedor.');
}

/**
 * Arma el mensaje del proveedor. El **mensaje del usuario va entero y al final**: el
 * contexto (cuentas, deudas y borrador) es lo unico que se recorta, y cuando se recorta
 * lo avisa para que el modelo pida lo que falta en vez de elegir.
 */
function buildUserPrompt(request: InterpreterRequest): string {
  return [
    buildContext(request),
    '',
    'Mensaje del usuario:',
    request.text,
  ].join('\n');
}

function buildContext(request: InterpreterRequest): string {
  const sections: string[] = [`Fecha de hoy (America/Caracas): ${request.defaultDate}`];
  /** Caracteres que quedan del tope de contexto. */
  let remaining = MAX_CONTEXT_CHARS - sections.join('\n').length;

  const accountLines = request.accounts.map(
    (account) => `  ${account.id} | ${account.name} | ${account.currency}`,
  );
  const accounts = fitLines(accountLines, Math.min(MAX_ACCOUNTS_CHARS, remaining));
  remaining -= accounts.lines.join('\n').length;
  sections.push('Cuentas disponibles:');
  sections.push(...(accounts.lines.length === 0 ? ['  (no hay cuentas registradas)'] : accounts.lines));
  if (accounts.truncated) {
    sections.push('  (faltan cuentas en la lista: pide al usuario la cuenta)');
  }

  const capped = request.debts.slice(0, MAX_DEBT_CANDIDATES);
  const debtLines = capped.map(
    (debt) =>
      `  ${debt.id} | ${debt.direction === 'payable' ? 'lo que debo' : 'lo que me deben'} | ${debt.counterparty} | ${debt.currency} | pendiente ${debt.outstanding} | ${debt.status}${debt.description === null ? '' : ` | ${debt.description.slice(0, MAX_CANDIDATE_DESCRIPTION)}`}`,
  );
  const debts = fitLines(debtLines, Math.min(MAX_DEBTS_CHARS, remaining));
  remaining -= debts.lines.join('\n').length;
  sections.push('Deudas pendientes que se pueden pagar:');
  sections.push(...(debts.lines.length === 0 ? ['  (no hay deudas pendientes)'] : debts.lines));
  if (request.debtsTruncated || debts.truncated || capped.length < request.debts.length) {
    sections.push(
      '  (la lista de deudas esta truncada: no elijas ninguna de ella; pide al usuario que identifique la deuda)',
    );
  }

  if (request.pending) {
    const pending = fitLines(pendingLines(request), Math.min(MAX_PENDING_CHARS, remaining));
    sections.push('');
    sections.push('Operacion pendiente de completar (puedes completarla o corregirla):');
    sections.push(...pending.lines);
    if (pending.truncated) {
      sections.push('  (el resumen pendiente esta truncado)');
    }
    sections.push('');
    sections.push('El mensaje siguiente es la aclaracion del usuario sobre esa operacion.');
  }

  return sections.join('\n');
}

function pendingLines(request: InterpreterRequest): string[] {
  const pending = request.pending;
  if (!pending) {
    return [];
  }
  const lines = [
    `  tipo: ${pending.kind ?? '(sin dato)'}`,
    `  importe: ${pending.amount ?? '(sin dato)'}`,
    `  moneda: ${pending.currency ?? '(sin dato)'}`,
    `  cuenta: ${pending.accountId ?? '(sin dato)'}`,
    `  fecha: ${pending.occurredOn ?? '(sin dato)'}`,
    `  descripcion: ${pending.description ?? '(sin dato)'}`,
  ];
  if (pending.debt) {
    lines.push(
      `  deuda: ${pending.debt.kind ?? '(sin dato)'}`,
      `  direccion: ${pending.debt.direction ?? '(sin dato)'}`,
      `  contraparte: ${pending.debt.counterparty ?? '(sin dato)'}`,
      `  id de deuda: ${pending.debt.debtId ?? '(sin dato)'}`,
      `  modo de pago: ${pending.debt.settlementMode ?? '(sin dato)'}`,
    );
  }
  lines.push(`  mensaje original: ${pending.sourceText}`);
  return lines;
}

/**
 * Recorta un bloque de lineas al presupuesto dado **sin partir ninguna linea**: si una
 * linea no cabe, se deja fuera y se avisa. Un dato financiero a medias es peor que un
 * dato que falta.
 */
function fitLines(lines: string[], budget: number): { lines: string[]; truncated: boolean } {
  const included: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) {
      break;
    }
    included.push(line);
    used += line.length + 1;
  }
  return { lines: included, truncated: included.length < lines.length };
}

function parseOperation(payload: string): Operation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new InterpreterError('invalid', 'La respuesta del proveedor no es JSON valido.');
  }
  const content = extractContent(parsed);
  if (content === null) {
    throw new InterpreterError('refusal', 'El modelo no devolvio una operacion.');
  }
  let operation: unknown;
  try {
    operation = JSON.parse(content);
  } catch {
    throw new InterpreterError('invalid', 'El contenido de la respuesta no es JSON valido.');
  }
  const result = OperationSchema.safeParse(operation);
  if (!result.success) {
    throw new InterpreterError('invalid', 'La respuesta del proveedor no cumple el esquema.');
  }
  return result.data;
}

/** Devuelve el contenido del mensaje del proveedor, o `null` si no lo hay (rechazo). */
function extractContent(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    throw new InterpreterError('invalid', 'La respuesta del proveedor no tiene la forma esperada.');
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new InterpreterError('invalid', 'La respuesta del proveedor no tiene la forma esperada.');
  }
  const first = choices[0];
  if (typeof first !== 'object' || first === null) {
    throw new InterpreterError('invalid', 'La respuesta del proveedor no tiene la forma esperada.');
  }
  const message = (first as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) {
    throw new InterpreterError('invalid', 'La respuesta del proveedor no tiene la forma esperada.');
  }
  const refusal = (message as { refusal?: unknown }).refusal;
  if (typeof refusal === 'string' && refusal.trim().length > 0) {
    throw new InterpreterError('refusal', 'El modelo se nego a responder.');
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    return content.trim().length === 0 ? null : content;
  }
  if (Array.isArray(content)) {
    const text = content
      .filter((part): part is { text: string } => typeof part?.text === 'string')
      .map((part) => part.text)
      .join('');
    return text.trim().length === 0 ? null : text;
  }
  return null;
}
