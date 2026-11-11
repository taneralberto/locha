import { boundedFetch } from '../src/http/bounded-fetch';

const OPTIONS = {
  url: 'https://ejemplo.test/dato',
  timeoutMs: 200,
  maxResponseBytes: 1024,
};

describe('boundedFetch', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('cancela el cuerpo de una respuesta de error aunque la cancelacion se cuelgue', async () => {
    let cancelled = false;
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('error'));
          },
          cancel() {
            cancelled = true;
            // La cancelacion nunca termina: no puede romper el plazo ni el apagado.
            return new Promise<void>(() => undefined);
          },
        }),
        { status: 503 },
      ),
    );

    await expect(boundedFetch(OPTIONS)).rejects.toMatchObject({ reason: 'http' });
    expect(cancelled).toBe(true);
  }, 5000);

  it('aborta el transporte cuando la respuesta es un error', async () => {
    let signal: AbortSignal | null | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal;
      return Promise.resolve(new Response('error', { status: 500 }));
    });

    await expect(boundedFetch(OPTIONS)).rejects.toMatchObject({ reason: 'http' });
    expect(signal?.aborted).toBe(true);
  });

  it('no deja la promesa rechazada de una cancelacion sin manejar', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      fetchMock.mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('error'));
            },
            cancel() {
              return Promise.reject(new Error('no se pudo cancelar'));
            },
          }),
          { status: 500 },
        ),
      );

      await expect(boundedFetch(OPTIONS)).rejects.toMatchObject({ reason: 'http' });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(rejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('no devuelve un resultado parcial cuando la llamada se cancela', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(streamController) {
                streamController.enqueue(new TextEncoder().encode('parcial'));
                init.signal?.addEventListener('abort', () => {
                  try {
                    streamController.close();
                  } catch {
                    // El cuerpo ya estaba cerrado: no hay nada que hacer.
                  }
                });
              },
            }),
            { status: 200 },
          ),
        ),
    );

    const pending = boundedFetch({ ...OPTIONS, signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ reason: 'cancelled' });
  });

  it('cancela la lectura cuando la respuesta excede el limite de bytes', async () => {
    let cancelled = false;
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('x'.repeat(100)));
          },
          cancel() {
            cancelled = true;
            return Promise.resolve();
          },
        }),
        { status: 200 },
      ),
    );

    await expect(boundedFetch({ ...OPTIONS, maxResponseBytes: 10 })).rejects.toMatchObject({
      reason: 'too_large',
    });
    expect(cancelled).toBe(true);
  });

  it('informa un tiempo agotado cuando el servidor manda las cabeceras y se cuelga', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                init.signal?.addEventListener('abort', () =>
                  controller.error(new DOMException('abortado', 'AbortError')),
                );
              },
            }),
            { status: 200 },
          ),
        ),
    );

    await expect(boundedFetch({ ...OPTIONS, timeoutMs: 50 })).rejects.toMatchObject({
      reason: 'timeout',
    });
  });
});
