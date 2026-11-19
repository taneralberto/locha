import { CorrectionMetadata } from './correction';

/**
 * Los metadatos de un evento de captura, en JSON.
 *
 * Van **con la respuesta** del evento: se guardan en la misma transaccion, para que
 * el menu de una fase se pueda reproducir tal cual estaba, sin reconstruirlo con los
 * datos de ahora. Un metadato ilegible se trata como si no hubiera.
 */
export function encodeMetadata(metadata: CorrectionMetadata | null): string | null {
  return metadata === null ? null : JSON.stringify(metadata);
}

/**
 * Lee los metadatos de un evento. `null` si no hay o si estan rotos.
 *
 * La validacion es **por fase**: cada fase tiene su forma exacta y no se acepta una
 * a medias (una lista de cuentas vacia, un resumen sin el antes o el despues). Un
 * prompt ilegible no se puede interpretar como nada: no muta nada.
 */
export function decodeMetadata(raw: string | null): CorrectionMetadata | null {
  if (raw === null || raw.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const candidate = parsed as Partial<CorrectionMetadata> & {
    accounts?: unknown;
    review?: unknown;
  };
  if (typeof candidate.origin !== 'string' || candidate.origin.length === 0) {
    return null;
  }
  switch (candidate.kind) {
    case 'offer':
    case 'amount':
      return { kind: candidate.kind, origin: candidate.origin };
    case 'accounts': {
      if (!Array.isArray(candidate.accounts) || candidate.accounts.length === 0) {
        return null;
      }
      const accounts = candidate.accounts.filter(
        (account): account is { id: string; label: string } =>
          typeof account === 'object' &&
          account !== null &&
          typeof (account as { id?: unknown }).id === 'string' &&
          typeof (account as { label?: unknown }).label === 'string',
      );
      if (accounts.length !== candidate.accounts.length) {
        return null;
      }
      return { kind: 'accounts', origin: candidate.origin, accounts };
    }
    case 'review': {
      const review = candidate.review as { before?: unknown; after?: unknown } | undefined;
      if (
        typeof review?.before !== 'string' ||
        review.before.length === 0 ||
        typeof review.after !== 'string' ||
        review.after.length === 0
      ) {
        return null;
      }
      return { kind: 'review', origin: candidate.origin, review: { before: review.before, after: review.after } };
    }
    default:
      return null;
  }
}
