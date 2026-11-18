import { canonicalName } from '../domain/name';

/** Lo que resuelve el nombre de una cuenta: la cuenta, o la ambiguedad. */
export interface AccountMatch<T> {
  /** La cuenta nombrada, o `null` si no hay una sola que valga. */
  account: T | null;
  /** `true` cuando hay mas de una cuenta con ese nombre: no se elige ninguna. */
  ambiguous: boolean;
}

/**
 * Cuenta que nombra el usuario. El nombre tiene que ser **exacto** (comparacion
 * canonica): el id de la cuenta tambien vale y tiene prioridad. Con dos cuentas del
 * mismo nombre no se elige ninguna: se pregunta.
 *
 * Es una funcion pura: no filtra por activa ni por moneda. Quien la llama decide que
 * cuentas entran y comprueba la compatibilidad con la moneda.
 */
export function matchAccount<T extends { id: string; name: string }>(
  name: string | null,
  accounts: readonly T[],
): AccountMatch<T> {
  if (name === null) {
    return { account: null, ambiguous: false };
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { account: null, ambiguous: false };
  }
  const byId = accounts.find((account) => account.id.toLowerCase() === trimmed.toLowerCase());
  if (byId) {
    return { account: byId, ambiguous: false };
  }
  const canonical = canonicalName(trimmed);
  const matches = accounts.filter((account) => canonicalName(account.name) === canonical);
  if (matches.length === 1) {
    return { account: matches[0]!, ambiguous: false };
  }
  return { account: null, ambiguous: matches.length > 1 };
}
