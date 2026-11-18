import {
  DebtFollowUp,
  DebtFollowUpInterpreter,
  DebtFollowUpRequest,
} from '../../src/interpreter/debt-follow-up';

/**
 * Interprete de seguimiento de prueba: devuelve respuestas fijas y registra las
 * peticiones. No llama a ningun proveedor.
 */
export class FakeFollowUpInterpreter extends DebtFollowUpInterpreter {
  readonly requests: DebtFollowUpRequest[] = [];
  /** Respuestas que se devuelven, en orden. */
  readonly responses: Array<DebtFollowUp | Error>;
  readonly enabled = true;

  constructor(responses: Array<DebtFollowUp | Error>) {
    super();
    this.responses = responses;
  }

  async resolve(request: DebtFollowUpRequest): Promise<DebtFollowUp> {
    this.requests.push(request);
    const next = this.responses.shift();
    if (next === undefined) {
      throw new Error('El interprete de seguimiento de prueba no tiene mas respuestas.');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}
