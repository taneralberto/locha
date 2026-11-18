import { Account } from '../src/accounts/account.entity';
import { AccountService } from '../src/accounts/account.service';
import { Capture } from '../src/capture/capture.entity';
import { CaptureEvent } from '../src/capture/capture-event.entity';
import { CaptureService } from '../src/capture/capture.service';
import { InferenceBudgetService } from '../src/capture/inference-budget.service';
import { AiLimits } from '../src/config/configuration';
import { DebtService } from '../src/debts/debt.service';
import { FinancialService } from '../src/financial/financial.service';
import { Movement } from '../src/financial/movement.entity';
import { DebtFollowUp } from '../src/interpreter/debt-follow-up';
import { HistoryTurn } from '../src/interpreter/history-window';
import { InterpreterError } from '../src/interpreter/interpreter';
import { Operation } from '../src/interpreter/operation.schema';
import { FakeFollowUpInterpreter } from './helpers/fake-follow-up-interpreter';
import { FakeInterpreter } from './helpers/fake-interpreter';
import { createTempDatabase, TempDatabase } from './helpers/temp-database';

const RECEIVED_AT = '2026-11-10T20:00:00.000Z';
const CHAT_ID = 'chat-1';

const LIMITS: AiLimits = {
  maxRequestsPerDay: 100,
  maxInputTokensPerCall: 2000,
  maxOutputTokensPerCall: 500,
  maxCostMicroUsdPerCall: 5000,
  dailyBudgetMicroUsd: 200000,
};

/** La pregunta contextual: depende de un turno anterior. */
const FOLLOW_UP_TEXT = '¿y cuánto le debía inicialmente?';

/** La operacion que el modelo devuelve para una pregunta contextual. */
function followUpOperation(): Operation {
  return {
    amount: null,
    currency: null,
    accountId: null,
    kind: 'debt_follow_up',
    occurredOn: null,
    description: null,
    debt: null,
  };
}

/**
 * La consulta que el modelo devuelve cuando confunde la pregunta de lectura con una
 * consulta general de deudas. La persona puede venir inventada o vacia.
 */
function debtQueryOperation(counterparty: string | null): Operation {
  return {
    amount: null,
    currency: null,
    accountId: null,
    kind: 'debt_query',
    occurredOn: null,
    description: null,
    debt: {
      direction: 'payable',
      counterparty,
      debtId: null,
      settlementMode: null,
      status: null,
      queryDetail: true,
    },
  };
}

/** La respuesta del modelo en la consulta de seguimiento. */
function answer(overrides: Partial<DebtFollowUp> = {}): DebtFollowUp {
  return {
    kind: 'debt_query',
    direction: 'payable',
    counterparty: 'Luis',
    currency: 'USD',
    status: null,
    queryDetail: true,
    ...overrides,
  };
}

/** Un gasto corriente, para dejar un borrador vivo. */
function expenseOperation(accountId: string): Operation {
  return {
    amount: '12.50',
    currency: 'USD',
    accountId,
    kind: 'expense',
    occurredOn: '2026-11-10',
    description: 'Helado',
    debt: null,
  };
}

