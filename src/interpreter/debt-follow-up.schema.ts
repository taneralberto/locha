import { z } from 'zod';
import { CURRENCY_CODES } from '../domain/money';

/**
 * Contrato de la **consulta de seguimiento**: una pregunta que depende de un turno
 * anterior del chat ("¿y cuanto le debia inicialmente?").
 *
 * Es un contrato **propio y separado** del de la operacion: aqui no hay importe, ni
 * cuenta, ni id de deuda, ni modo de pago, ni confirmacion. Solo los filtros de una
 * consulta de deudas, que es lo unico que la via de seguimiento puede hacer.
 *
 * `strict` impide que el modelo agregue campos que el backend no valida: un payload
 * con un campo de escritura (un importe, un id, un modo de pago) **no** cumple el
 * esquema y la respuesta se rechaza.
 */
export const DebtFollowUpSchema = z
  .object({
    kind: z
      .enum(['debt_query', 'debt_group', 'clarify'])
      .describe(
        'debt_query: la pregunta se responde con los filtros de deudas de una persona. debt_group: la pregunta pide un subconjunto por direccion, sin persona. clarify: no se sabe de quien es la pregunta y hay que preguntar.',
      ),
    direction: z
      .enum(['payable', 'receivable'])
      .nullable()
      .describe(
        'Direccion de la deuda: "payable" si es lo que debo, "receivable" si es lo que me deben. Con kind "debt_group" tiene que estar clara (payable o receivable); con kind "debt_query" es null si no se puede determinar.',
      ),
    counterparty: z
      .string()
      .nullable()
      .describe(
        'La persona de la que habla la pregunta. Con kind "debt_query" tiene que haber un nombre no vacio. Con kind "debt_group" es null: un grupo no tiene persona. Con kind "clarify" es null.',
      ),
    currency: z
      .enum(CURRENCY_CODES)
      .nullable()
      .describe(
        `Moneda de la deuda: ${CURRENCY_CODES.join(', ')}. Null si no se puede determinar.`,
      ),
    status: z
      .enum(['open', 'partial', 'paid', 'pending'])
      .nullable()
      .describe(
        'Filtro de estado: "open", "partial", "paid" (las ya saldadas) o "pending" (las que todavia no estan saldadas). Null si la pregunta no lo pide de forma explicita.',
      ),
    queryDetail: z
      .boolean()
      .nullable()
      .describe(
        'True si la pregunta pide el detalle de la deuda (cuanto debia al principio, cuanto se le ha pagado y cuanto queda pendiente). Null si solo pide el saldo actual o el resumen.',
      ),
  })
  .strict();

/** La respuesta del modelo en la consulta de seguimiento. */
export type DebtFollowUp = z.infer<typeof DebtFollowUpSchema>;

/**
 * JSON Schema que se envia al proveedor con `response_format`. Se deriva del esquema
 * de ejecucion para que ambos no puedan divergir.
 */
export const DEBT_FOLLOW_UP_JSON_SCHEMA = (() => {
  const { $schema, ...schema } = z.toJSONSchema(DebtFollowUpSchema);
  void $schema;
  return schema;
})();
