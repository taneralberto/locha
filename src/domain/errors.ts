/** Base de los errores de dominio: fallos de reglas de negocio, no de infraestructura. */
export class FinancialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Entrada invalida: formato, importes, fechas o cuentas que incumplen las reglas. */
export class ValidationError extends FinancialError {}

/** Operacion incompatible con un registro existente (por ejemplo, el mismo sourceKey con otro contenido). */
export class ConflictError extends FinancialError {}

/** La entidad referenciada no existe. */
export class NotFoundError extends FinancialError {}
