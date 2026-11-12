import { formatAmount } from '../domain/money';
import { GoalStatus, SavingsStatus } from './savings.service';

/**
 * Como se muestran las filas. La CLI deja el id: sus ids son la forma de seleccionar
 * una meta o una cuenta. El bot los quita: al usuario le bastan el nombre y los
 * importes.
 */
export interface SavingsFormatOptions {
  showIds?: boolean;
}

export function formatSavingsStatus(row: SavingsStatus, options: SavingsFormatOptions = {}): string {
  const amount = (value: bigint) => formatAmount(value, row.currency);
  const id = options.showIds === false ? '' : `${row.accountId} | `;
  return `${id}${row.name} | ${row.currency} | al ${row.asOf} | saldo ${amount(row.balance)} | reservado ${amount(row.reserved)} | disponible ${amount(row.available)} | deficit ${amount(row.deficit)}`;
}

export function formatGoalStatus(row: GoalStatus, options: SavingsFormatOptions = {}): string {
  const { goal } = row;
  const amount = (value: bigint) => formatAmount(value, goal.currency);
  const id = options.showIds === false ? '' : `${goal.id} | `;
  return `${id}${goal.name} | ${goal.currency} | objetivo ${amount(goal.targetMinor)} | reservado nominal ${amount(row.reserved)} | restante ${amount(row.remaining)} | progreso ${row.progress}${goal.targetOn === null ? '' : ` | fecha objetivo ${goal.targetOn}`}${row.nominalWithDeficit ? ' | reserva nominal con cuentas deficitarias' : ''}`;
}
