/**
 * Acota un bloque de lineas al limite de caracteres **sin partir ninguna linea**: si una
 * linea no cabe, se deja fuera y se avisa con una marca. Un dato a medias es peor que
 * un dato que falta.
 *
 * El limite lo pone quien llama (por ejemplo, el limite de un mensaje de Telegram).
 */
export function boundedLines(lines: string[], limit: number, fallback: string): string {
  const included: string[] = [];
  const omitted = '... detalle omitido por el limite de Telegram.';
  for (const line of lines) {
    if ([...included, line, omitted, fallback].join('\n').length > limit) {
      included.push(omitted);
      break;
    }
    included.push(line);
  }
  return [...included, fallback].join('\n');
}
