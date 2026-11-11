import { z } from 'zod';

/**
 * Datos de deuda que devuelve el modelo dentro de la operacion.
 *
 * Es **un solo objeto**: las propiedades que no aplican a la operacion van en `null`.
 * Todas son obligatorias en la respuesta (el proveedor exige el esquema estricto) pero
 * admiten `null`, de modo que la forma de la respuesta nunca depende del tipo de
 * operacion.
 */
export const DebtOperationSchema = z
  .object({
    direction: z
      .enum(['payable', 'receivable'])
      .nullable()
      .describe(
        'Direccion de la deuda: "payable" si hay que pagarla, "receivable" si nos la tienen que pagar. Null si no aplica.',
      ),
    counterparty: z
      .string()
      .nullable()
      .describe('Persona o entidad con la que existe la deuda. Null si no se nombra.'),
    debtId: z
      .string()
      .nullable()
      .describe(
        'Id de una deuda ya registrada, solo si el usuario escribe ese id. Null si el usuario no lo escribe.',
      ),
    settlementMode: z
      .enum(['partial', 'full'])
      .nullable()
      .describe('"partial" si se paga una parte de la deuda, "full" si se paga toda. Null si no es un pago.'),
    status: z
      .enum(['open', 'partial', 'paid'])
      .nullable()
      .describe('Filtro de estado de la consulta: "open", "partial" o "paid". Null si no se filtra por estado.'),
  })
  .strict();

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
      .enum([
        'income',
        'expense',
        'transfer',
        'unclear',
        'unsupported',
        'debt_create',
        'debt_settle',
        'debt_query',
      ])
      .describe(
        'income: entrada de dinero. expense: salida de dinero. transfer: cambio o conversion entre cuentas o monedas. unclear: falta informacion o hay mas de una operacion. unsupported: no es una operacion financiera. debt_create: se crea una obligacion a pagar o a cobrar (no mueve dinero). debt_settle: se paga o se cobra una obligacion existente. debt_query: se consultan las obligaciones (solo lectura).',
      ),
    occurredOn: z
      .string()
      .nullable()
      .describe('Fecha de la operacion en formato YYYY-MM-DD. Null si el mensaje no menciona una fecha.'),
    description: z
      .string()
      .nullable()
      .describe('Descripcion breve del gasto o del ingreso. Null si no hay ninguna util.'),
    debt: DebtOperationSchema.nullable().describe(
      'Datos de la deuda. Null si la operacion no trata de una obligacion.',
    ),
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