describe('Consulta de seguimiento de deudas', () => {
  let database: TempDatabase;
  let account: Account;
  let debts: DebtService;
  let financial: FinancialService;

  beforeEach(async () => {
    database = await createTempDatabase();
    const transactions = database.transactions;
    financial = new FinancialService(transactions);
    debts = new DebtService(transactions, financial);
    account = await new AccountService(database.dataSource, transactions).add({
      name: 'Efectivo',
      currency: 'USD',
    });
    // Luis debe 10.00 USD y ya le pagaron 3.00: el pendiente son 7.00.
    const luis = await debts.create({
      sourceKey: 'deuda-luis',
      direction: 'payable',
      counterparty: 'Luis',
      money: { currency: 'USD', minor: 1000n },
      occurredOn: '2026-11-10',
    });
    await debts.settle({
      sourceKey: 'pago-luis',
      debtId: luis.debt.id,
      accountId: account.id,
      money: { currency: 'USD', minor: 300n },
      occurredOn: '2026-11-12',
      expectedOutstandingMinor: 1000n,
    });
  });

  afterEach(async () => {
    await database.cleanup();
  });

  function buildService(
    interpreter: FakeInterpreter,
    followUp: FakeFollowUpInterpreter,
    limits: AiLimits = LIMITS,
  ): CaptureService {
    return new CaptureService(
      database.dataSource,
      database.transactions,
      financial,
      interpreter,
      new InferenceBudgetService(database.transactions, limits),
      debts,
      followUp,
    );
  }

  /** La ventana del chat: dos turnos anteriores, en orden. */
  function windowOf(...turns: HistoryTurn[]): () => Promise<HistoryTurn[]> {
    return async () => turns;
  }

  async function handle(
    service: CaptureService,
    eventId: string,
    text: string,
    history: (() => Promise<HistoryTurn[]>) | null = null,
  ) {
    return service.handle({
      eventId,
      chatId: CHAT_ID,
      text,
      receivedAt: RECEIVED_AT,
      history,
    });
  }

  async function draftRow(): Promise<Capture | null> {
    return database.dataSource.getRepository(Capture).findOneBy({ chatId: CHAT_ID });
  }

  async function eventRow(eventId: string): Promise<CaptureEvent | null> {
    return database.dataSource.getRepository(CaptureEvent).findOneBy({
      eventId,
      chatId: CHAT_ID,
    });
  }

  it('responde con los datos actuales, no con los del historial', async () => {
    const interpreter = new FakeInterpreter([followUpOperation()]);
    const followUp = new FakeFollowUpInterpreter([answer()]);
    const service = buildService(interpreter, followUp);

    // El chat dice que Luis debe 10: la respuesta sale de la base de datos.
    const outcome = await handle(
      service,
      'e1',
      FOLLOW_UP_TEXT,
      windowOf(
        { role: 'user', text: '¿qué le debo a Luis?' },
        { role: 'bot', text: 'Luis — $10' },
      ),
    );

    expect(outcome.reply).toContain('Luis');
    expect(outcome.reply).toContain('Monto inicial: $10');
    // El pendiente actual (7.00), no el que decia el chat.
    expect(outcome.reply).toContain('Me falta por pagar: $7');
    expect(outcome.reply).toContain('Le he pagado: $3');
    // Es una lectura: no registra nada ni elige ninguna deuda.
    const movements = await database.dataSource.getRepository(Movement).count();
    expect(movements).toBe(1); // Solo el pago del preparo.
    expect(await draftRow()).toBeNull();
  });

  it('manda a la consulta solo los turnos anteriores y el mensaje actual una vez', async () => {
    const interpreter = new FakeInterpreter([followUpOperation()]);
    const followUp = new FakeFollowUpInterpreter([answer()]);
    const service = buildService(interpreter, followUp);

    await handle(
      service,
      'e1',
      FOLLOW_UP_TEXT,
      windowOf(
        { role: 'user', text: '¿qué le debo a Luis?' },
        { role: 'bot', text: 'Luis — $10' },
      ),
    );

    expect(followUp.requests).toHaveLength(1);
    const request = followUp.requests[0]!;
    expect(request.text).toBe(FOLLOW_UP_TEXT);
    expect(request.history).toEqual([
      { role: 'user', text: '¿qué le debo a Luis?' },
      { role: 'bot', text: 'Luis — $10' },
    ]);
    // El mensaje actual no se repite dentro de la ventana.
    expect(request.history.some((turn) => turn.text === FOLLOW_UP_TEXT)).toBe(false);
  });

  it('sin ventana no llama al proveedor y pide la persona', async () => {
    const interpreter = new FakeInterpreter([followUpOperation()]);
    const followUp = new FakeFollowUpInterpreter([answer()]);
    const service = buildService(interpreter, followUp);

    const outcome = await handle(service, 'e1', FOLLOW_UP_TEXT, null);

    expect(followUp.requests).toHaveLength(0);
    expect(outcome.reply).toContain('Escribe la persona');
    // No se listan las deudas: se pregunta.
    expect(outcome.reply).not.toContain('Lo que debo');
    expect(await draftRow()).toBeNull();
  });

  it('una persona ambigua pide aclaracion y no lista las deudas', async () => {
    const interpreter = new FakeInterpreter([followUpOperation()]);
    const followUp = new FakeFollowUpInterpreter([
      answer({ kind: 'clarify', counterparty: null }),
    ]);
    const service = buildService(interpreter, followUp);

    const outcome = await handle(
      service,
      'e1',
      FOLLOW_UP_TEXT,
      windowOf({ role: 'user', text: '¿qué le debo a Luis?' }),
    );

    expect(outcome.reply).toContain('No se sabe de quien es esa pregunta');
    expect(outcome.reply).not.toContain('Lo que debo');
    expect(await draftRow()).toBeNull();
  });

  it('una contraparte vacia no amplia la consulta', async () => {
    const interpreter = new FakeInterpreter([followUpOperation()]);
    const followUp = new FakeFollowUpInterpreter([answer({ counterparty: null })]);
    const service = buildService(interpreter, followUp);

    const outcome = await handle(
      service,
      'e1',
      FOLLOW_UP_TEXT,
      windowOf({ role: 'user', text: '¿qué le debo a Luis?' }),
    );

    // Sin contraparte no se consulta: se pide la persona.
    expect(outcome.reply).toContain('Escribe la persona');
    expect(outcome.reply).not.toContain('Lo que debo');
  });

  it('la pregunta de seguimiento no cambia el borrador vivo', async () => {
    const interpreter = new FakeInterpreter([expenseOperation(account.id), followUpOperation()]);
    const followUp = new FakeFollowUpInterpreter([answer()]);
    const service = buildService(interpreter, followUp);

    await handle(service, 'e1', 'Helado 2 dolares');
    const before = await draftRow();
    expect(before?.state).toBe('awaiting_confirmation');

    await handle(
      service,
      'e2',
      FOLLOW_UP_TEXT,
      windowOf({ role: 'user', text: '¿qué le debo a Luis?' }),
    );

    const after = await draftRow();
    expect(after?.id).toBe(before?.id);
    expect(after?.state).toBe('awaiting_confirmation');
    expect(after?.kind).toBe('expense');
    expect(after?.amount).toBe('12.50');
    expect(after?.sourceText).toBe('Helado 2 dolares');
  });

  it('/confirm no toca el historial ni reserva una segunda vez', async () => {
    const interpreter = new FakeInterpreter([expenseOperation(account.id)]);
    const followUp = new FakeFollowUpInterpreter([]);
    const service = buildService(interpreter, followUp);
    const loader = jest.fn(async () => [{ role: 'user' as const, text: 'algo' }]);

    await handle(service, 'e1', 'Helado 2 dolares');
    const usage = await new InferenceBudgetService(database.transactions, LIMITS).current();
    expect(usage?.requests).toBe(1);

    const confirmed = await handle(service, 'e2', '/confirm', loader);

    expect(confirmed.reply).toContain('Registrado');
    // El historial no se carga y no se gasta de mas.
    expect(loader).not.toHaveBeenCalled();
    expect(followUp.requests).toHaveLength(0);
    const after = await new InferenceBudgetService(database.transactions, LIMITS).current();
    expect(after?.requests).toBe(1);
  });

  it('un pago de deuda no toca el historial ni reserva una segunda vez', async () => {
    const interpreter = new FakeInterpreter([
      {
        amount: '3.00',
        currency: 'USD',
        accountId: account.id,
        kind: 'debt_settle',
        occurredOn: '2026-11-12',
        description: null,
        debt: {
          direction: 'payable',
          counterparty: 'Luis',
          debtId: null,
          settlementMode: 'partial',
          status: null,
          queryDetail: null,
        },
      },
    ]);
    const followUp = new FakeFollowUpInterpreter([]);
    const service = buildService(interpreter, followUp);
    const loader = jest.fn(async () => [{ role: 'user' as const, text: 'algo' }]);

    const outcome = await handle(service, 'e1', 'le pagué 3 dólares a Luis', loader);

    expect(loader).not.toHaveBeenCalled();
    expect(followUp.requests).toHaveLength(0);
    const usage = await new InferenceBudgetService(database.transactions, LIMITS).current();
    expect(usage?.requests).toBe(1);
    // El pago se prepara como siempre: es una operacion, no una consulta.
    expect(outcome.captureState).toBe('awaiting_confirmation');
  });

  it('el fallo del proveedor no cancela el borrador', async () => {
    const interpreter = new FakeInterpreter([expenseOperation(account.id), followUpOperation()]);
    const followUp = new FakeFollowUpInterpreter([
      new InterpreterError('network', 'Fallo de red simulado.'),
    ]);
    const service = buildService(interpreter, followUp);

    await handle(service, 'e1', 'Helado 2 dolares');
    const outcome = await handle(
      service,
      'e2',
      FOLLOW_UP_TEXT,
      windowOf({ role: 'user', text: '¿qué le debo a Luis?' }),
    );

    expect(outcome.reply).toContain('No pude resolver esa pregunta');
    expect(outcome.reply).toContain('Repitela con la persona');
    // El borrador sigue vivo: la pregunta no lo cancela.
    const draft = await draftRow();
    expect(draft?.state).toBe('awaiting_confirmation');
    expect(draft?.amount).toBe('12.50');
    // Y el evento queda cerrado (no incierto).
    expect((await eventRow('e2'))?.state).toBe('completed');
  });

  it('el presupuesto agotado no cancela el borrador', async () => {
    const interpreter = new FakeInterpreter([expenseOperation(account.id), followUpOperation()]);
    const followUp = new FakeFollowUpInterpreter([answer()]);
    // Dos llamadas por dia: la del gasto y la de la interpretacion de la pregunta.
    // La de la consulta de seguimiento se queda sin presupuesto.
    const service = buildService(interpreter, followUp, {
      ...LIMITS,
      maxRequestsPerDay: 2,
    });

    await handle(service, 'e1', 'Helado 2 dolares');
    const outcome = await handle(
      service,
      'e2',
      FOLLOW_UP_TEXT,
      windowOf({ role: 'user', text: '¿qué le debo a Luis?' }),
    );

    expect(outcome.reply).toContain('Se alcanzo el limite diario');
    // La consulta no se hizo (no hay presupuesto) y el borrador sigue vivo.
    expect(followUp.requests).toHaveLength(0);
    const draft = await draftRow();
    expect(draft?.state).toBe('awaiting_confirmation');
  });

  it('un historial que no se puede leer pide repetir la pregunta y no toca el borrador', async () => {
    const interpreter = new FakeInterpreter([expenseOperation(account.id), followUpOperation()]);
    const followUp = new FakeFollowUpInterpreter([answer()]);
    const service = buildService(interpreter, followUp);

    await handle(service, 'e1', 'Helado 2 dolares');
    const usageBefore = await new InferenceBudgetService(database.transactions, LIMITS).current();

    const outcome = await handle(service, 'e2', FOLLOW_UP_TEXT, async () => {
      throw new Error('fallo de base simulado');
    });

    expect(outcome.reply).toContain('No pude resolver esa pregunta');
    // Ni llamada al proveedor ni reserva de la consulta: el historial fallo antes.
    // La unica llamada que se cuenta es la interpretacion normal del mensaje.
    expect(followUp.requests).toHaveLength(0);
    const usageAfter = await new InferenceBudgetService(database.transactions, LIMITS).current();
    expect(usageAfter?.requests).toBe((usageBefore?.requests ?? 0) + 1);
    // El borrador sigue vivo y el evento quedo cerrado (no incierto).
    const draft = await draftRow();
    expect(draft?.state).toBe('awaiting_confirmation');
    expect(draft?.amount).toBe('12.50');
    expect((await eventRow('e2'))?.state).toBe('completed');
  });

  it('un historial que no se puede leer se reproduce con la misma respuesta', async () => {
    const interpreter = new FakeInterpreter([followUpOperation()]);
    const followUp = new FakeFollowUpInterpreter([answer()]);
    const service = buildService(interpreter, followUp);
    const loader = async (): Promise<HistoryTurn[]> => {
      throw new Error('fallo de base simulado');
    };

    const first = await handle(service, 'e1', FOLLOW_UP_TEXT, loader);
    // El mismo evento, otra vez: se reproduce la respuesta guardada, sin volver a
    // llamar al proveedor ni a leer el historial.
    const again = await handle(service, 'e1', FOLLOW_UP_TEXT, loader);

    expect(again.reply).toBe(first.reply);
    expect(again.replayed).toBe(true);
    expect(followUp.requests).toHaveLength(0);
  });

  it('un fallo de la consulta fresca se trata como fallo de solo lectura', async () => {
    const interpreter = new FakeInterpreter([expenseOperation(account.id), followUpOperation()]);
    const followUp = new FakeFollowUpInterpreter([answer()]);
    const service = buildService(interpreter, followUp);
    // La consulta de deudas (la lectura fresca) no se puede hacer: la base falla.
    const capture = service['debtCapture'];
    const spy = jest
      .spyOn(capture, 'query')
      .mockRejectedValue(new Error('fallo de base simulado'));

    try {
      await handle(service, 'e1', 'Helado 2 dolares');
      const outcome = await handle(
        service,
        'e2',
        FOLLOW_UP_TEXT,
        windowOf({ role: 'user', text: '¿qué le debo a Luis?' }),
      );

      expect(outcome.reply).toContain('No pude resolver esa pregunta');
      // No hay rutas de escritura: el borrador sigue vivo y no se registra nada.
      const draft = await draftRow();
      expect(draft?.state).toBe('awaiting_confirmation');
      expect(draft?.amount).toBe('12.50');
      expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
      expect((await eventRow('e2'))?.state).toBe('completed');
    } finally {
      spy.mockRestore();
    }
  });

  it('un evento en reading se completa sin volver a gastar y sin tocar el borrador', async () => {
    const interpreter = new FakeInterpreter([expenseOperation(account.id)]);
    const followUp = new FakeFollowUpInterpreter([answer()]);
    const service = buildService(interpreter, followUp);

    await handle(service, 'e1', 'Helado 2 dolares');
    // El evento de la consulta quedo a medias: el proceso se cae en la llamada.
    await database.dataSource.getRepository(CaptureEvent).save(
      database.dataSource.getRepository(CaptureEvent).create({
        eventId: 'e2',
        chatId: CHAT_ID,
        state: 'reading',
        reply: null,
        captureState: null,
        movementId: null,
      }),
    );
    const usageBefore = await new InferenceBudgetService(database.transactions, LIMITS).current();

    const outcome = await handle(
      service,
      'e2',
      FOLLOW_UP_TEXT,
      windowOf({ role: 'user', text: '¿qué le debo a Luis?' }),
    );

    expect(outcome.reply).toContain('No pude resolver esa pregunta');
    // No se vuelve a llamar al proveedor ni a gastar.
    expect(followUp.requests).toHaveLength(0);
    const usageAfter = await new InferenceBudgetService(database.transactions, LIMITS).current();
    expect(usageAfter?.requests).toBe(usageBefore?.requests);
    // El borrador no se toca y el evento queda cerrado con su respuesta.
    const draft = await draftRow();
    expect(draft?.state).toBe('awaiting_confirmation');
    expect(draft?.amount).toBe('12.50');
    expect((await eventRow('e2'))?.state).toBe('completed');
  });

  describe('pregunta de lectura con el clasificador caido', () => {
    /**
     * Deja un borrador vivo y manda la pregunta con un clasificador que falla.
     * Cada iteracion usa sus propios ids de evento: el evento repetido se reproduce.
     */
    async function draftAndFailure(
      text: string,
      suffix: string,
    ): Promise<{ reply: string; draft: Capture | null; state: string | null }> {
      const interpreter = new FakeInterpreter([
        expenseOperation(account.id),
        new InterpreterError('network', 'Fallo de red simulado.'),
      ]);
      const service = buildService(interpreter, new FakeFollowUpInterpreter([]));
      await handle(service, `e1-${suffix}`, 'Helado 2 dolares');
      const outcome = await handle(service, `e2-${suffix}`, text);
      const event = await database.dataSource.getRepository(CaptureEvent).findOneBy({
        eventId: `e2-${suffix}`,
        chatId: CHAT_ID,
      });
      return { reply: outcome.reply, draft: await draftRow(), state: event?.state ?? null };
    }

    it('la pregunta aprobada no cancela el borrador vivo', async () => {
      const { reply, draft, state } = await draftAndFailure(
        '¿y cuánto le debía inicialmente?',
        'aprobada',
      );

      expect(reply).toContain('No pude interpretar el mensaje');
      // El borrador sigue vivo: una pregunta no es una correccion.
      expect(draft?.state).toBe('awaiting_confirmation');
      expect(draft?.amount).toBe('12.50');
      // Y el evento queda cerrado, no incierto.
      expect(state).toBe('completed');
    });

    it('reconoce la forma con y sin tilde y con y sin signos', async () => {
      const formas = [
        '¿y cuánto le debía inicialmente?',
        '¿y cuánto le debia inicialmente?',
        'y cuánto le debía inicialmente',
        '¿cuánto le debía inicialmente?',
      ];
      for (const [index, forma] of formas.entries()) {
        const { reply, draft } = await draftAndFailure(forma, `forma-${index}`);
        expect(draft?.state).toBe('awaiting_confirmation');
        expect(reply).toContain('No pude interpretar el mensaje');
      }
    });

    it('una aclaracion posible sigue cancelando el borrador si el clasificador falla', async () => {
      // "¿y Carmen?" puede ser la aclaracion de un borrador que espera a quien: no es
      // una forma protegida y el flujo sigue siendo el de siempre.
      const { reply, draft, state } = await draftAndFailure('¿y Carmen?', 'carmen');

      expect(reply).toContain('No pude interpretar el mensaje');
      expect(draft?.state).toBe('cancelled');
      expect(state).toBe('uncertain');
    });

    it('una correccion genuina sigue cancelando el borrador si el clasificador falla', async () => {
      const { draft, state } = await draftAndFailure('no eran 8, eran 10', 'correccion');

      expect(draft?.state).toBe('cancelled');
      expect(state).toBe('uncertain');
    });

    it('una pregunta con algo detras no es una forma protegida', async () => {
      const { draft } = await draftAndFailure(
        '¿y cuánto le debía inicialmente? /confirm',
        'confirm',
      );

      expect(draft?.state).toBe('cancelled');
    });

    it('el presupuesto agotado no cancela el borrador en la pregunta de lectura', async () => {
      const interpreter = new FakeInterpreter([expenseOperation(account.id)]);
      const service = buildService(interpreter, new FakeFollowUpInterpreter([]), {
        ...LIMITS,
        maxRequestsPerDay: 1,
      });

      await handle(service, 'e1', 'Helado 2 dolares');
      const outcome = await handle(service, 'e2', '¿y cuánto le debía inicialmente?');

      expect(outcome.reply).toContain('Se alcanzo el limite diario');
      const draft = await draftRow();
      expect(draft?.state).toBe('awaiting_confirmation');
      expect(draft?.amount).toBe('12.50');
    });

    it('el clasificador deshabilitado no cancela el borrador en la pregunta de lectura', async () => {
      // El borrador se deja con un clasificador que funciona; la pregunta llega con el
      // clasificador apagado.
      const enabled = buildService(
        new FakeInterpreter([expenseOperation(account.id)]),
        new FakeFollowUpInterpreter([]),
      );
      await handle(enabled, 'e1', 'Helado 2 dolares');
      const service = buildService(new FakeInterpreter([], false), new FakeFollowUpInterpreter([]));

      const outcome = await handle(service, 'e2', '¿y cuánto le debía inicialmente?');

      expect(outcome.reply).toContain('La captura no esta configurada');
      const draft = await draftRow();
      expect(draft?.state).toBe('awaiting_confirmation');
      expect(draft?.amount).toBe('12.50');
    });

    it('un resultado transaccional inesperado para la forma no se escribe', async () => {
      // El clasificador resuelve la pregunta de lectura como un pago: no se escribe.
      const interpreter = new FakeInterpreter([
        expenseOperation(account.id),
        {
          amount: '3.00',
          currency: 'USD',
          accountId: account.id,
          kind: 'debt_settle',
          occurredOn: '2026-11-12',
          description: null,
          debt: {
            direction: 'payable',
            counterparty: 'Luis',
            debtId: null,
            settlementMode: 'partial',
            status: null,
            queryDetail: null,
          },
        },
      ]);
      const service = buildService(interpreter, new FakeFollowUpInterpreter([]));

      const movementsBefore = await database.dataSource.getRepository(Movement).count();
      await handle(service, 'e1', 'Helado 2 dolares');
      const outcome = await handle(service, 'e2', '¿y cuánto le debía inicialmente?');

      expect(outcome.reply).toContain('No pude resolver esa pregunta');
      // El borrador no se toca y no se registra nada.
      const draft = await draftRow();
      expect(draft?.state).toBe('awaiting_confirmation');
      expect(draft?.amount).toBe('12.50');
      expect(await database.dataSource.getRepository(Movement).count()).toBe(movementsBefore);
    });

    it('una llamada interrumpida se completa sin gastar y sin tocar el borrador', async () => {
      const interpreter = new FakeInterpreter([expenseOperation(account.id)]);
      const followUp = new FakeFollowUpInterpreter([answer()]);
      const service = buildService(interpreter, followUp);

      await handle(service, 'e1', 'Helado 2 dolares');
      // El evento quedo en 'reading' (la marca durable va antes de la inferencia
      // primaria): el proceso se cae.
      await database.dataSource.getRepository(CaptureEvent).save(
        database.dataSource.getRepository(CaptureEvent).create({
          eventId: 'e2',
          chatId: CHAT_ID,
          state: 'reading',
          reply: null,
          captureState: null,
          movementId: null,
        }),
      );
      const usageBefore = await new InferenceBudgetService(database.transactions, LIMITS).current();

      const outcome = await handle(service, 'e2', '¿y cuánto le debía inicialmente?');

      expect(outcome.reply).toContain('No pude resolver esa pregunta');
      // No se llama al clasificador ni al proveedor, y no se gasta.
      expect(interpreter.requests).toHaveLength(1); // Solo la del gasto.
      expect(followUp.requests).toHaveLength(0);
      const usageAfter = await new InferenceBudgetService(database.transactions, LIMITS).current();
      expect(usageAfter?.requests).toBe(usageBefore?.requests);
      // El borrador no se toca.
      const draft = await draftRow();
      expect(draft?.state).toBe('awaiting_confirmation');
      expect(draft?.amount).toBe('12.50');
    });
  });

  describe('pregunta de lectura clasificada como consulta', () => {
    /**
     * Un trigger de SQLite que prohibe pasar a 'reading'. Si la fila de la pregunta
     * naciera en 'processing' y se marcara despues, la escritura fallaria.
     */
    async function blockReadingTransition(): Promise<void> {
      await database.dataSource.query(
        `CREATE TRIGGER "bloquea_reading" BEFORE UPDATE ON "capture_event" WHEN NEW."state" = 'reading' BEGIN SELECT RAISE(ABORT, 'no se permite pasar a reading'); END`,
      );
    }

    /**
     * Un trigger que prohibe cerrar un evento que sigue en 'reading': el cierre falla
     * y la fila se queda a medias, como si el proceso se hubiera caido.
     */
    async function blockCompletion(): Promise<void> {
      await database.dataSource.query(
        `CREATE TRIGGER "bloquea_cierre" BEFORE UPDATE ON "capture_event" WHEN NEW."state" = 'completed' AND OLD."state" = 'reading' BEGIN SELECT RAISE(ABORT, 'no se permite cerrar el evento'); END`,
      );
    }

    async function unblockCompletion(): Promise<void> {
      await database.dataSource.query(`DROP TRIGGER "bloquea_cierre"`);
    }

    /** Anota el estado con el que **nace** cada evento. */
    async function trackBornStates(): Promise<void> {
      await database.dataSource.query(
        `CREATE TABLE "estados_nacidos" ("state" varchar NOT NULL)`,
      );
      await database.dataSource.query(
        `CREATE TRIGGER "anota_nacimiento" AFTER INSERT ON "capture_event" BEGIN INSERT INTO "estados_nacidos" ("state") VALUES (NEW."state"); END`,
      );
    }

    /** Los estados con los que nacieron los eventos, en orden. */
    async function bornStates(): Promise<string[]> {
      const rows = (await database.dataSource.query(
        `SELECT "state" FROM "estados_nacidos" ORDER BY "rowid"`,
      )) as Array<{ state: string }>;
      return rows.map((row) => row.state);
    }

    it('una consulta clasificada de la forma inequivoca pide la persona y no lista las deudas', async () => {
      // Varias deudas: una consulta general las listaria todas.
      await debts.create({
        sourceKey: 'deuda-carmen',
        direction: 'payable',
        counterparty: 'Carmen',
        money: { currency: 'USD', minor: 400n },
        occurredOn: '2026-11-10',
      });
      const interpreter = new FakeInterpreter([
        expenseOperation(account.id),
        debtQueryOperation(null),
      ]);
      const followUp = new FakeFollowUpInterpreter([]);
      const service = buildService(interpreter, followUp);

      await handle(service, 'e1', 'Helado 2 dolares');
      const before = await draftRow();

      // La ventana se lee, pero viene vacia: no hay a quien se refiere la pregunta.
      const loader = jest.fn(async () => []);
      const outcome = await handle(service, 'e2', FOLLOW_UP_TEXT, loader);

      // Se pide la persona. La respuesta de ejemplo menciona a Luis: lo que no puede
      // aparecer es otra persona, una fila de deuda, un importe o un abono.
      expect(outcome.reply).toContain('Escribe la persona');
      expect(outcome.reply).not.toContain('Carmen');
      expect(outcome.reply).not.toContain('Lo que debo');
      expect(outcome.reply).not.toContain('•');
      expect(outcome.reply).not.toContain('Monto inicial');
      expect(outcome.reply).not.toContain('Le he pagado');
      expect(outcome.reply).not.toContain('$10');
      expect(outcome.reply).not.toContain('$7');
      expect(outcome.reply).not.toContain('$4');
      // La ventana se lee una vez y no hay una segunda llamada al proveedor.
      expect(loader).toHaveBeenCalledTimes(1);
      expect(followUp.requests).toHaveLength(0);
      expect(interpreter.requests).toHaveLength(2);
      // El borrador queda igual: id, estado, tipo, importe y texto original.
      const after = await draftRow();
      expect(after?.id).toBe(before?.id);
      expect(after?.state).toBe(before?.state);
      expect(after?.kind).toBe(before?.kind);
      expect(after?.amount).toBe(before?.amount);
      expect(after?.sourceText).toBe(before?.sourceText);
      expect(after?.debtPayload).toBe(before?.debtPayload);
      // Y no se registra nada.
      expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
    });

    it('una consulta clasificada de la forma inequivoca ignora el nombre que invento el modelo', async () => {
      const interpreter = new FakeInterpreter([
        expenseOperation(account.id),
        debtQueryOperation('Inventado'),
      ]);
      const followUp = new FakeFollowUpInterpreter([answer()]);
      const service = buildService(interpreter, followUp);

      await handle(service, 'e1', 'Helado 2 dolares');
      const before = await draftRow();

      const outcome = await handle(
        service,
        'e2',
        FOLLOW_UP_TEXT,
        windowOf({ role: 'user', text: '¿qué le debo a Luis?' }),
      );

      // La persona sale de la ventana del chat: el nombre del modelo no se usa.
      expect(outcome.reply).toContain('Luis');
      expect(outcome.reply).toContain('Monto inicial: $10');
      expect(outcome.reply).not.toContain('Inventado');
      // La ventana se resuelve con su propia llamada.
      expect(followUp.requests).toHaveLength(1);
      // El borrador no se toca.
      const after = await draftRow();
      expect(after?.id).toBe(before?.id);
      expect(after?.state).toBe('awaiting_confirmation');
      expect(after?.amount).toBe('12.50');
    });

    it('la fila de la pregunta nace en reading y no pasa por processing', async () => {
      await blockReadingTransition();
      await trackBornStates();

      const interpreter = new FakeInterpreter([
        expenseOperation(account.id),
        followUpOperation(),
      ]);
      const followUp = new FakeFollowUpInterpreter([answer()]);
      const service = buildService(interpreter, followUp);

      await handle(service, 'e1', 'Helado 2 dolares');
      const outcome = await handle(
        service,
        'e2',
        FOLLOW_UP_TEXT,
        windowOf({ role: 'user', text: '¿qué le debo a Luis?' }),
      );

      // La respuesta es la de siempre: el trigger que prohibe 'reading' no disparo.
      expect(outcome.reply).toContain('Monto inicial: $10');
      // Y la fila nacio en 'reading': no hubo ninguna transicion.
      expect(await bornStates()).toEqual(['processing', 'reading']);
      // El borrador no se toca.
      const draft = await draftRow();
      expect(draft?.state).toBe('awaiting_confirmation');
      expect(draft?.amount).toBe('12.50');
    });

    it('una interrupcion despues de insertar deja el borrador vivo y el reintento no clasifica ni gasta', async () => {
      const interpreter = new FakeInterpreter([
        expenseOperation(account.id),
        debtQueryOperation(null),
      ]);
      const followUp = new FakeFollowUpInterpreter([]);
      const service = buildService(interpreter, followUp);

      await handle(service, 'e1', 'Helado 2 dolares');

      // El cierre del evento falla: la fila se queda en 'reading', como si el proceso
      // se hubiera caido despues de escribirla.
      await blockCompletion();
      await expect(handle(service, 'e2', FOLLOW_UP_TEXT, async () => [])).rejects.toThrow();

      expect((await eventRow('e2'))?.state).toBe('reading');
      const usageAfterFailure = await new InferenceBudgetService(
        database.transactions,
        LIMITS,
      ).current();
      await unblockCompletion();

      // El reintento completa la respuesta sin volver a clasificar ni a gastar.
      const outcome = await handle(service, 'e2', FOLLOW_UP_TEXT, async () => []);

      expect(outcome.reply).toContain('No pude resolver esa pregunta');
      expect(interpreter.requests).toHaveLength(2);
      expect(followUp.requests).toHaveLength(0);
      const usageAfterRetry = await new InferenceBudgetService(
        database.transactions,
        LIMITS,
      ).current();
      expect(usageAfterRetry?.requests).toBe(usageAfterFailure?.requests);
      // El borrador sigue vivo: la pregunta no lo cancela.
      const draft = await draftRow();
      expect(draft?.state).toBe('awaiting_confirmation');
      expect(draft?.amount).toBe('12.50');
      // Y el evento queda cerrado con su respuesta.
      expect((await eventRow('e2'))?.state).toBe('completed');
    });

    it('el replay de la consulta no vuelve a gastar ni a tocar el borrador', async () => {
      const interpreter = new FakeInterpreter([
        expenseOperation(account.id),
        debtQueryOperation(null),
      ]);
      const followUp = new FakeFollowUpInterpreter([]);
      const service = buildService(interpreter, followUp);

      await handle(service, 'e1', 'Helado 2 dolares');
      const loader = jest.fn(async () => []);
      const first = await handle(service, 'e2', FOLLOW_UP_TEXT, loader);
      const usage = await new InferenceBudgetService(database.transactions, LIMITS).current();

      const again = await handle(service, 'e2', FOLLOW_UP_TEXT, loader);

      expect(again.reply).toBe(first.reply);
      expect(again.replayed).toBe(true);
      // No se vuelve a clasificar ni a cargar la ventana.
      expect(interpreter.requests).toHaveLength(2);
      expect(followUp.requests).toHaveLength(0);
      expect(loader).toHaveBeenCalledTimes(1);
      const usageAfter = await new InferenceBudgetService(database.transactions, LIMITS).current();
      expect(usageAfter?.requests).toBe(usage?.requests);
      // El borrador sigue igual.
      const draft = await draftRow();
      expect(draft?.state).toBe('awaiting_confirmation');
      expect(draft?.amount).toBe('12.50');
    });

    it('el replay de una correccion que no se pudo interpretar conserva la politica anterior', async () => {
      const interpreter = new FakeInterpreter([
        expenseOperation(account.id),
        new InterpreterError('network', 'Fallo de red simulado.'),
      ]);
      const service = buildService(interpreter, new FakeFollowUpInterpreter([]));

      await handle(service, 'e1', 'Helado 2 dolares');
      const failed = await handle(service, 'e2', 'no eran 8, eran 10');

      // Una correccion que no se pudo interpretar cancela el borrador: es una correccion.
      expect(failed.reply).toContain('Vuelve a enviar el mensaje completo');
      expect((await draftRow())?.state).toBe('cancelled');
      expect((await eventRow('e2'))?.state).toBe('uncertain');

      const replay = await handle(service, 'e2', 'no eran 8, eran 10');

      // El replay reproduce la respuesta y no vuelve a interpretar.
      expect(replay.reply).toBe(failed.reply);
      expect(replay.replayed).toBe(true);
      expect(interpreter.requests).toHaveLength(2);
      // Y el borrador sigue cancelado: la politica anterior no se mueve.
      expect((await draftRow())?.state).toBe('cancelled');
    });
  });

  describe('grupo por direccion (deuda_group)', () => {
    /**
     * La respuesta del modelo contextual: un grupo por direccion, sin persona. La
     * direccion puede venir nula o con una persona: las dos son contradictorias.
     */
    function groupAnswer(
      direction: 'payable' | 'receivable' | null,
      counterparty: string | null = null,
      overrides: Partial<DebtFollowUp> = {},
    ): DebtFollowUp {
      return {
        kind: 'debt_group',
        direction,
        counterparty,
        currency: null,
        status: null,
        queryDetail: null,
        ...overrides,
      };
    }

    /** Rita abierta (12.00), Nico parcial (5.00, pagado 2.00) y Beto saldada (9.00). */
    async function seedGrupo(): Promise<void> {
      await debts.create({
        sourceKey: 'deuda-rita',
        direction: 'payable',
        counterparty: 'Rita',
        money: { currency: 'USD', minor: 1200n },
        occurredOn: '2026-11-08',
      });
      const nico = (
        await debts.create({
          sourceKey: 'deuda-nico',
          direction: 'payable',
          counterparty: 'Nico',
          money: { currency: 'USD', minor: 500n },
          occurredOn: '2026-11-09',
        })
      ).debt;
      await debts.settle({
        sourceKey: 'pago-nico',
        debtId: nico.id,
        accountId: account.id,
        money: { currency: 'USD', minor: 200n },
        occurredOn: '2026-11-10',
        expectedOutstandingMinor: 500n,
      });
      const beto = (
        await debts.create({
          sourceKey: 'deuda-beto',
          direction: 'payable',
          counterparty: 'Beto',
          money: { currency: 'USD', minor: 900n },
          occurredOn: '2026-11-07',
        })
      ).debt;
      await debts.settle({
        sourceKey: 'pago-beto',
        debtId: beto.id,
        accountId: account.id,
        money: { currency: 'USD', minor: 900n },
        occurredOn: '2026-11-10',
        expectedOutstandingMinor: 900n,
      });
    }

    it('un grupo por direccion lista solo ese lado y no toca el borrador', async () => {
      // Una deuda del lado contrario: no tiene que aparecer en la respuesta.
      await debts.create({
        sourceKey: 'deuda-ana',
        direction: 'receivable',
        counterparty: 'Ana',
        money: { currency: 'USD', minor: 900n },
        occurredOn: '2026-11-10',
      });
      const interpreter = new FakeInterpreter([followUpOperation()]);
      const followUp = new FakeFollowUpInterpreter([groupAnswer('payable')]);
      const service = buildService(interpreter, followUp);

      const outcome = await handle(
        service,
        'e1',
        'Lo que debo nada más',
        windowOf({ role: 'user', text: 'cuáles son mis deudas?' }),
      );

      // Solo el lado pedido, con el pendiente actual (10.00 menos 3.00).
      expect(outcome.reply).toContain('Lo que debo');
      expect(outcome.reply).toContain('Luis');
      expect(outcome.reply).toContain('$7');
      expect(outcome.reply).not.toContain('Lo que me deben');
      expect(outcome.reply).not.toContain('Ana');
      // Es una lectura: no registra nada ni deja borrador vivo.
      expect(await draftRow()).toBeNull();
      expect(await database.dataSource.getRepository(Movement).count()).toBe(1); // Solo el pago del preparo.
    });

    it('un grupo sin direccion pide aclarar y no lista las deudas', async () => {
      const interpreter = new FakeInterpreter([followUpOperation()]);
      const followUp = new FakeFollowUpInterpreter([groupAnswer(null)]);
      const service = buildService(interpreter, followUp);

      const outcome = await handle(
        service,
        'e1',
        'Lo que debo nada más',
        windowOf({ role: 'user', text: 'cuáles son mis deudas?' }),
      );

      expect(outcome.reply).toContain('No se sabe de quien es esa pregunta');
      // Fail-closed: no se lista ni el grupo ni la persona.
      expect(outcome.reply).not.toContain('Lo que debo');
      expect(outcome.reply).not.toContain('•');
      expect(outcome.reply).not.toContain('$7');
      expect(await draftRow()).toBeNull();
    });

    it('un grupo con una persona es contradictorio y pide aclarar', async () => {
      const interpreter = new FakeInterpreter([followUpOperation()]);
      const followUp = new FakeFollowUpInterpreter([groupAnswer('payable', 'Luis')]);
      const service = buildService(interpreter, followUp);

      const outcome = await handle(
        service,
        'e1',
        'Lo que debo nada más',
        windowOf({ role: 'user', text: 'cuáles son mis deudas?' }),
      );

      expect(outcome.reply).toContain('No se sabe de quien es esa pregunta');
      expect(outcome.reply).not.toContain('Lo que debo');
      expect(outcome.reply).not.toContain('$7');
    });

    it('un grupo con una contraparte vacia o de espacios es contradictorio y pide aclarar', async () => {
      // La contraparte del grupo se comprueba literal: ni vacia ni de espacios.
      const invalidas = ['', '   '];
      for (const [index, counterparty] of invalidas.entries()) {
        const interpreter = new FakeInterpreter([followUpOperation()]);
        const followUp = new FakeFollowUpInterpreter([groupAnswer('payable', counterparty)]);
        const service = buildService(interpreter, followUp);

        const outcome = await handle(
          service,
          `e1-${index}`,
          'Lo que debo nada más',
          windowOf({ role: 'user', text: 'cuáles son mis deudas?' }),
        );

        expect(outcome.reply).toContain('No se sabe de quien es esa pregunta');
        expect(outcome.reply).not.toContain('Lo que debo');
        expect(outcome.reply).not.toContain('•');
      }
    });

    it('un grupo ignora un id escrito en el mensaje y no devuelve el otro lado', async () => {
      // El mensaje trae el id de una deuda del lado contrario.
      const sonia = (
        await debts.create({
          sourceKey: 'deuda-sonia',
          direction: 'receivable',
          counterparty: 'Sonia',
          money: { currency: 'USD', minor: 900n },
          occurredOn: '2026-11-10',
        })
      ).debt;
      const interpreter = new FakeInterpreter([followUpOperation()]);
      const followUp = new FakeFollowUpInterpreter([groupAnswer('payable')]);
      const service = buildService(interpreter, followUp);

      const outcome = await handle(
        service,
        'e1',
        `Lo que debo nada más ${sonia.id}`,
        windowOf({ role: 'user', text: 'cuáles son mis deudas?' }),
      );

      // El grupo manda: el id escrito no lo sustituye ni devuelve el otro lado.
      expect(outcome.reply).toContain('Lo que debo');
      expect(outcome.reply).toContain('Luis');
      expect(outcome.reply).not.toContain('Sonia');
      expect(outcome.reply).not.toContain('Lo que me deben');
    });

    it('una consulta nominal sigue honrando el id escrito', async () => {
      // Politica previa, intacta: en la consulta nominal el id escrito manda.
      const sonia = (
        await debts.create({
          sourceKey: 'deuda-sonia',
          direction: 'receivable',
          counterparty: 'Sonia',
          money: { currency: 'USD', minor: 900n },
          occurredOn: '2026-11-10',
        })
      ).debt;
      const interpreter = new FakeInterpreter([followUpOperation()]);
      const followUp = new FakeFollowUpInterpreter([
        {
          kind: 'debt_query',
          direction: 'payable',
          counterparty: 'Luis',
          currency: null,
          status: null,
          queryDetail: null,
        },
      ]);
      const service = buildService(interpreter, followUp);

      const outcome = await handle(
        service,
        'e1',
        `¿qué le debo a Luis? ${sonia.id}`,
        windowOf({ role: 'user', text: 'cuáles son mis deudas?' }),
      );

      // El id escrito manda sobre los filtros: sale la deuda de ese id.
      expect(outcome.reply).toContain('Sonia');
      expect(outcome.reply).not.toContain('Lo que debo');
      expect(outcome.reply).not.toContain('Luis');
    });

    it('el detalle de un grupo solo trae las pendientes', async () => {
      await seedGrupo();
      const interpreter = new FakeInterpreter([followUpOperation()]);
      const followUp = new FakeFollowUpInterpreter([
        groupAnswer('payable', null, { queryDetail: true }),
      ]);
      const service = buildService(interpreter, followUp);

      const outcome = await handle(
        service,
        'e1',
        'Lo que debo nada más',
        windowOf({ role: 'user', text: 'cuáles son mis deudas?' }),
      );

      // Las pendientes, con su detalle: la abierta y la parcial.
      expect(outcome.reply).toContain('Rita');
      expect(outcome.reply).toContain('Monto inicial: $12');
      expect(outcome.reply).toContain('Nico');
      expect(outcome.reply).toContain('Monto inicial: $5');
      expect(outcome.reply).toContain('Le he pagado: $2');
      expect(outcome.reply).toContain('Me falta por pagar: $3');
      // La saldada no entra en el grupo: tampoco en el detalle.
      expect(outcome.reply).not.toContain('Beto');
      expect(outcome.reply).not.toContain('$9');
    });

    it('el detalle de un grupo con estado explicito trae las saldadas', async () => {
      await seedGrupo();
      const interpreter = new FakeInterpreter([followUpOperation()]);
      const followUp = new FakeFollowUpInterpreter([
        groupAnswer('payable', null, { status: 'paid', queryDetail: true }),
      ]);
      const service = buildService(interpreter, followUp);

      const outcome = await handle(
        service,
        'e1',
        'Lo que debo nada más',
        windowOf({ role: 'user', text: 'cuáles son mis deudas?' }),
      );

      // El estado pedido de forma explicita manda: solo la saldada.
      expect(outcome.reply).toContain('Beto');
      expect(outcome.reply).toContain('Esta deuda está saldada');
      expect(outcome.reply).not.toContain('Rita');
      expect(outcome.reply).not.toContain('Nico');
    });

    it('una consulta sin persona sigue pidiendo la persona aunque tenga direccion', async () => {
      const interpreter = new FakeInterpreter([followUpOperation()]);
      const followUp = new FakeFollowUpInterpreter([
        {
          kind: 'debt_query',
          direction: 'payable',
          counterparty: null,
          currency: null,
          status: null,
          queryDetail: null,
        },
      ]);
      const service = buildService(interpreter, followUp);

      const outcome = await handle(
        service,
        'e1',
        'Lo que debo nada más',
        windowOf({ role: 'user', text: 'cuáles son mis deudas?' }),
      );

      expect(outcome.reply).toContain('No se sabe de quien es esa pregunta');
      expect(outcome.reply).not.toContain('Lo que debo');
      expect(outcome.reply).not.toContain('$7');
    });

    it('un grupo por direccion no cambia el borrador vivo', async () => {
      const interpreter = new FakeInterpreter([expenseOperation(account.id), followUpOperation()]);
      const followUp = new FakeFollowUpInterpreter([groupAnswer('payable')]);
      const service = buildService(interpreter, followUp);

      await handle(service, 'e1', 'Helado 2 dolares');
      const before = await draftRow();
      expect(before?.state).toBe('awaiting_confirmation');

      await handle(
        service,
        'e2',
        'Lo que debo nada más',
        windowOf({ role: 'user', text: 'cuáles son mis deudas?' }),
      );

      const after = await draftRow();
      expect(after?.id).toBe(before?.id);
      expect(after?.state).toBe('awaiting_confirmation');
      expect(after?.kind).toBe('expense');
      expect(after?.amount).toBe('12.50');
      expect(after?.sourceText).toBe('Helado 2 dolares');
    });
  });
});
