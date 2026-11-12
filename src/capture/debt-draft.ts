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
 * Numero maximo de opciones de una lista de deudas. Es el tope de lo que se muestra y
 * de lo que se guarda: la lista visible y la lista guardada son siempre la misma.
 */
export const MAX_DEBT_CHOICES = 20;

/**
 * Una opcion de la lista de deudas: el id interno (que el usuario nunca ve), la
 * etiqueta legible que si ve y la **foto** de lo que se le mostro.
 *
 * La foto (el pendiente en unidades menores y su moneda) es lo que permite comprobar
 * que la opcion sigue valiendo: si el pendiente cambio, la lista se refresca y se
 * vuelve a preguntar. El resto de lo que muestra la etiqueta (fecha, direccion,
 * contraparte y descripcion) **no cambia**: la deuda no se edita.
 *
 * Las opciones escritas antes de existir estos campos se leen con la foto vacia: en ese
 * caso la eleccion **no** se aplica, se refresca la lista y se vuelve a preguntar.
 */
export const DebtChoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** Pendiente al mostrar la opcion, en unidades menores, como texto exacto. */
  outstandingMinor: z.string().nullable().default(null),
  /** Moneda del pendiente que se mostro. */
  currency: z.string().nullable().default(null),
});

export type DebtChoice = z.infer<typeof DebtChoiceSchema>;

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
    /**
     * Deudas que el usuario todavia no ha elegido, **en orden**. El usuario responde
     * con el numero de la opcion; el id guardado es el que se paga. Los borradores
     * anteriores a este campo se leen con la lista vacia.
     */
    choices: z.array(DebtChoiceSchema).max(MAX_DEBT_CHOICES).default([]),
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
