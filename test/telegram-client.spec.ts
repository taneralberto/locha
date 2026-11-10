import { TelegramSettings } from '../src/config/configuration';
import { TelegramApiClient, TelegramError } from '../src/telegram/telegram-client';

const SETTINGS: TelegramSettings = {
  enabled: true,
  partial: false,
  botToken: 'token-secreto',
  allowedUserId: 111,
  allowedChatId: 111,
  timeoutMs: 1_000,
  maxResponseBytes: 65_536,
  pollTimeoutSeconds: 1,
};

describe('TelegramApiClient', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function client(): TelegramApiClient {
    return new TelegramApiClient(SETTINGS, 'https://api.telegram.org');
  }

  it('consulta las actualizaciones con el offset y el tiempo de espera', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: [
            {
              update_id: 7,
              message: {
                message_id: 3,
                date: 1_700_000_000,
                chat: { id: 111, type: 'private' },
                from: { id: 111, is_bot: false },
                text: 'Helado 2 dolares',
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const updates = await client().getUpdates(5, 25);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.updateId).toBe(7);
    expect(updates[0]?.message?.text).toBe('Helado 2 dolares');
    expect(updates[0]?.message?.chatId).toBe('111');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/bot');
    expect(url).toContain('getUpdates');
    expect(url).toContain('offset=5');
    expect(url).toContain('timeout=25');
    expect(init.method).toBe('GET');
  });

  it('envia el mensaje con el chat y el texto', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 }),
    );

    await client().sendMessage('111', 'Registrado');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('sendMessage');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ chat_id: 111, text: 'Registrado' });
  });

  it('rechaza un envio que no devuelve el sobre de la API', async () => {
    const respuestas = [
      new Response('no soy json', { status: 200 }),
      new Response(JSON.stringify({ ok: false, description: 'error' }), { status: 200 }),
      new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }),
      new Response(JSON.stringify({ ok: true, result: { message_id: 'nueve' } }), { status: 200 }),
    ];
    for (const response of respuestas) {
      fetchMock.mockResolvedValue(response);

      await expect(client().sendMessage('111', 'Registrado')).rejects.toMatchObject({
        reason: 'invalid',
      });
    }
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

    await expect(client().getUpdates(1, 1)).rejects.toMatchObject({ reason: 'http' });
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  it('no deja la credencial en el mensaje de error', async () => {
    fetchMock.mockResolvedValue(new Response('error', { status: 401 }));

    await expect(client().getUpdates(1, 1)).rejects.toMatchObject({
      reason: 'http',
      message: expect.not.stringContaining('token-secreto'),
    });
  });

  it('informa un tiempo agotado sin detalle', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('abortado', 'AbortError')),
          );
        }),
    );

    await expect(client().getUpdates(1, 1)).rejects.toMatchObject({ reason: 'timeout' });
  });

  it('descarta una respuesta desmedida', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: 'x'.repeat(5000) }), { status: 200 }),
    );
    const limited = new TelegramApiClient(
      { ...SETTINGS, maxResponseBytes: 128 },
      'https://api.telegram.org',
    );

    await expect(limited.getUpdates(1, 1)).rejects.toBeInstanceOf(TelegramError);
  });

  it('ignora las actualizaciones que no tienen la forma esperada', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: [{ update_id: 'no-es-un-numero' }, { update_id: 9, edited_message: {} }],
        }),
        { status: 200 },
      ),
    );

    const updates = await client().getUpdates(1, 1);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.updateId).toBe(9);
    expect(updates[0]?.message).toBeNull();
  });

  it('salta una actualizacion con una fecha fuera de rango sin perder el lote', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: [
            {
              update_id: 10,
              message: {
                date: Number.MAX_SAFE_INTEGER,
                chat: { id: 111, type: 'private' },
                from: { id: 111 },
                text: 'Helado',
              },
            },
            {
              update_id: 11,
              message: {
                date: 1_700_000_000,
                chat: { id: 111, type: 'private' },
                from: { id: 111 },
                text: 'Cafe',
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const updates = await client().getUpdates(1, 1);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.updateId).toBe(11);
    expect(updates[0]?.message?.text).toBe('Cafe');
  });
});
