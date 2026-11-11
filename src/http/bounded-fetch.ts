export type BoundedFetchFailure = 'timeout' | 'cancelled' | 'network' | 'http' | 'too_large';

/**
 * Fallo de una llamada HTTP acotada. El motivo nunca incluye la URL ni el cuerpo: la
 * credencial de Telegram viaja en la URL y no debe aparecer en ningun registro.
 */
export class BoundedFetchError extends Error {
  constructor(
    readonly reason: BoundedFetchFailure,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'BoundedFetchError';
  }
}

export interface BoundedFetchOptions {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Plazo maximo de toda la llamada: las cabeceras y la lectura del cuerpo. */
  timeoutMs: number;
  /** Tope de bytes del cuerpo que se leen. */
  maxResponseBytes: number;
  /** Cancelacion externa (por ejemplo, al apagar el bot). */
  signal?: AbortSignal;
}

export interface BoundedFetchResult {
  status: number;
  text: string;
}

/**
 * Llamada HTTP con plazo y tamano acotados. El plazo abarca **toda** la llamada: si
 * el servidor manda las cabeceras y despues se queda colgado, la lectura se aborta y
 * no se queda esperando para siempre. El cuerpo se lee con un tope de bytes.
 *
 * Es la unica forma de llamar a un servicio externo en el proyecto: la usan el
 * proveedor de inferencia y el bot de Telegram.
 */
export async function boundedFetch(options: BoundedFetchOptions): Promise<BoundedFetchResult> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new BoundedFetchError('timeout', 'El servidor no respondio a tiempo.'));
    }, options.timeoutMs);
  });

  let failed = false;
  try {
    const init: RequestInit = {
      method: options.method ?? 'GET',
      signal: controller.signal,
    };
    if (options.headers) {
      init.headers = options.headers;
    }
    if (options.body !== undefined) {
      init.body = options.body;
    }
    const response = await Promise.race([fetch(options.url, init), deadline]);
    if (!response.ok) {
      // El cuerpo de una respuesta de error no se lee: se cancela para no dejar el
      // socket abierto. La cancelacion **no se espera**: una cancelacion colgada no
      // puede romper el plazo ni el apagado (la llamada se aborta igual).
      cancelBody(response);
      throw new BoundedFetchError(
        'http',
        `El servidor respondio con estado ${response.status}.`,
        response.status,
      );
    }
    const text = await Promise.race([
      readBoundedText(response, options.maxResponseBytes, controller.signal),
      deadline,
    ]);
    return { status: response.status, text };
  } catch (error) {
    failed = true;
    if (error instanceof BoundedFetchError) {
      throw error;
    }
    if (options.signal?.aborted) {
      throw new BoundedFetchError('cancelled', 'La llamada fue cancelada.');
    }
    if (timedOut) {
      throw new BoundedFetchError('timeout', 'El servidor no respondio a tiempo.');
    }
    throw new BoundedFetchError('network', 'No se pudo completar la llamada.');
  } finally {
    if (failed) {
      // Cualquier fallo deja la llamada abortada: no queda ninguna lectura colgada.
      controller.abort();
    }
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Cancela el cuerpo de una respuesta que no se va a leer. No se espera: una
 * cancelacion colgada no puede romper el plazo ni impedir terminar. El transporte se
 * aborta igual, asi que el socket no queda abierto.
 */
function cancelBody(response: Response): void {
  const body = response.body;
  if (!body) {
    return;
  }
  try {
    void body.cancel().catch(() => undefined);
  } catch {
    // El cuerpo ya estaba cerrado o en error: no hay nada que hacer.
  }
}

/**
 * Lee el cuerpo con un tope de bytes: una respuesta desmedida se descarta sin llegar
 * a procesarse. Si se cancela la llamada, la lectura se cancela tambien.
 */
async function readBoundedText(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  const body = response.body;
  if (!body) {
    return '';
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  // La cancelacion del lector no se espera: una cancelacion colgada no puede
  // impedir terminar la lectura.
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  const onAbort = (): void => cancel();
  signal.addEventListener('abort', onAbort, { once: true });
  let received = 0;
  let text = '';
  try {
    for (;;) {
      if (signal.aborted) {
        throw new Error('La llamada fue cancelada.');
      }
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      received += chunk.value.byteLength;
      if (received > limit) {
        cancel();
        throw new BoundedFetchError('too_large', 'La respuesta excede el limite permitido.');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    // Una lectura fallida deja el cuerpo a medias: se cancela para no dejarlo abierto.
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  if (signal.aborted) {
    // Una lectura que termino despues de la cancelacion no es una respuesta: no se
    // devuelve un resultado parcial.
    throw new Error('La llamada fue cancelada.');
  }
  return text;
}
