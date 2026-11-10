import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { Account } from '../src/accounts/account.entity';
import { AccountService } from '../src/accounts/account.service';
import { AiUsageDay } from '../src/capture/ai-usage.entity';
import { Capture } from '../src/capture/capture.entity';
import { CaptureEvent } from '../src/capture/capture-event.entity';
import { CaptureService } from '../src/capture/capture.service';
import { InferenceBudgetService } from '../src/capture/inference-budget.service';
import { AiLimits } from '../src/config/configuration';
import { TransactionRunner } from '../src/data/transaction.runner';
import { ValidationError } from '../src/domain/errors';
import { FinancialService } from '../src/financial/financial.service';
import { Movement } from '../src/financial/movement.entity';
import {
  InterpreterError,
  OperationInterpreter,
} from '../src/interpreter/interpreter';
import { Operation } from '../src/interpreter/operation.schema';
import { FakeInterpreter } from './helpers/fake-interpreter';
import { createTempDatabase, openDatabase, TempDatabase } from './helpers/temp-database';

const RECEIVED_AT = '2026-11-10T20:00:00.000Z';
const LIMITS: AiLimits = {
  maxRequestsPerDay: 100,
  maxInputTokensPerCall: 2000,
  maxOutputTokensPerCall: 500,
  maxCostMicroUsdPerCall: 5000,
  dailyBudgetMicroUsd: 200000,
};

function operation(overrides: Partial<Operation> = {}): Operation {
  return {
    amount: '12.50',
    currency: 'USD',
    accountId: 'sin-cuenta',
    kind: 'expense',
    occurredOn: '2026-11-10',
    description: 'Helado',
    ...overrides,
  };
}

/** Devuelve la unica fila de un resultado, fallando si no hay exactamente una. */
async function onlyRow<T>(rows: T[]): Promise<T> {
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error('No hay filas.');
  }
  return row;
}

