import { AiConfig } from '../config/configuration';
import { boundedFetch, BoundedFetchError } from '../http/bounded-fetch';
import {
  InterpreterError,
  InterpreterRequest,
  OperationInterpreter,
} from './interpreter';
import { OPERATION_JSON_SCHEMA, Operation, OperationSchema } from './operation.schema';

const CHAT_COMPLETIONS_PATH = '/chat/completions';

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

function buildUserPrompt(request: InterpreterRequest): string {
  const lines: string[] = [];
  lines.push(`Fecha de hoy (America/Caracas): ${request.defaultDate}`);
  lines.push('Cuentas disponibles:');
  if (request.accounts.length === 0) {
    lines.push('  (no hay cuentas registradas)');
  }
  for (const account of request.accounts) {
    lines.push(`  ${account.id} | ${account.name} | ${account.currency}`);
  }
  if (request.pending) {
    lines.push('');
    lines.push('Operacion pendiente de completar (puedes completarla o corregirla):');
    lines.push(`  tipo: ${request.pending.kind ?? '(sin dato)'}`);
    lines.push(`  importe: ${request.pending.amount ?? '(sin dato)'}`);
    lines.push(`  moneda: ${request.pending.currency ?? '(sin dato)'}`);
    lines.push(`  cuenta: ${request.pending.accountId ?? '(sin dato)'}`);
    lines.push(`  fecha: ${request.pending.occurredOn ?? '(sin dato)'}`);
    lines.push(`  descripcion: ${request.pending.description ?? '(sin dato)'}`);
    lines.push(`  mensaje original: ${request.pending.sourceText}`);
    lines.push('');
    lines.push('El mensaje siguiente es la aclaracion del usuario sobre esa operacion.');
  }
  lines.push('');
  lines.push('Mensaje del usuario:');
  lines.push(request.text);
  return lines.join('\n');
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
