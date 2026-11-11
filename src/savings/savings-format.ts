import { formatAmount } from '../domain/money';
import { GoalStatus, SavingsStatus } from './savings.service';

export function formatSavingsStatus(row: SavingsStatus): string {
  const amount = (value: bigint) => formatAmount(value, row.currency);
  return `${row.accountId} | ${row.name} | ${row.currency} | al ${row.asOf} | saldo ${amount(row.balance)} | reservado ${amount(row.reserved)} | disponible ${amount(row.available)} | deficit ${amount(row.deficit)}`;
}

export function formatGoalStatus(row: GoalStatus): string {
  const { goal } = row;
  const amount = (value: bigint) => formatAmount(value, goal.currency);
  return `${goal.id} | ${goal.name} | ${goal.currency} | objetivo ${amount(goal.targetMinor)} | reservado nominal ${amount(row.reserved)} | restante ${amount(row.remaining)} | progreso ${row.progress}${goal.targetOn === null ? '' : ` | fecha objetivo ${goal.targetOn}`}${row.nominalWithDeficit ? ' | reserva nominal con cuentas deficitarias' : ''}`;
}
