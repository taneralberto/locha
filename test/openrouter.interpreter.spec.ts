import { AiConfig } from '../src/config/configuration';
import { InterpreterError, InterpreterRequest } from '../src/interpreter/interpreter';
import { OpenRouterInterpreter } from '../src/interpreter/openrouter.interpreter';

const REQUEST: InterpreterRequest = {
  text: 'Helado 2 dolares',
  accounts: [{ id: 'cuenta-1', name: 'Efectivo', currency: 'USD' }],
  defaultDate: '2026-11-10',
  pending: null,
  debts: [],
  debtsTruncated: false,
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
  debt: null,
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
          required: ['amount', 'currency', 'accountId', 'kind', 'occurredOn', 'description', 'debt'],
        },
      },
    });
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer clave-de-prueba');
  });

  it('exige el objeto de deuda en la respuesta del modelo', async () => {
    const { debt: _debt, ...withoutDebt } = VALID_OPERATION;
    fetchMock.mockResolvedValue(providerResponse(withoutDebt));
    const interpreter = new OpenRouterInterpreter(config());

    await expect(interpreter.interpret(REQUEST)).rejects.toMatchObject({
      reason: 'invalid',
    });
  });

  it('acepta las operaciones de deuda con sus datos y rechaza un objeto incompleto', async () => {
    fetchMock.mockResolvedValue(
      providerResponse({
        ...VALID_OPERATION,
        kind: 'debt_settle',
        debt: {
          direction: 'payable',
          counterparty: 'Carmen',
          debtId: null,
          settlementMode: 'partial',
          status: null,
          queryDetail: null,
        },
      }),
    );
    const interpreter = new OpenRouterInterpreter(config());

    const operation = await interpreter.interpret(REQUEST);
    expect(operation.kind).toBe('debt_settle');
    expect(operation.debt).toMatchObject({ direction: 'payable', counterparty: 'Carmen' });

    fetchMock.mockResolvedValue(
      providerResponse({
        ...VALID_OPERATION,
        kind: 'debt_settle',
        debt: { direction: 'payable' },
      }),
    );
    await expect(interpreter.interpret(REQUEST)).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('el prompt explica las deudas en espanol con ejemplos de las dos direcciones', async () => {
    fetchMock.mockResolvedValue(providerResponse(VALID_OPERATION));
    const interpreter = new OpenRouterInterpreter(config());

    await interpreter.interpret(REQUEST);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    void url;
    const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
    const system = body.messages[0]?.content ?? '';
    expect(system).toContain('Reglas de deudas');
    expect(system).toContain('kind "debt_create"');
    expect(system).toContain('kind "debt_settle"');
    expect(system).toContain('kind "debt_query"');
    expect(system).toContain('le debo 8$ a Carmen de dos tortas');
    expect(system).toContain('Carmen me debe 8$');
    expect(system).toContain('"Carmen me pagó" -> kind "debt_settle", debt.settlementMode null, amount null');
    expect(system).toContain('"ya le pagué todo" -> kind "debt_settle", debt.settlementMode "full", amount null');
    expect(system).toContain('nunca se paga todo sin que el usuario lo pida');
    expect(system).toContain('Nunca elijas un id de la lista de deudas por tu cuenta');
    expect(system).toContain('Crear una deuda NO es un gasto ni un ingreso');
  });

  it('recibe el flag de detalle de la consulta y exige que venga en el objeto de deuda', async () => {
    fetchMock.mockResolvedValue(
      providerResponse({
        ...VALID_OPERATION,
        kind: 'debt_query',
        debt: {
          direction: 'payable',
          counterparty: 'Luis',
          debtId: null,
          settlementMode: null,
          status: null,
          queryDetail: true,
        },
      }),
    );
    const interpreter = new OpenRouterInterpreter(config());

    const operation = await interpreter.interpret(REQUEST);
    expect(operation.kind).toBe('debt_query');
    expect(operation.debt?.queryDetail).toBe(true);
    expect(operation.debt?.counterparty).toBe('Luis');

    // Sin el flag, el objeto de deuda no cumple el esquema estricto.
    fetchMock.mockResolvedValue(
      providerResponse({
        ...VALID_OPERATION,
        kind: 'debt_query',
        debt: {
          direction: 'payable',
          counterparty: 'Luis',
          debtId: null,
          settlementMode: null,
          status: null,
        },
      }),
    );
    await expect(interpreter.interpret(REQUEST)).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('recibe el filtro de estado pending de la consulta', async () => {
    fetchMock.mockResolvedValue(
      providerResponse({
        ...VALID_OPERATION,
        kind: 'debt_query',
        debt: {
          direction: 'payable',
          counterparty: 'Luis',
          debtId: null,
          settlementMode: null,
          status: 'pending',
          queryDetail: true,
        },
      }),
    );
    const interpreter = new OpenRouterInterpreter(config());

    const operation = await interpreter.interpret(REQUEST);
    expect(operation.debt?.status).toBe('pending');
    expect(operation.debt?.queryDetail).toBe(true);
  });

  it('el prompt explica el detalle de la consulta como una lectura, no un pago', async () => {
    fetchMock.mockResolvedValue(providerResponse(VALID_OPERATION));
    const interpreter = new OpenRouterInterpreter(config());

    await interpreter.interpret(REQUEST);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    void url;
    const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
    const system = body.messages[0]?.content ?? '';
    expect(system).toContain('debt.queryDetail');
    expect(system).toContain('Es una LECTURA, no un pago');
    expect(system).toContain('Basta con pedir el monto inicial');
    expect(system).toContain(
      '"y cuánto le debía inicialmente a Luis?" -> kind "debt_query", debt.queryDetail true, debt.counterparty "Luis", debt.direction "payable"',
    );
    expect(system).toContain(
      '"¿Cuánto me debía Luis inicialmente?" -> kind "debt_query", debt.queryDetail true, debt.counterparty "Luis", debt.direction "receivable"',
    );
    expect(system).toContain('"cuánto le he pagado a Luis" -> kind "debt_query", debt.queryDetail true');
    expect(system).toContain('"cuánto me han pagado de la deuda" -> kind "debt_query", debt.queryDetail true');
    expect(system).toContain('debt.queryDetail: null si el usuario pregunta por el saldo actual o pide el resumen');
    expect(system).toContain('"pending" si pide las deudas que todavía no están saldadas');
  });

  it('el prompt lleva las deudas candidatas, avisa si la lista se corta y no recorta el mensaje', async () => {
    fetchMock.mockResolvedValue(providerResponse(VALID_OPERATION));
    const interpreter = new OpenRouterInterpreter(config());

    await interpreter.interpret({
      ...REQUEST,
      text: 'le pagué 3 dólares a Carmen',
      debts: [
        {
          id: 'deuda-1',
          direction: 'payable',
          counterparty: 'Carmen',
          currency: 'USD',
          outstanding: '8.00',
          status: 'open',
          occurredOn: '2026-11-01',
          description: 'dos tortas',
        },
      ],
      debtsTruncated: true,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    void url;
    const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
    const user = body.messages[1]?.content ?? '';
    expect(user).toContain('deuda-1 | lo que debo | Carmen | USD | pendiente 8.00 | open');
    expect(user).toContain('la lista de deudas esta truncada');
    expect(user).toContain('le pagué 3 dólares a Carmen');
    // El mensaje del usuario va entero y al final.
    expect(user.endsWith('le pagué 3 dólares a Carmen')).toBe(true);
  });

  it('el prompt enruta las preguntas contextuales y las separa de las independientes', async () => {
    fetchMock.mockResolvedValue(providerResponse(VALID_OPERATION));
    const interpreter = new OpenRouterInterpreter(config());

    await interpreter.interpret(REQUEST);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    void url;
    const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
    const system = body.messages[0]?.content ?? '';
    expect(system).toContain('kind "debt_follow_up"');
    expect(system).toContain('¿y cuánto le debía inicialmente?');
    expect(system).toContain('¿y Carmen?');
    // La pregunta con la persona nombrada sigue siendo una consulta normal.
    expect(system).toContain('NO lo uses si la pregunta es independiente y completa');
    expect(system).toContain('¿qué le debo a Luis?');
    // Y una correccion o un pago no son una pregunta de seguimiento.
    expect(system).toContain('NO lo uses si el mensaje corrige algo o paga');
    expect(system).toContain('ya le pagué 5 a Luis');
  });

  it('el prompt enruta los refinamientos del listado y separa las consultas completas', async () => {
    fetchMock.mockResolvedValue(providerResponse(VALID_OPERATION));
    const interpreter = new OpenRouterInterpreter(config());

    await interpreter.interpret(REQUEST);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    void url;
    const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
    const system = body.messages[0]?.content ?? '';
    // Un refinamiento del listado es elíptico: no necesita signos de interrogación.
    expect(system).toContain('refina un listado anterior');
    expect(system).toContain('"Lo que debo nada más"');
    expect(system).toContain('"de esas, solo las que tengo por cobrar"');
    expect(system).toContain('"Lo que debo nada más" (después de un listado de deudas) -> kind "debt_follow_up"');
    // Una consulta por dirección que no nombra a nadie es autosuficiente.
    expect(system).toContain('NO lo uses si la consulta es autosuficiente');
    expect(system).toContain(
      '"muéstrame mis deudas por pagar" -> kind "debt_query", debt.direction "payable", debt.counterparty null',
    );
    // Y un imperativo de consulta no es una corrección ni un pago.
    expect(system).toContain('Un imperativo de consulta');
  });

  it('el borrador no presupone que todo mensaje es una aclaracion', async () => {
    fetchMock.mockResolvedValue(providerResponse(VALID_OPERATION));
    const interpreter = new OpenRouterInterpreter(config());

    await interpreter.interpret({
      ...REQUEST,
      pending: {
        kind: 'expense',
        amount: '2.00',
        currency: 'USD',
        accountId: 'cuenta-1',
        occurredOn: '2026-11-10',
        description: 'Helado',
        sourceText: 'Helado 2 dolares',
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    void url;
    const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
    const user = body.messages[1]?.content ?? '';
    expect(user).toContain(
      'El mensaje siguiente puede ser una aclaracion, una correccion o una pregunta nueva',
    );
    expect(user).not.toContain('El mensaje siguiente es la aclaracion del usuario');
  });

  it('la llamada normal no desactiva la compresion del proveedor', async () => {
    fetchMock.mockResolvedValue(providerResponse(VALID_OPERATION));
    const interpreter = new OpenRouterInterpreter(config());

    await interpreter.interpret(REQUEST);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    void url;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // El ajuste de compresion es solo de la consulta de seguimiento.
    expect(body.plugins).toBeUndefined();
  });

  it('la operacion normal no restringe la moneda (no cambia con el contrato de seguimiento)', async () => {
    fetchMock.mockResolvedValue(
      providerResponse({ ...VALID_OPERATION, currency: 'EUR' }),
    );
    const interpreter = new OpenRouterInterpreter(config());

    // El camino normal sigue aceptando la moneda como texto: el cambio del enum es
    // solo del contrato de la consulta de seguimiento.
    const operation = await interpreter.interpret(REQUEST);
    expect(operation.currency).toBe('EUR');
  });

  it('acota el contexto: muchas deudas no hacen crecer el prompt sin limite', async () => {
    fetchMock.mockResolvedValue(providerResponse(VALID_OPERATION));
    const interpreter = new OpenRouterInterpreter(config());

    const debts = Array.from({ length: 400 }, (_value, index) => ({
      id: `deuda-${index}`,
      direction: 'payable' as const,
      counterparty: `Persona ${index}`,
      currency: 'USD' as const,
      outstanding: '8.00',
      status: 'open' as const,
      occurredOn: '2026-11-01',
      description: 'x'.repeat(200),
    }));

    await interpreter.interpret({ ...REQUEST, debts, debtsTruncated: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    void url;
    const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
    const user = body.messages[1]?.content ?? '';
    expect(user.length).toBeLessThan(10_000);
    expect(user).toContain('la lista de deudas esta truncada');
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
