import type { DebtDirection } from '../debts/debt.entity';
import { Currency } from '../domain/money';
import { Operation } from './operation.schema';

export interface AccountOption {
  id: string;
  name: string;
  currency: Currency;
}

/**
 * Datos de deuda del borrador vivo. Es **opcional**: los registros anteriores a las
 * deudas no lo tienen y siguen siendo validos.
 */
export interface PendingDebt {
  kind: 'debt_create' | 'debt_settle' | null;
  direction: DebtDirection | null;
  counterparty: string | null;
  debtId: string | null;
  settlementMode: 'partial' | 'full' | null;
  amount: string | null;
  currency: string | null;
  accountId: string | null;
  occurredOn: string | null;
  description: string | null;
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
  /** Datos de deuda del borrador: ausentes en los borradores que no son de deuda. */
  debt?: PendingDebt | null;
}

/**
 * Resumen acotado de una deuda que se puede pagar. No incluye el historial de pagos ni
 * conversaciones: solo lo necesario para que el modelo sepa que existe.
 */
export interface DebtCandidate {
  id: string;
  direction: DebtDirection;
  counterparty: string;
  currency: Currency;
  /** Pendiente actual en decimal exacto de la moneda. */
  outstanding: string;
  status: 'open' | 'partial';
  occurredOn: string;
  description: string | null;
}

/**
 * Numero maximo de deudas que se le enseñan al modelo. Es un tope de contexto, no una
 * fuente de verdad: el backend sigue viendo todas las deudas.
 */
export const MAX_DEBT_CANDIDATES = 20;

export interface InterpreterRequest {
  /** Texto del mensaje que se interpreta. */
  text: string;
  /** Cuentas activas entre las que el modelo puede elegir. */
  accounts: AccountOption[];
  /** Fecha por defecto (hoy en la zona del usuario) en formato `YYYY-MM-DD`. */
  defaultDate: string;
  /** Borrador pendiente, si el usuario esta aclarando una operacion previa. */
  pending: PendingOperation | null;
  /** Deudas que se pueden pagar, ya acotadas por el backend. */
  debts: DebtCandidate[];
  /** `true` si la lista de deudas se corto: el modelo no debe elegir ninguna. */
  debtsTruncated: boolean;
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
