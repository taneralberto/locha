import { QueryFailedError } from 'typeorm';

/** SQLite reporta las violaciones de unicidad con este mensaje del driver. */
export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const message = `${error.message} ${error.driverError?.message ?? ''}`;
  return /UNIQUE constraint failed/i.test(message);
}
