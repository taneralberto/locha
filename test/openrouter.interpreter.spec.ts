import { AiConfig } from '../src/config/configuration';
import { InterpreterError, InterpreterRequest } from '../src/interpreter/interpreter';
import { OpenRouterInterpreter } from '../src/interpreter/openrouter.interpreter';

const REQUEST: InterpreterRequest = {
  text: 'Helado 2 dolares',
  accounts: [{ id: 'cuenta-1', name: 'Efectivo', currency: 'USD' }],
  defaultDate: '2026-11-10',
  pending: null,
};

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    openrouter: {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'modelo-de-prueba',
      apiKey: 'clave-de-prueba',
      timeoutMs: 1000,
      maxInputChars: 2000,
      maxResponseBytes: 16384,
      ...overrides.openrouter,
    },
    limits: {
      maxRequestsPerDay: 100,
      maxInputTokensPerCall: 2000,
      maxOutputTokensPerCall: 500,
      maxCostMicroUsdPerCall: 5000,
      dailyBudgetMicroUsd: 200000,
      ...overrides.limits,
    },
  };
}

/** Respuesta del proveedor con una operacion valida. */
function providerResponse(operation: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(operation) } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

const VALID_OPERATION = {
  amount: '2.00',
  currency: 'USD',
  accountId: 'cuenta-1',
  kind: 'expense',
  occurredOn: '2026-11-10',
  description: 'Helado',
};

describe('OpenRouterInterpreter', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('interpreta una operacion valida y devuelve el resultado del modelo', async () => {
    fetchMock.mockResolvedValue(providerResponse(VALID_OPERATION));
    const interpreter = new OpenRouterInterpreter(config());

    const operation = await interpreter.interpret(REQUEST);

    expect(operation).toEqual(VALID_OPERATION);
    expect(interpreter.enabled).toBe(true);
  });

  it('envia el esquema derivado, sin herramientas, con el modelo configurado', async () => {
    fetchMock.mockResolvedValue(providerResponse(VALID_OPERATION));
    const interpreter = new OpenRouterInterpreter(config());

    await interpreter.interpret(REQUEST);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('modelo-de-prueba');
    expect(body.tools).toBeUndefined();
    expect(body.max_tokens).toBe(500);
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: {
        name: 'operation',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['amount', 'currency', 'accountId', 'kind', 'occurredOn', 'description'],
        },
      },
    });
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer clave-de-prueba');
  });

  it('rechaza una respuesta que no cumple el esquema', async () => {
    fetchMock.mockResolvedValue(
      providerResponse({ ...VALID_OPERATION, cuenta: 'Efectivo' }),
    );
    const interpreter = new OpenRouterInterpreter(config());

    await expect(interpreter.interpret(REQUEST)).rejects.toMatchObject({
      reason: 'invalid',
    });
  });

  it('rechaza una respuesta que no es JSON', async () => {
    fetchMock.mockResolvedValue(new Response('no soy json', { status: 200 }));
    const interpreter = new OpenRouterInterpreter(config());

    await expect(interpreter.interpret(REQUEST)).rejects.toMatchObject({
      reason: 'invalid',
    });
  });

  it('rechaza una respuesta con un estado de error, sin repetir la llamada', async () => {
    fetchMock.mockResolvedValue(new Response('error del proveedor', { status: 429 }));
    const interpreter = new OpenRouterInterpreter(config());

    await expect(interpreter.interpret(REQUEST)).rejects.toMatchObject({
      reason: 'http',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('acota la espera y reporta un tiempo agotado', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('abortado', 'AbortError')),
          );
        }),
    );
    const interpreter = new OpenRouterInterpreter(
      config({ openrouter: { ...config().openrouter, timeoutMs: 20 } }),
    );

    await expect(interpreter.interpret(REQUEST)).rejects.toMatchObject({
      reason: 'timeout',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('no se queda esperando si el proveedor manda las cabeceras y luego se cuelga', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              // Cabeceras inmediatas y cuerpo que nunca llega.
              init.signal?.addEventListener('abort', () =>
                controller.error(new DOMException('abortado', 'AbortError')),
              );
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const interpreter = new OpenRouterInterpreter(
      config({ openrouter: { ...config().openrouter, timeoutMs: 20 } }),
    );

    await expect(interpreter.interpret(REQUEST)).rejects.toMatchObject({
      reason: 'timeout',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 5000);

  it('informa un fallo de lectura sin mostrar el detalle', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal?.addEventListener('abort', () => {
                try {
                  controller.close();
                } catch {
                  // El cuerpo ya estaba en error: no hay nada que cerrar.
                }
              });
              controller.error(new Error('detalle interno del proveedor'));
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const interpreter = new OpenRouterInterpreter(config());

    await expect(interpreter.interpret(REQUEST)).rejects.toMatchObject({
      reason: 'network',
    });
  });

  it('cancela el cuerpo de una respuesta de error y aborta la llamada', async () => {
    let cancelled = false;
    let signal: AbortSignal | null | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              // Cabeceras de error y un cuerpo que nunca termina.
              controller.enqueue(new TextEncoder().encode('error'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 503 },
        ),
      );
    });
    const interpreter = new OpenRouterInterpreter(config());

    await expect(interpreter.interpret(REQUEST)).rejects.toMatchObject({
      reason: 'http',
    });
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  it('informa un rechazo del modelo', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: null, refusal: 'no puedo' } }] }),
        { status: 200 },
      ),
    );
    const interpreter = new OpenRouterInterpreter(config());

    await expect(interpreter.interpret(REQUEST)).rejects.toMatchObject({
      reason: 'refusal',
    });
  });

  it('descarta una respuesta que excede el limite de bytes', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(5000) } }] }), {
        status: 200,
      }),
    );
    const interpreter = new OpenRouterInterpreter(
      config({ openrouter: { ...config().openrouter, maxResponseBytes: 128 } }),
    );

    await expect(interpreter.interpret(REQUEST)).rejects.toMatchObject({
      reason: 'invalid',
    });
  });

  it('no llama al proveedor si falta la credencial o el modelo', async () => {
    const withoutKey = new OpenRouterInterpreter(
      config({ openrouter: { ...config().openrouter, apiKey: '' } }),
    );
    const withoutModel = new OpenRouterInterpreter(
      config({ openrouter: { ...config().openrouter, model: '  ' } }),
    );

    expect(withoutKey.enabled).toBe(false);
    expect(withoutModel.enabled).toBe(false);
    await expect(withoutKey.interpret(REQUEST)).rejects.toBeInstanceOf(InterpreterError);
    await expect(withoutKey.interpret(REQUEST)).rejects.toMatchObject({
      reason: 'not_configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no llama al proveedor si el mensaje excede el limite de entrada', async () => {
    const interpreter = new OpenRouterInterpreter(
      config({ openrouter: { ...config().openrouter, maxInputChars: 10 } }),
    );

    await expect(interpreter.interpret(REQUEST)).rejects.toMatchObject({
      reason: 'too_long',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
