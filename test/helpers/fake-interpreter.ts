import {
  InterpreterError,
  InterpreterRequest,
  OperationInterpreter,
} from '../../src/interpreter/interpreter';
import { Operation } from '../../src/interpreter/operation.schema';

/**
 * Interpretador de prueba: devuelve respuestas fijas y registra las peticiones. No
 * llama a ningun proveedor.
 */
export class FakeInterpreter extends OperationInterpreter {
  readonly requests: InterpreterRequest[] = [];
  /** Respuestas que se devuelven, en orden. */
  readonly responses: Array<Operation | Error>;

  constructor(responses: Array<Operation | Error>, readonly enabled = true) {
    super();
    this.responses = responses;
  }

  async interpret(request: InterpreterRequest): Promise<Operation> {
    this.requests.push(request);
    const next = this.responses.shift();
    if (next === undefined) {
      throw new Error('El interpretador de prueba no tiene mas respuestas.');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

/** Error de inferencia con el motivo indicado. */
export function interpreterError(reason: InterpreterError['reason']): InterpreterError {
  return new InterpreterError(reason, 'Fallo de interpretacion simulado.');
}
