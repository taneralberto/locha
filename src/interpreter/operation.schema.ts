import { z } from 'zod';

/**
 * Esquema unico de la operacion que devuelve el modelo. Es la unica definicion de la
 * forma de la respuesta: el JSON Schema que se envia al proveedor se deriva de aqui.
 * `strict` impide que el modelo agregue campos que el backend no valida.
 */
export const OperationSchema = z
  .object({
    amount: z
      .string()
      .nullable()
      .describe('Importe en decimal con punto, sin simbolo ni separador de miles ("12.50"). Null si no aparece.'),
    currency: z
      .string()
      .nullable()
      .describe('Moneda de la operacion: "VES", "USD" o "USDT". Null si no se puede determinar.'),
    accountId: z
      .string()
      .nullable()
      .describe('Id de una de las cuentas listadas. Null si el mensaje no menciona una cuenta.'),
    kind: z
      .enum(['income', 'expense', 'transfer', 'unclear', 'unsupported'])
      .describe(
        'income: entrada de dinero. expense: salida de dinero. transfer: cambio o conversion entre cuentas o monedas. unclear: falta informacion o hay mas de una operacion. unsupported: no es una operacion financiera.',
      ),
    occurredOn: z
      .string()
      .nullable()
      .describe('Fecha de la operacion en formato YYYY-MM-DD. Null si el mensaje no menciona una fecha.'),
    description: z
      .string()
      .nullable()
      .describe('Descripcion breve del gasto o del ingreso. Null si no hay ninguna util.'),
  })
  .strict();

export type Operation = z.infer<typeof OperationSchema>;

/**
 * JSON Schema que se envia al proveedor con `response_format`. Se deriva del esquema de
 * ejecucion para que ambos no puedan divergir.
 */
export const OPERATION_JSON_SCHEMA = (() => {
  const { $schema, ...schema } = z.toJSONSchema(OperationSchema);
  void $schema;
  return schema;
})();
