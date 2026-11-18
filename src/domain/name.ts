/**
 * Identidad canonica de un nombre: NFD sin diacriticos, minusculas y espacios
 * colapsados. Solo sirve para comparar de forma exacta (contrapartes y cuentas); la
 * forma mostrada se conserva intacta.
 *
 * Vive en el dominio porque lo usan las deudas, las cuentas y la captura: es la misma
 * comparacion en los tres sitios.
 */
export function canonicalName(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