describe('CaptureService', () => {
  let database: TempDatabase;
  let accounts: AccountService;
  let account: Account;

  beforeEach(async () => {
    database = await createTempDatabase();
    accounts = new AccountService(database.dataSource, database.transactions);
    account = await accounts.add({ name: 'Efectivo', currency: 'USD' });
  });

  afterEach(async () => {
    await database.cleanup();
  });

  function buildService(
    interpreter: OperationInterpreter,
    limits: AiLimits = LIMITS,
    dataSource: DataSource = database.dataSource,
    financial?: FinancialService,
  ): CaptureService {
    const transactions = new TransactionRunner(dataSource);
    return new CaptureService(
      dataSource,
      transactions,
      financial ?? new FinancialService(transactions),
      interpreter,
      new InferenceBudgetService(dataSource, transactions, limits),
    );
  }

  function handle(
    service: CaptureService,
    overrides: { eventId: string; chatId?: string; text: string },
  ) {
    return service.handle({
      eventId: overrides.eventId,
      chatId: overrides.chatId ?? 'chat-1',
      text: overrides.text,
      receivedAt: RECEIVED_AT,
    });
  }

  async function movementCount(dataSource: DataSource = database.dataSource): Promise<number> {
    return dataSource.getRepository(Movement).count();
  }

  describe('confirmacion explicita', () => {
    it('muestra el borrador y no registra nada hasta que el usuario confirma', async () => {
      const interpreter = new FakeInterpreter([operation({ accountId: account.id })]);
      const service = buildService(interpreter);

      const draft = await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });

      expect(draft.captureState).toBe('awaiting_confirmation');
      expect(draft.reply).toContain('12.50 USD');
      expect(draft.reply).toContain('Efectivo');
      expect(draft.reply).toContain('/confirm');
      expect(await movementCount()).toBe(0);

      const confirmed = await handle(service, { eventId: 'e2', text: '/confirm' });

      expect(confirmed.captureState).toBe('registered');
      expect(confirmed.reply).toContain('Registrado');
      expect(await movementCount()).toBe(1);

      const movement = await onlyRow(await database.dataSource.getRepository(Movement).find());
      expect(movement.amountMinor).toBe(1250n);
      expect(movement.currency).toBe('USD');
      expect(movement.occurredOn).toBe('2026-11-10');
      expect(movement.description).toBe('Helado');
      expect(movement.kind).toBe('expense');
    });

    it('usa la fecha del mensaje en America/Caracas cuando el modelo no da fecha', async () => {
      const interpreter = new FakeInterpreter([
        operation({ accountId: account.id, occurredOn: null }),
      ]);
      const service = buildService(interpreter);

      await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });
      await handle(service, { eventId: 'e2', text: '/confirm' });

      const movement = await onlyRow(await database.dataSource.getRepository(Movement).find());
      expect(movement.occurredOn).toBe('2026-11-10');
    });

    it('descarta el borrador con /cancel y no registra nada', async () => {
      const interpreter = new FakeInterpreter([operation({ accountId: account.id })]);
      const service = buildService(interpreter);

      await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });
      const cancelled = await handle(service, { eventId: 'e2', text: '/cancel' });

      expect(cancelled.captureState).toBe('cancelled');
      expect(await movementCount()).toBe(0);
      const capture = await onlyRow(await database.dataSource.getRepository(Capture).find());
      expect(capture.state).toBe('cancelled');
      expect(capture.sourceText).toBeNull();
    });

    it('no registra nada cuando /confirm no tiene un borrador pendiente', async () => {
      const interpreter = new FakeInterpreter([]);
      const service = buildService(interpreter);

      const outcome = await handle(service, { eventId: 'e1', text: '/confirm' });

      expect(outcome.reply).toContain('No hay ninguna operacion pendiente');
      expect(await movementCount()).toBe(0);
      expect(interpreter.requests).toHaveLength(0);
    });
  });

  describe('aclaraciones', () => {
    it('pide los datos que faltan y conserva el borrador entre reinicios', async () => {
      const interpreter = new FakeInterpreter([
        operation({ accountId: null }),
        operation({ accountId: account.id }),
      ]);
      const service = buildService(interpreter);

      const first = await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });
      expect(first.captureState).toBe('awaiting_details');
      expect(first.reply).toContain('falta la cuenta');
      expect(await movementCount()).toBe(0);

      await database.close();
      const reopened = await openDatabase(database.path);
      const restarted = buildService(interpreter, LIMITS, reopened);

      const clarified = await handle(restarted, { eventId: 'e2', text: 'en la cuenta Efectivo' });
      expect(clarified.captureState).toBe('awaiting_confirmation');
      expect(interpreter.requests[1]?.pending?.sourceText).toBe('Helado 2 dolares');

      const confirmed = await handle(restarted, { eventId: 'e3', text: '/confirm' });
      expect(confirmed.captureState).toBe('registered');
      expect(await movementCount(reopened)).toBe(1);

      await reopened.destroy();
    });

    it('interpreta la aclaracion con el contexto del borrador y luego confirma', async () => {
      const interpreter = new FakeInterpreter([
        operation({ accountId: null, currency: null }),
        operation({ accountId: account.id, currency: 'USD' }),
      ]);
      const service = buildService(interpreter);

      await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });
      const clarified = await handle(service, { eventId: 'e2', text: 'en efectivo' });

      expect(clarified.captureState).toBe('awaiting_confirmation');
      expect(interpreter.requests[1]?.pending?.sourceText).toBe('Helado 2 dolares');
      expect(interpreter.requests[1]?.pending?.amount).toBe('12.50');

      await handle(service, { eventId: 'e3', text: '/confirm' });
      expect(await movementCount()).toBe(1);
    });

    it('no inventa la cuenta ausente: la pide siempre', async () => {
      const interpreter = new FakeInterpreter([operation({ accountId: null })]);
      const service = buildService(interpreter);

      const outcome = await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });

      expect(outcome.reply).toContain('falta la cuenta');
      expect(outcome.reply).toContain('Efectivo');
      expect(await movementCount()).toBe(0);
    });
  });

  describe('conversiones y operaciones multiples', () => {
    it('rechaza una transferencia del modelo sin escribir nada', async () => {
      const interpreter = new FakeInterpreter([
        operation({ accountId: account.id, kind: 'transfer' }),
      ]);
      const service = buildService(interpreter);

      const outcome = await handle(service, { eventId: 'e1', text: 'cambio de cuentas' });

      expect(outcome.captureState).toBe('unsupported');
      expect(outcome.reply).toContain('conversiones');
      expect(await movementCount()).toBe(0);
      expect(await database.dataSource.getRepository(Capture).count()).toBe(0);
    });

    it('detecta la conversion por el texto aunque el modelo diga que es un gasto', async () => {
      const interpreter = new FakeInterpreter([operation({ accountId: account.id })]);
      const service = buildService(interpreter);

      const outcome = await handle(service, {
        eventId: 'e1',
        text: 'Cambie 50 USDT por bolivares',
      });

      expect(outcome.captureState).toBe('unsupported');
      expect(await movementCount()).toBe(0);
    });

    it('detecta una transferencia entre cuentas aunque el modelo diga que es un gasto', async () => {
      const interpreter = new FakeInterpreter([
        operation({ accountId: account.id, kind: 'expense', amount: '50.00' }),
      ]);
      const service = buildService(interpreter);

      const outcome = await handle(service, {
        eventId: 'e1',
        text: 'Transferí 50 USD de Efectivo a Banco',
      });

      expect(outcome.captureState).toBe('unsupported');
      expect(outcome.reply).toContain('conversiones');
      expect(await movementCount()).toBe(0);
      expect(await database.dataSource.getRepository(Capture).count()).toBe(0);
    });

    it('no confunde el medio de pago con un traslado entre cuentas', async () => {
      const interpreter = new FakeInterpreter([
        operation({ accountId: account.id, kind: 'expense', amount: '50.00' }),
      ]);
      const service = buildService(interpreter);

      const outcome = await handle(service, {
        eventId: 'e1',
        text: 'Pagué el almuerzo de 50 USD por transferencia',
      });

      expect(outcome.captureState).toBe('awaiting_confirmation');
      expect(await database.dataSource.getRepository(Capture).count()).toBe(1);

      const confirmed = await handle(service, { eventId: 'e2', text: '/confirm' });
      expect(confirmed.captureState).toBe('registered');
      expect(await movementCount()).toBe(1);
    });

    it('pide reescribir cuando el mensaje describe mas de una operacion', async () => {
      const interpreter = new FakeInterpreter([operation({ accountId: account.id })]);
      const service = buildService(interpreter);

      const outcome = await handle(service, {
        eventId: 'e1',
        text: 'compre cafe por 2 USD y pague el almuerzo por 10 USD',
      });

      expect(outcome.reply).toContain('mas de una operacion');
      expect(await movementCount()).toBe(0);
      expect(await database.dataSource.getRepository(Capture).count()).toBe(0);
    });
  });

  describe('validacion del backend', () => {
    it('rechaza un importe invalido y lo pide de nuevo', async () => {
      const interpreter = new FakeInterpreter([
        operation({ accountId: account.id, amount: 'doce' }),
      ]);
      const service = buildService(interpreter);

      const outcome = await handle(service, { eventId: 'e1', text: 'Helado doce dolares' });

      expect(outcome.captureState).toBe('awaiting_details');
      expect(outcome.reply).toContain('importe');
      expect(await movementCount()).toBe(0);
    });

    it('rechaza una cuenta que no pertenece al usuario', async () => {
      const interpreter = new FakeInterpreter([operation({ accountId: 'cuenta-inventada' })]);
      const service = buildService(interpreter);

      const outcome = await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });

      expect(outcome.captureState).toBe('awaiting_details');
      expect(outcome.reply).toContain('falta la cuenta');
      expect(await movementCount()).toBe(0);
    });

    it('rechaza una moneda que no esta soportada y no la guarda', async () => {
      const interpreter = new FakeInterpreter([
        operation({ accountId: account.id, currency: 'EUR' }),
      ]);
      const service = buildService(interpreter);

      const outcome = await handle(service, { eventId: 'e1', text: 'Helado 2 euros' });

      expect(outcome.captureState).toBe('awaiting_details');
      expect(outcome.reply).toContain('no esta soportada');
      expect(await movementCount()).toBe(0);
      const capture = await onlyRow(await database.dataSource.getRepository(Capture).find());
      expect(capture.currency).toBeNull();
    });

    it.each([
      ['cadena vacia', ''],
      ['solo espacios', '   '],
      ['fecha inexistente', '2026-02-30'],
    ])('no sustituye una fecha (%s) por la fecha por defecto', async (_case, occurredOn) => {
      const interpreter = new FakeInterpreter([
        operation({ accountId: account.id, occurredOn }),
      ]);
      const service = buildService(interpreter);

      const outcome = await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });

      expect(outcome.captureState).toBe('awaiting_details');
      expect(outcome.reply).toContain('fecha');
      expect(await movementCount()).toBe(0);

      const confirmed = await handle(service, { eventId: 'e2', text: '/confirm' });
      expect(confirmed.reply).toContain('no tiene un resumen vigente');
      expect(await movementCount()).toBe(0);
    });

    it('acepta una fecha valida sin preguntar nada', async () => {
      const interpreter = new FakeInterpreter([
        operation({ accountId: account.id, occurredOn: '2026-11-05' }),
      ]);
      const service = buildService(interpreter);

      const outcome = await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });
      expect(outcome.captureState).toBe('awaiting_confirmation');

      await handle(service, { eventId: 'e2', text: '/confirm' });
      const movement = await onlyRow(await database.dataSource.getRepository(Movement).find());
      expect(movement.occurredOn).toBe('2026-11-05');
    });

    it('usa la fecha del mensaje solo cuando no hay fecha', async () => {
      const interpreter = new FakeInterpreter([
        operation({ accountId: account.id, occurredOn: null }),
      ]);
      const service = buildService(interpreter);

      const outcome = await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });
      expect(outcome.captureState).toBe('awaiting_confirmation');

      await handle(service, { eventId: 'e2', text: '/confirm' });
      const movement = await onlyRow(await database.dataSource.getRepository(Movement).find());
      expect(movement.occurredOn).toBe('2026-11-10');
    });

    it('no acepta confirmar un borrador sin resumen vigente', async () => {
      const interpreter = new FakeInterpreter([
        operation({ accountId: account.id }),
        operation({ accountId: account.id, kind: 'unclear', amount: null, currency: null, description: null }),
        operation({ accountId: account.id }),
      ]);
      const service = buildService(interpreter);

      const preview = await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });
      expect(preview.captureState).toBe('awaiting_confirmation');

      const unclear = await handle(service, { eventId: 'e2', text: 'no se' });
      expect(unclear.captureState).toBe('awaiting_details');
      expect(unclear.reply).toContain('No pude identificar una sola operacion');

      const refused = await handle(service, { eventId: 'e3', text: '/confirm' });
      expect(refused.reply).toContain('no tiene un resumen vigente');
      expect(await movementCount()).toBe(0);

      // Un mensaje nuevo vuelve a generar el resumen y entonces si se puede confirmar.
      await handle(service, { eventId: 'e4', text: 'Helado 2 dolares' });
      const confirmed = await handle(service, { eventId: 'e5', text: '/confirm' });
      expect(confirmed.captureState).toBe('registered');
      expect(await movementCount()).toBe(1);
    });

    it('rechaza una moneda que no corresponde a la cuenta', async () => {      const ves = await accounts.add({ name: 'Banco', currency: 'VES' });
      const interpreter = new FakeInterpreter([
        operation({ accountId: ves.id, currency: 'USD', amount: '10.00' }),
      ]);
      const service = buildService(interpreter);

      const outcome = await handle(service, { eventId: 'e1', text: 'Helado 10 dolares' });

      expect(outcome.captureState).toBe('awaiting_details');
      expect(outcome.reply).toContain('opera en VES');
      expect(await movementCount()).toBe(0);
    });
  });

  describe('idempotencia del evento', () => {
    it('reproduce la misma respuesta sin volver a interpretar', async () => {
      const interpreter = new FakeInterpreter([operation({ accountId: account.id })]);
      const service = buildService(interpreter);

      const first = await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });
      const replay = await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });

      expect(replay.reply).toBe(first.reply);
      expect(replay.replayed).toBe(true);
      expect(interpreter.requests).toHaveLength(1);
    });

    it('no interpreta dos veces cuando el mismo evento llega a la vez', async () => {
      const interpreter = new FakeInterpreter([operation({ accountId: account.id })]);
      const service = buildService(interpreter);

      const [first, second] = await Promise.all([
        handle(service, { eventId: 'e1', text: 'Helado 2 dolares' }),
        handle(service, { eventId: 'e1', text: 'Helado 2 dolares' }),
      ]);

      expect(first.reply).toBe(second.reply);
      expect(interpreter.requests).toHaveLength(1);
      expect(await database.dataSource.getRepository(CaptureEvent).count()).toBe(1);
    });
  });

  describe('inferencia fallida', () => {
    it('falla de forma clara cuando el interprete no esta configurado', async () => {
      const interpreter = new FakeInterpreter([], false);
      const service = buildService(interpreter);

      const outcome = await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });

      expect(outcome.reply).toContain('no esta configurada');
      expect(interpreter.requests).toHaveLength(0);
      expect(await movementCount()).toBe(0);
    });

    it('marca el evento como incierto y no reintenta solo', async () => {
      const interpreter = new FakeInterpreter([
        new InterpreterError('timeout', 'El proveedor no respondio a tiempo.'),
      ]);
      const service = buildService(interpreter);

      const outcome = await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });

      expect(outcome.reply).toContain('no lo reintento automaticamente');
      expect(await movementCount()).toBe(0);
      const event = await onlyRow(await database.dataSource.getRepository(CaptureEvent).find());
      expect(event.state).toBe('uncertain');

      const replay = await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });
      expect(replay.reply).toBe(outcome.reply);
      expect(interpreter.requests).toHaveLength(1);
    });

    it('consume la reserva aunque la llamada falle', async () => {
      const interpreter = new FakeInterpreter([
        new InterpreterError('invalid', 'La respuesta no cumple el esquema.'),
      ]);
      const service = buildService(interpreter);

      await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });

      const usage = await onlyRow(await database.dataSource.getRepository(AiUsageDay).find());
      expect(usage.requests).toBe(1);
      expect(usage.costMicroUsd).toBe(LIMITS.maxCostMicroUsdPerCall);
    });
  });

  describe('presupuesto diario', () => {
    it('falla cerrado cuando el dia ya no alcanza', async () => {
      const limits: AiLimits = { ...LIMITS, maxRequestsPerDay: 1, dailyBudgetMicroUsd: 5000 };
      const interpreter = new FakeInterpreter([
        operation({ accountId: account.id }),
        operation({ accountId: account.id }),
      ]);
      const service = buildService(interpreter, limits);

      const first = await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });
      expect(first.captureState).toBe('awaiting_confirmation');

      const second = await handle(service, { eventId: 'e2', text: 'otro gasto' });
      expect(second.reply).toContain('limite diario');
      expect(interpreter.requests).toHaveLength(1);

      const usage = await onlyRow(await database.dataSource.getRepository(AiUsageDay).find());
      expect(usage.requests).toBe(1);
    });

    it('falla cerrado cuando el presupuesto de costo se agota', async () => {
      const limits: AiLimits = { ...LIMITS, dailyBudgetMicroUsd: 1000 };
      const interpreter = new FakeInterpreter([operation({ accountId: account.id })]);
      const service = buildService(interpreter, limits);

      const outcome = await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });

      expect(outcome.reply).toContain('limite diario');
      expect(interpreter.requests).toHaveLength(0);
    });
  });

  describe('atomicidad', () => {
    it('no registra el movimiento si la cuenta deja de estar activa', async () => {
      const interpreter = new FakeInterpreter([operation({ accountId: account.id })]);
      const service = buildService(interpreter);

      await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });
      await database.dataSource.getRepository(Account).update(account.id, { active: false });

      const outcome = await handle(service, { eventId: 'e2', text: '/confirm' });

      expect(outcome.reply).toContain('falta la cuenta');
      expect(await movementCount()).toBe(0);
      const event = await onlyRow(
        await database.dataSource
          .getRepository(CaptureEvent)
          .findBy({ eventId: 'e2' }),
      );
      expect(event.state).toBe('completed');
      expect(event.captureState).toBe('awaiting_details');
    });

    it('revierte el registro si el movimiento entra en conflicto', async () => {
      const interpreter = new FakeInterpreter([operation({ accountId: account.id })]);
      const service = buildService(interpreter);

      await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });
      const capture = await onlyRow(await database.dataSource.getRepository(Capture).find());
      const movements = database.dataSource.getRepository(Movement);
      await movements.save(
        movements.create({
          sourceKey: capture.sourceKey,
          accountId: account.id,
          kind: 'expense',
          amountMinor: 1n,
          currency: 'USD',
          occurredOn: '2026-11-10',
          description: null,
        }),
      );

      const outcome = await handle(service, { eventId: 'e2', text: '/confirm' });

      expect(outcome.reply).toContain('No se pudo registrar');
      expect(await movementCount()).toBe(1);
      const stored = await onlyRow(await database.dataSource.getRepository(Capture).find());
      expect(stored.state).toBe('awaiting_details');
    });

    it('deja el borrador terminal sin el texto original cuando registra', async () => {
      const interpreter = new FakeInterpreter([operation({ accountId: account.id })]);
      const service = buildService(interpreter);

      await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });
      await handle(service, { eventId: 'e2', text: '/confirm' });

      expect(await movementCount()).toBe(1);
      const capture = await onlyRow(await database.dataSource.getRepository(Capture).find());
      expect(capture.state).toBe('registered');
      expect(capture.sourceText).toBeNull();
    });

    it('no devuelve la respuesta antes de confirmar el movimiento', async () => {
      const interpreter = new FakeInterpreter([operation({ accountId: account.id })]);
      const service = buildService(interpreter);

      await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });
      const confirmed = await handle(service, { eventId: 'e2', text: '/confirm' });

      // Al recibir la respuesta, otra conexion ya ve el movimiento confirmado.
      const observer = await openDatabase(database.path);
      const movements = await observer.getRepository(Movement).find();
      expect(movements).toHaveLength(1);
      expect(confirmed.movementId).toBe(movements[0]?.id);
      await observer.destroy();
    });

    it('no filtra el detalle de un error inesperado al usuario', async () => {
      const interpreter = new FakeInterpreter([operation({ accountId: account.id })]);
      const failing = {
        register: async (): Promise<never> => {
          throw new Error('SENTINEL-sqlite-detalle-interno');
        },
      } as unknown as FinancialService;
      const service = buildService(interpreter, LIMITS, database.dataSource, failing);

      await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });
      const outcome = await handle(service, { eventId: 'e2', text: '/confirm' });

      expect(outcome.reply).toContain('No se pudo registrar');
      expect(outcome.reply).not.toContain('SENTINEL');
      expect(outcome.reply).not.toContain('sqlite');
      expect(await movementCount()).toBe(0);
    });

    it('muestra los errores de dominio conocidos', async () => {
      const interpreter = new FakeInterpreter([operation({ accountId: account.id })]);
      const failing = {
        register: async (): Promise<never> => {
          throw new ValidationError('La cuenta "Efectivo" esta inactiva.');
        },
      } as unknown as FinancialService;
      const service = buildService(interpreter, LIMITS, database.dataSource, failing);

      await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });
      const outcome = await handle(service, { eventId: 'e2', text: '/confirm' });

      expect(outcome.reply).toContain('esta inactiva');
      expect(await movementCount()).toBe(0);
    });

    it('normaliza el formato de la descripcion', async () => {
      const interpreter = new FakeInterpreter([
        operation({ accountId: account.id, description: '  Helado   de\n  chocolate  ' }),
      ]);
      const service = buildService(interpreter);

      await handle(service, { eventId: 'e1', text: 'Helado 2 dolares' });
      await handle(service, { eventId: 'e2', text: '/confirm' });

      const movement = await onlyRow(await database.dataSource.getRepository(Movement).find());
      expect(movement.description).toBe('Helado de chocolate');
    });

    it('la clave del movimiento no confunde la conversacion con el evento', async () => {
      const interpreter = new FakeInterpreter([
        operation({ accountId: account.id }),
        operation({ accountId: account.id }),
      ]);
      const service = buildService(interpreter);

      await handle(service, { eventId: 'c', chatId: 'ab', text: 'Helado 2 dolares' });
      await handle(service, { eventId: 'e2', chatId: 'ab', text: '/confirm' });
      await handle(service, { eventId: 'bc', chatId: 'a', text: 'Helado 2 dolares' });
      await handle(service, { eventId: 'e3', chatId: 'a', text: '/confirm' });

      const movements = await database.dataSource.getRepository(Movement).find();
      expect(movements).toHaveLength(2);
      expect(movements[0]?.sourceKey).not.toBe(movements[1]?.sourceKey);
    });

    it('el codigo fuente no contiene bytes de control literales', () => {
      const source = readFileSync(join(__dirname, '../src/capture/capture.service.ts'));

      expect(source.includes(0)).toBe(false);
    });
  });
});
