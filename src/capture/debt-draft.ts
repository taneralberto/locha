import { z } from 'zod';
import type { DebtDirection } from '../debts/debt.entity';

/**
 * Version de la autorizacion de un pago total.
 *
 * Solo la version **2** vale: la autoriza el **mensaje entero** del usuario ("ya le
 * pagué todo a Carmen"). Los borradores escritos antes de existir esta version se leen
 * con la version en `null`: un borrador viejo nunca autoriza un pago total por su
 * cuenta, ni aunque su `fullIntent` diga que si.
 */
export const FULL_AUTHORIZATION_VERSION = 2;

/**
 * Datos de deuda del borrador vivo, tal como se guardan en la columna `debtPayload`.
 *
 * El borrador **vive en la misma tabla `capture`**: no hay un estado pendiente nuevo ni
 * una tabla nueva. La columna es texto con JSON y se valida con este esquema antes de
 * usarse: un JSON roto o incompleto se descarta sin mostrar nada del mensaje original.
 */
export const DebtDraftSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(['debt_create', 'debt_settle']),
    direction: z.enum(['payable', 'receivable']).nullable(),
    counterparty: z.string().nullable(),
    debtId: z.string().nullable(),
    settlementMode: z.enum(['partial', 'full']).nullable(),
    /** Importe del principal (crear) o del pago parcial (pagar). */
    amount: z.string().nullable(),
    currency: z.string().nullable(),
    accountId: z.string().nullable(),
    occurredOn: z.string().nullable(),
    description: z.string().nullable(),
    /** Pendiente congelado al preparar el pago, en unidades menores. */
    expectedOutstandingMinor: z.string().nullable(),
    /**
     * El usuario dijo **de forma explicita** que paga todo. Es la unica autorizacion
     * de un pago total: la da el texto del mensaje, no el modelo.
     *
     * Los borradores escritos antes de existir este campo se leen como `false` (nunca
     * como `true`): un borrador viejo no puede autorizar un pago total por su cuenta.
     */
    fullIntent: z.boolean().default(false),
    /**
     * Version de la autorizacion de pago total. Es `2` solo cuando el mensaje entero
     * del usuario la autoriza; `null` en los borradores que no la tienen (los
     * anteriores a este campo, con `fullIntent` en `true` o en `false`).
     */
    fullAuthorizationVersion: z.literal(FULL_AUTHORIZATION_VERSION).nullable().default(null),
  })
  .strict();

export type DebtDraft = z.infer<typeof DebtDraftSchema>;

/** Texto que se guarda en la columna `debtPayload`. */
export function serializeDebtDraft(draft: DebtDraft): string {
  return JSON.stringify(draft);
}

/**
 * Lee el borrador de deuda guardado. Devuelve `null` si no hay, si el JSON esta roto o
 * si no cumple el esquema: un borrador ilegible se pide de nuevo, nunca se adivina.
 */
export function parseDebtDraft(raw: string | null | undefined): DebtDraft | null {
  if (raw === null || raw === undefined || raw.trim().length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = DebtDraftSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** Direccion de la deuda con su nombre legible. */
export function directionLabel(direction: DebtDirection | null): string {
  if (direction === 'payable') return 'lo que debo';
  if (direction === 'receivable') return 'lo que me deben';
  return '(sin dato)';
}
