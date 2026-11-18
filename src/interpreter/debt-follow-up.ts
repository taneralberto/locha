import { InterpreterError } from './interpreter';
import { DebtFollowUp } from './debt-follow-up.schema';
import { HistoryTurn } from './history-window';

export type { DebtFollowUp } from './debt-follow-up.schema';

/**
 * Lo que recibe la consulta de seguimiento: el **mensaje actual** y la **ventana del
 * chat** que lo precede.
 *
 * La ventana son datos: los turnos que ya se dijeron, con su rol y su texto. No se
 * manda ningun borrador, ninguna cuenta y ninguna lista de deudas: la respuesta sale
 * de la base de datos, no del historial.
 */
export interface DebtFollowUpRequest {
  /** El mensaje actual del usuario: el que hay que resolver. */
  text: string;
  /** Los turnos anteriores del chat, en orden. */
  history: HistoryTurn[];
}

/**
 * Resuelve una pregunta de seguimiento sobre deudas.
 *
 * Es una via **aparte** de la interpretacion normal: la normal nunca ve el historial y
 * esta solo se usa para una pregunta que depende de un turno anterior. No registra
 * nada, no elige deudas y no autoriza pagos.
 */
export abstract class DebtFollowUpInterpreter {
  /** `false` cuando falta la credencial o el modelo: la via de seguimiento no se usa. */
  abstract readonly enabled: boolean;

  abstract resolve(request: DebtFollowUpRequest): Promise<DebtFollowUp>;
}

/**
 * La via de seguimiento **no disponible**: no hay quien resuelva la pregunta.
 *
 * Es el valor por defecto cuando nadie provee un interprete de seguimiento (por
 * ejemplo, en las pruebas que no miran el historial): la pregunta se responde pidiendo
 * la persona de forma explicita, sin tocar el borrador ni registrar nada.
 */
export class UnavailableDebtFollowUpInterpreter extends DebtFollowUpInterpreter {
  readonly enabled = false;

  async resolve(): Promise<DebtFollowUp> {
    throw new InterpreterError(
      'not_configured',
      'No hay interprete de seguimiento configurado.',
    );
  }
}
