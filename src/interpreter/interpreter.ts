import { Currency } from '../domain/money';
import { Operation } from './operation.schema';

export interface AccountOption {
  id: string;
  name: string;
  currency: Currency;
}

/** Borrador vivo de la conversacion: es el contexto con el que se interpreta una aclaracion. */
export interface PendingOperation {
  kind: 'income' | 'expense' | null;
  amount: string | null;
  currency: string | null;
  accountId: string | null;
  occurredOn: string | null;
  description: string | null;
  /** Texto original del mensaje que abrio el borrador. */
  sourceText: string;
}

export interface InterpreterRequest {
  /** Texto del mensaje que se interpreta. */
  text: string;
  /** Cuentas activas entre las que el modelo puede elegir. */
  accounts: AccountOption[];
  /** Fecha por defecto (hoy en la zona del usuario) en formato `YYYY-MM-DD`. */
  defaultDate: string;
  /** Borrador pendiente, si el usuario esta aclarando una operacion previa. */
  pending: PendingOperation | null;
}

export type InterpreterFailure =
  | 'not_configured'
  | 'too_long'
  | 'timeout'
  | 'network'
  | 'http'
  | 'invalid'
  | 'refusal';

/**
 * Fallo de la inferencia. No es un error de dominio: describe por que no se pudo
 * interpretar el mensaje. El mensaje nunca incluye secretos ni el texto del usuario.
 */
export class InterpreterError extends Error {
  constructor(
    readonly reason: InterpreterFailure,
    message: string,
  ) {
    super(message);
    this.name = 'InterpreterError';
  }
}

/**
 * Interpreta un mensaje en lenguaje natural como una operacion estructurada.
 * La implementacion real habla con OpenRouter; las pruebas pueden sustituirla.
 */
export abstract class OperationInterpreter {
  /** `false` cuando falta la credencial o el modelo: la captura no puede interpretar. */
  abstract readonly enabled: boolean;

  abstract interpret(request: InterpreterRequest): Promise<Operation>;
}
