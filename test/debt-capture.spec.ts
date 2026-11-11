import { randomUUID } from 'node:crypto';
import { AccountService } from '../src/accounts/account.service';
import { Account } from '../src/accounts/account.entity';
import { Capture } from '../src/capture/capture.entity';
import { CaptureEvent } from '../src/capture/capture-event.entity';
import { CaptureService } from '../src/capture/capture.service';
import { parseDebtDraft } from '../src/capture/debt-draft';
import { InferenceBudgetService } from '../src/capture/inference-budget.service';
import { AiLimits } from '../src/config/configuration';
import { DataSource } from 'typeorm';
import { TransactionRunner } from '../src/data/transaction.runner';
import { Debt, DebtDirection } from '../src/debts/debt.entity';
import { DebtPayment } from '../src/debts/debt-payment.entity';
import { DebtService } from '../src/debts/debt.service';
import { FinancialService } from '../src/financial/financial.service';
import { Movement } from '../src/financial/movement.entity';
import { Operation } from '../src/interpreter/operation.schema';
import { FakeInterpreter } from './helpers/fake-interpreter';
import { createTempDatabase, openDatabase, TempDatabase } from './helpers/temp-database';

const RECEIVED_AT = '2026-11-10T20:00:00.000Z';
const TODAY = '2026-11-10';
const LIMITS: AiLimits = {
  maxRequestsPerDay: 100,
  maxInputTokensPerCall: 2000,
  maxOutputTokensPerCall: 500,
  maxCostMicroUsdPerCall: 5000,
  dailyBudgetMicroUsd: 200000,
};

/** Datos de deuda del modelo: todos en null salvo lo que se declare. */
function debtData(overrides: Partial<NonNullable<Operation['debt']>> = {}) {
  return {
    direction: null,
    counterparty: null,
    debtId: null,
    settlementMode: null,
    status: null,
    ...overrides,
  };
}

/** Operacion del modelo. El objeto `debt` es siempre presente en el esquema estricto. */
function operation(overrides: Partial<Operation> = {}): Operation {
  return {
    amount: null,
    currency: null,
    accountId: null,
    kind: 'debt_create',
    occurredOn: null,
    description: null,
    debt: debtData(),
    ...overrides,
  };
}

describe('Captura de deudas (unidad 2)', () => {
  let db: TempDatabase;
  let accounts: AccountService;
  let financial: FinancialService;
  let debts: DebtService;
  let usd: string;
  let ves: string;

  beforeEach(async () => {
    db = await createTempDatabase();
    accounts = new AccountService(db.dataSource, db.transactions);
    financial = new FinancialService(db.transactions);
    debts = new DebtService(db.transactions, financial);
    usd = (await accounts.add({ name: 'Efectivo USD', currency: 'USD' })).id;
    ves = (await accounts.add({ name: 'Efectivo VES', currency: 'VES' })).id;
  });

  afterEach(async () => {
    await db.cleanup();
  });

  function buildService(interpreter: FakeInterpreter, dataSource: DataSource = db.dataSource): CaptureService {
    const transactions = new TransactionRunner(dataSource);
    const resolvedFinancial = new FinancialService(transactions);
    return new CaptureService(
      dataSource,
      transactions,
      resolvedFinancial,
      interpreter,
      new InferenceBudgetService(transactions, LIMITS),
      new DebtService(transactions, resolvedFinancial),
    );
  }

  function handle(service: CaptureService, overrides: { eventId: string; chatId?: string; text: string }) {
    return service.handle({
      eventId: overrides.eventId,
      chatId: overrides.chatId ?? 'chat-1',
      text: overrides.text,
      receivedAt: RECEIVED_AT,
    });
  }

  async function onlyRow<T>(rows: T[]): Promise<T> {
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error('No hay filas.');
    return row;
  }

  async function movementCount(): Promise<number> {
    return db.dataSource.getRepository(Movement).count();
  }

  async function debtCount(): Promise<number> {
    return db.dataSource.getRepository(Debt).count();
  }

  async function seedDebt(overrides: {
    sourceKey: string;
    direction?: DebtDirection;
    counterparty?: string;
    currency?: 'USD' | 'VES' | 'USDT';
    minor?: bigint;
  }): Promise<Debt> {
    const created = await debts.create({
      sourceKey: overrides.sourceKey,
      direction: overrides.direction ?? 'payable',
      counterparty: overrides.counterparty ?? 'Carmen',
      money: { currency: overrides.currency ?? 'USD', minor: overrides.minor ?? 1000n },
      occurredOn: '2026-11-01',
    });
    return created.debt;
  }

  describe('creacion de una deuda', () => {
    it('registra lo que debo sin mover dinero y devuelve el id de la deuda', async () => {
      const interpreter = new FakeInterpreter([
        operation({
          amount: '8.00',
          currency: 'USD',
          description: 'dos tortas',
          debt: debtData({ direction: 'payable', counterparty: 'Carmen' }),
        }),
      ]);
      const service = buildService(interpreter);

      const preview = await handle(service, { eventId: 'e1', text: 'le debo 8$ a Carmen de dos tortas' });

      expect(preview.captureState).toBe('awaiting_confirmation');
      expect(preview.reply).toContain('Carmen');
      expect(preview.reply).toContain('8.00 USD');
      expect(preview.reply).toContain('no mueve dinero');
      expect(await debtCount()).toBe(0);
      expect(await movementCount()).toBe(0);

      const confirmed = await handle(service, { eventId: 'e2', text: '/confirm' });

      expect(confirmed.captureState).toBe('registered');
      expect(confirmed.reply).toContain('Deuda:');
      expect(confirmed.movementId).toBeNull();
      expect(await movementCount()).toBe(0);
      expect(await db.dataSource.getRepository(DebtPayment).count()).toBe(0);

      const debt = await onlyRow(await db.dataSource.getRepository(Debt).find());
      expect(debt.direction).toBe('payable');
      expect(debt.counterparty).toBe('Carmen');
      expect(debt.principalMinor).toBe(800n);
      expect(debt.currency).toBe('USD');
      expect(debt.occurredOn).toBe(TODAY);
      expect(debt.description).toBe('dos tortas');
      expect(confirmed.reply).toContain(debt.id);
    });

    it('registra lo que me deben con la direccion contraria y sin cuenta', async () => {
      const interpreter = new FakeInterpreter([
        operation({
          amount: '8.00',
          currency: 'USD',
          debt: debtData({ direction: 'receivable', counterparty: 'Carmen' }),
        }),
      ]);
      const service = buildService(interpreter);

      await handle(service, { eventId: 'e1', text: 'Carmen me debe 8$' });
      const confirmed = await handle(service, { eventId: 'e2', text: '/confirm' });

      expect(confirmed.captureState).toBe('registered');
      expect(await movementCount()).toBe(0);
      const debt = await onlyRow(await db.dataSource.getRepository(Debt).find());
      expect(debt.direction).toBe('receivable');
      expect(debt.counterparty).toBe('Carmen');
      expect(debt.principalMinor).toBe(800n);
    });

    it('no crea la deuda si el usuario no confirma y /cancel no registra nada', async () => {
      const interpreter = new FakeInterpreter([
        operation({
          amount: '8.00',
          currency: 'USD',
          debt: debtData({ direction: 'payable', counterparty: 'Carmen' }),
        }),
      ]);
      const service = buildService(interpreter);

      await handle(service, { eventId: 'e1', text: 'le debo 8$ a Carmen' });
      expect(await debtCount()).toBe(0);

      const cancelled = await handle(service, { eventId: 'e2', text: '/cancel' });

      expect(cancelled.captureState).toBe('cancelled');
      expect(await debtCount()).toBe(0);
      expect(await movementCount()).toBe(0);
    });

    it('pide contraparte, importe y moneda cuando faltan, sin inventar nada', async () => {
      const interpreter = new FakeInterpreter([
        operation({ debt: debtData({ direction: 'payable' }) }),
        operation({ amount: '8.00', debt: debtData({ direction: 'payable' }) }),
        operation({
          amount: '8.00',
          currency: 'USD',
          debt: debtData({ direction: 'payable', counterparty: 'Carmen' }),
        }),
      ]);
      const service = buildService(interpreter);

      const first = await handle(service, { eventId: 'e1', text: 'le debo 8$ a Carmen' });
      expect(first.captureState).toBe('awaiting_details');
      expect(first.reply).toContain('falta la contraparte');
      expect(first.reply).toContain('falta el importe');
      expect(first.reply).toContain('falta la moneda');

      const second = await handle(service, { eventId: 'e2', text: 'a Carmen' });
      expect(second.captureState).toBe('awaiting_details');
      expect(second.reply).toContain('falta la moneda');

      const third = await handle(service, { eventId: 'e3', text: '8 dolares' });
      expect(third.captureState).toBe('awaiting_confirmation');

      await handle(service, { eventId: 'e4', text: '/confirm' });
      expect(await debtCount()).toBe(1);
    });
  });

  describe('pago de una deuda', () => {
    it('paga una parte y registra el gasto ordinariolinked a la deuda', async () => {
      const debt = await seedDebt({ sourceKey: 'deuda', minor: 1000n });
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'debt_settle',
          amount: '3.00',
          currency: 'USD',
          accountId: usd,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            settlementMode: 'partial',
          }),
        }),
      ]);
      const service = buildService(interpreter);

      const preview = await handle(service, { eventId: 'e1', text: 'le pagué 3 dólares a Carmen' });

      expect(preview.captureState).toBe('awaiting_confirmation');
      expect(preview.reply).toContain(debt.id);
      expect(preview.reply).toContain('pago parcial');
      expect(preview.reply).toContain('3.00 USD');
      expect(preview.reply).toContain('10.00 USD');
      expect(await movementCount()).toBe(0);

      const confirmed = await handle(service, { eventId: 'e2', text: '/confirm' });

      expect(confirmed.captureState).toBe('registered');
      expect(confirmed.reply).toContain('Pago:');
      expect(confirmed.movementId).not.toBeNull();
      expect(confirmed.reply).toContain(confirmed.movementId as string);

      const movement = await onlyRow(await db.dataSource.getRepository(Movement).find());
      expect(movement.kind).toBe('expense');
      expect(movement.amountMinor).toBe(300n);
      expect(movement.currency).toBe('USD');
      expect(movement.accountId).toBe(usd);
      expect(await db.dataSource.getRepository(DebtPayment).count()).toBe(1);
      expect(await debts.get(debt.id)).toMatchObject({
        paidMinor: 300n,
        outstandingMinor: 700n,
        status: 'partial',
      });
    });

    it('cobra lo que me deben con un ingreso y deja la deuda pagada', async () => {
      const debt = await seedDebt({ sourceKey: 'deuda', direction: 'receivable', minor: 1000n });
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'debt_settle',
          currency: 'USD',
          accountId: usd,
          debt: debtData({
            direction: 'receivable',
            counterparty: 'Carmen',
            settlementMode: 'full',
          }),
        }),
      ]);
      const service = buildService(interpreter);

      const preview = await handle(service, { eventId: 'e1', text: 'ya le pagué todo a Carmen' });

      expect(preview.captureState).toBe('awaiting_confirmation');
      expect(preview.reply).toContain('pago total');
      expect(preview.reply).toContain('10.00 USD');

      const confirmed = await handle(service, { eventId: 'e2', text: '/confirm' });

      expect(confirmed.captureState).toBe('registered');
      const movement = await onlyRow(await db.dataSource.getRepository(Movement).find());
      expect(movement.kind).toBe('income');
      expect(movement.amountMinor).toBe(1000n);
      expect(await debts.get(debt.id)).toMatchObject({ paidMinor: 1000n, outstandingMinor: 0n, status: 'paid' });
    });

    it('un modelo que dice que se pago todo no paga nada si el usuario no lo pidio', async () => {
      const debt = await seedDebt({ sourceKey: 'deuda', direction: 'receivable', minor: 1000n });
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'debt_settle',
          currency: 'USD',
          accountId: usd,
          debt: debtData({
            direction: 'receivable',
            counterparty: 'Carmen',
            settlementMode: 'full',
          }),
        }),
      ]);
      const service = buildService(interpreter);

      const preview = await handle(service, { eventId: 'e1', text: 'Carmen me pagó' });

      expect(preview.captureState).toBe('awaiting_details');
      expect(preview.reply).toContain('falta el importe del pago');
      expect(await movementCount()).toBe(0);
      expect(await db.dataSource.getRepository(DebtPayment).count()).toBe(0);
      expect((await debts.get(debt.id)).outstandingMinor).toBe(1000n);
    });

    it.each([
      ['no le pagué todo a Carmen'],
      ['le pagué a todos'],
      ['todavía no le pagué todo a Carmen'],
      ['casi le pagué todo a Carmen'],
      ['falta pagar todo'],
    ])('un modelo que dice "full" no paga todo con la frase: %s', async (text) => {
      const debt = await seedDebt({ sourceKey: 'deuda', minor: 1000n });
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'debt_settle',
          currency: 'USD',
          accountId: usd,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            settlementMode: 'full',
          }),
        }),
      ]);
      const service = buildService(interpreter);

      const outcome = await handle(service, { eventId: 'e1', text });

      expect(outcome.captureState).toBe('awaiting_details');
      expect(outcome.reply).toContain('falta el importe del pago');
      expect(outcome.reply).not.toContain('pago total');
      expect(await movementCount()).toBe(0);
      expect(await db.dataSource.getRepository(DebtPayment).count()).toBe(0);
      expect((await debts.get(debt.id)).outstandingMinor).toBe(1000n);
    });

    it('una frase que niega el pago completo revoca la autorizacion del borrador', async () => {
      const debt = await seedDebt({ sourceKey: 'deuda', minor: 1000n });
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'debt_settle',
          currency: 'USD',
          accountId: null,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            settlementMode: 'full',
          }),
        }),
        operation({
          kind: 'debt_settle',
          currency: 'USD',
          accountId: usd,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            settlementMode: 'full',
          }),
        }),
      ]);
      const service = buildService(interpreter);

      const first = await handle(service, { eventId: 'e1', text: 'ya le pagué todo a Carmen' });
      expect(first.captureState).toBe('awaiting_details');
      expect(first.reply).toContain('falta la cuenta');

      // El usuario lo niega: la autorizacion anterior no se resucita.
      const revoked = await handle(service, { eventId: 'e2', text: 'no le pagué todo a Carmen' });

      expect(revoked.captureState).toBe('awaiting_details');
      expect(revoked.reply).toContain('falta el importe del pago');
      expect(revoked.reply).not.toContain('pago total');
      expect(await movementCount()).toBe(0);
      expect(await db.dataSource.getRepository(DebtPayment).count()).toBe(0);
    });

    it('conserva la intencion de pago total al aclarar la cuenta, incluso tras reiniciar', async () => {
      const debt = await seedDebt({ sourceKey: 'deuda', minor: 1000n });
      expect(debt.id).toMatch(/^[\da-f-]{36}$/);
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'debt_settle',
          currency: 'USD',
          accountId: null,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            settlementMode: 'full',
          }),
        }),
        operation({
          kind: 'debt_settle',
          currency: 'USD',
          accountId: usd,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            settlementMode: null,
          }),
        }),
      ]);
      const service = buildService(interpreter);

      const first = await handle(service, { eventId: 'e1', text: 'ya le pagué todo a Carmen' });
      expect(first.captureState).toBe('awaiting_details');
      expect(first.reply).toContain('falta la cuenta');

      await db.close();
      const reopened = await openDatabase(db.path);
      const restarted = buildService(interpreter, reopened);
      const reopenedTransactions = new TransactionRunner(reopened);
      const reopenedDebts = new DebtService(reopenedTransactions, new FinancialService(reopenedTransactions));

      const clarified = await handle(restarted, { eventId: 'e2', text: 'en la cuenta Efectivo USD' });
      expect(clarified.captureState).toBe('awaiting_confirmation');
      expect(clarified.reply).toContain('pago total');
      expect(clarified.reply).toContain('10.00 USD');

      const confirmed = await handle(restarted, { eventId: 'e3', text: '/confirm' });
      expect(confirmed.captureState).toBe('registered');
      expect(await reopened.getRepository(Movement).count()).toBe(1);
      expect((await reopenedDebts.get(debt.id)).status).toBe('paid');

      await reopened.destroy();
    });

    it('prepara un pago total y lo rechaza si el pendiente cambio antes de confirmar', async () => {
      const debt = await seedDebt({ sourceKey: 'deuda', minor: 1000n });
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'debt_settle',
          currency: 'USD',
          accountId: usd,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            settlementMode: 'full',
          }),
        }),
      ]);
      const service = buildService(interpreter);

      await handle(service, { eventId: 'e1', text: 'ya le pagué todo' });
      expect(await movementCount()).toBe(0);

      // Otro pago cambia el pendiente mientras el borrador esta vivo.
      await debts.settle({
        sourceKey: 'otro',
        debtId: debt.id,
        accountId: usd,
        money: { currency: 'USD', minor: 400n },
        occurredOn: '2026-11-05',
        expectedOutstandingMinor: 1000n,
      });

      const confirmed = await handle(service, { eventId: 'e2', text: '/confirm' });

      expect(confirmed.captureState).toBe('awaiting_details');
      expect(confirmed.reply).toContain('el pendiente de la deuda cambio');
      expect(await movementCount()).toBe(1);
      expect(await debts.get(debt.id)).toMatchObject({ paidMinor: 400n, outstandingMinor: 600n });

      // El resumen vigente se perdio: hace falta volver a interpretarlo.
      const refused = await handle(service, { eventId: 'e3', text: '/confirm' });
      expect(refused.reply).toContain('no tiene un resumen vigente');
      expect(await movementCount()).toBe(1);
    });

    it('prepara un pago total y lo rechaza si el pago anterior se anulo', async () => {
      const debt = await seedDebt({ sourceKey: 'deuda', minor: 1000n });
      const payment = await debts.settle({
        sourceKey: 'pago',
        debtId: debt.id,
        accountId: usd,
        money: { currency: 'USD', minor: 400n },
        occurredOn: '2026-11-05',
        expectedOutstandingMinor: 1000n,
      });
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'debt_settle',
          currency: 'USD',
          accountId: usd,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            settlementMode: 'full',
          }),
        }),
      ]);
      const service = buildService(interpreter);

      const preview = await handle(service, { eventId: 'e1', text: 'ya le pagué todo' });
      expect(preview.captureState).toBe('awaiting_confirmation');
      expect(preview.reply).toContain('6.00 USD');

      // Anular el pago anterior reabre la deuda: el pendiente congelado ya no vale.
      await financial.voidMovement({
        sourceKey: 'anular',
        movementId: payment.movement.id,
        expectedRevision: 0,
        reason: 'Me equivoque',
      });

      const confirmed = await handle(service, { eventId: 'e2', text: '/confirm' });

      expect(confirmed.captureState).toBe('awaiting_details');
      expect(confirmed.reply).toContain('el pendiente de la deuda cambio');
      expect(await movementCount()).toBe(1);
      expect(await debts.get(debt.id)).toMatchObject({ paidMinor: 0n, outstandingMinor: 1000n });
    });

    it('pide la cuenta y no la inventa', async () => {
      await seedDebt({ sourceKey: 'deuda' });
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'debt_settle',
          amount: '3.00',
          currency: 'USD',
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            settlementMode: 'partial',
          }),
        }),
      ]);
      const service = buildService(interpreter);

      const preview = await handle(service, { eventId: 'e1', text: 'le pagué 3 dólares a Carmen' });

      expect(preview.captureState).toBe('awaiting_details');
      expect(preview.reply).toContain('falta la cuenta');
      expect(preview.reply).toContain('Efectivo USD');
      expect(await movementCount()).toBe(0);
    });

    it('no registra el pago si la cuenta esta inactiva', async () => {
      await seedDebt({ sourceKey: 'deuda' });
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'debt_settle',
          amount: '3.00',
          currency: 'USD',
          accountId: usd,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            settlementMode: 'partial',
          }),
        }),
      ]);
      const service = buildService(interpreter);

      await handle(service, { eventId: 'e1', text: 'le pagué 3 dólares a Carmen' });
      await db.dataSource.getRepository(Account).update(usd, { active: false });

      const confirmed = await handle(service, { eventId: 'e2', text: '/confirm' });

      expect(confirmed.captureState).toBe('awaiting_details');
      expect(confirmed.reply).toContain('falta la cuenta');
      expect(await movementCount()).toBe(0);
    });

    it('no paga una deuda en una moneda distinta de la suya', async () => {
      await seedDebt({ sourceKey: 'deuda', currency: 'USD' });
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'debt_settle',
          amount: '3.00',
          currency: 'VES',
          accountId: ves,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            settlementMode: 'partial',
          }),
        }),
      ]);
      const service = buildService(interpreter);

      const preview = await handle(service, { eventId: 'e1', text: 'le pagué 3 bolívares a Carmen' });

      expect(preview.captureState).toBe('awaiting_details');
      expect(preview.reply).toContain('no hay ninguna deuda pendiente con "Carmen" en VES');
      expect(await movementCount()).toBe(0);
    });

    it('no paga una deuda indicada por id si la moneda no coincide', async () => {
      const debt = await seedDebt({ sourceKey: 'deuda', currency: 'USD' });
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'debt_settle',
          amount: '3.00',
          currency: 'VES',
          accountId: ves,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            debtId: debt.id,
            settlementMode: 'partial',
          }),
        }),
      ]);
      const service = buildService(interpreter);

      const preview = await handle(service, {
        eventId: 'e1',
        text: `le pagué 3 bolívares a la deuda ${debt.id}`,
      });

      expect(preview.captureState).toBe('awaiting_details');
      expect(preview.reply).toContain('no coincide con la contraparte, la direccion o la moneda');
      expect(await movementCount()).toBe(0);
    });
  });

  describe('ambiguedad al elegir la deuda', () => {
    it('pregunta con los ids cuando hay varias deudas de la misma contraparte', async () => {
      const first = await seedDebt({ sourceKey: 'deuda-1', minor: 1000n });
      const second = await seedDebt({ sourceKey: 'deuda-2', minor: 2500n });
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'debt_settle',
          amount: '3.00',
          currency: 'USD',
          accountId: usd,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            settlementMode: 'partial',
          }),
        }),
        operation({
          kind: 'debt_settle',
          amount: '3.00',
          currency: 'USD',
          accountId: usd,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            settlementMode: 'partial',
          }),
        }),
      ]);
      const service = buildService(interpreter);

      const ambiguous = await handle(service, { eventId: 'e1', text: 'le pagué 3 dólares a Carmen' });

      expect(ambiguous.captureState).toBe('awaiting_details');
      expect(ambiguous.reply).toContain('varias deudas');
      expect(ambiguous.reply).toContain(first.id);
      expect(ambiguous.reply).toContain(second.id);
      expect(await movementCount()).toBe(0);

      // El usuario elige una de las dos escribiendo su id.
      const chosen = await handle(service, { eventId: 'e2', text: `le pagué 3 dólares a la deuda ${second.id}` });

      expect(chosen.captureState).toBe('awaiting_confirmation');
      expect(chosen.reply).toContain(second.id);
      expect(chosen.reply).not.toContain(first.id);
    });

    it('un id propuesto por el modelo no evita la ambiguedad si el usuario no lo escribio', async () => {
      const first = await seedDebt({ sourceKey: 'deuda-1', minor: 1000n });
      const second = await seedDebt({ sourceKey: 'deuda-2', minor: 2500n });
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'debt_settle',
          amount: '3.00',
          currency: 'USD',
          accountId: usd,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            debtId: first.id,
            settlementMode: 'partial',
          }),
        }),
      ]);
      const service = buildService(interpreter);

      const outcome = await handle(service, { eventId: 'e1', text: 'le pagué 3 dólares a Carmen' });

      expect(outcome.captureState).toBe('awaiting_details');
      expect(outcome.reply).toContain('varias deudas');
      expect(outcome.reply).toContain(first.id);
      expect(outcome.reply).toContain(second.id);
      expect(await movementCount()).toBe(0);
    });

    it('distingue direccion, contraparte y moneda entre varias deudas de la misma persona', async () => {
      const payableUsd = await seedDebt({ sourceKey: 'p-usd', direction: 'payable', currency: 'USD', minor: 1000n });
      const payableVes = await seedDebt({ sourceKey: 'p-ves', direction: 'payable', currency: 'VES', minor: 2000n });
      const receivableUsd = await seedDebt({ sourceKey: 'r-usd', direction: 'receivable', currency: 'USD', minor: 3000n });
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'debt_settle',
          amount: '3.00',
          currency: 'USD',
          accountId: usd,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            settlementMode: 'partial',
          }),
        }),
        operation({
          kind: 'debt_settle',
          amount: '3.00',
          currency: 'USD',
          accountId: usd,
          debt: debtData({
            direction: 'receivable',
            counterparty: 'Carmen',
            settlementMode: 'partial',
          }),
        }),
      ]);
      const service = buildService(interpreter);

      const payable = await handle(service, { eventId: 'e1', text: 'le pagué 3 dólares a Carmen' });
      expect(payable.captureState).toBe('awaiting_confirmation');
      expect(payable.reply).toContain(payableUsd.id);

      const receivable = await handle(service, { eventId: 'e2', text: 'Carmen me pagó 3 dólares' });
      expect(receivable.captureState).toBe('awaiting_confirmation');
      expect(receivable.reply).toContain(receivableUsd.id);
      expect(receivable.reply).not.toContain(payableUsd.id);
      expect(payableVes.currency).toBe('VES');
    });

    it('un id escrito en el mensaje actual cambia el objetivo del borrador anterior', async () => {
      const first = await seedDebt({ sourceKey: 'deuda-1', minor: 1000n });
      const second = await seedDebt({ sourceKey: 'deuda-2', minor: 2500n });
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'debt_settle',
          amount: '3.00',
          currency: 'USD',
          accountId: null,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            settlementMode: 'partial',
          }),
        }),
        operation({
          kind: 'debt_settle',
          amount: '3.00',
          currency: 'USD',
          accountId: usd,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            settlementMode: 'partial',
          }),
        }),
      ]);
      const service = buildService(interpreter);

      // El primer mensaje deja pendiente la primera deuda (escrita por el usuario).
      const pendingPreview = await handle(service, {
        eventId: 'e1',
        text: `le pagué 3 dólares a la deuda ${first.id}`,
      });
      expect(pendingPreview.captureState).toBe('awaiting_details');
      expect(pendingPreview.reply).toContain('falta la cuenta');

      // El id escrito ahora manda sobre el objetivo anterior.
      const chosen = await handle(service, {
        eventId: 'e2',
        text: `le pagué 3 dólares a la deuda ${second.id}`,
      });

      expect(chosen.captureState).toBe('awaiting_confirmation');
      expect(chosen.reply).toContain(second.id);
      expect(chosen.reply).not.toContain(first.id);
    });

    it('varias deudas escritas en el mensaje conservan la ambiguedad aunque haya un borrador previo', async () => {
      const first = await seedDebt({ sourceKey: 'deuda-1', minor: 1000n });
      const second = await seedDebt({ sourceKey: 'deuda-2', minor: 2500n });
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'debt_settle',
          amount: '3.00',
          currency: 'USD',
          accountId: null,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            settlementMode: 'partial',
          }),
        }),
        operation({
          kind: 'debt_settle',
          amount: '3.00',
          currency: 'USD',
          accountId: usd,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            settlementMode: 'partial',
          }),
        }),
      ]);
      const service = buildService(interpreter);

      await handle(service, { eventId: 'e1', text: `le pagué 3 dólares a la deuda ${first.id}` });
      const before = await onlyRow(await db.dataSource.getRepository(Capture).find());
      expect(before.debtPayload).toContain(first.id);

      const ambiguous = await handle(service, {
        eventId: 'e2',
        text: `le pagué 3 dólares a las deudas ${first.id} y ${second.id}`,
      });

      expect(ambiguous.captureState).toBe('awaiting_details');
      expect(ambiguous.reply).toContain('varias deudas');
      expect(await movementCount()).toBe(0);
      // No queda ningun objetivo elegido: la ambiguedad se conserva.
      const after = await onlyRow(await db.dataSource.getRepository(Capture).find());
      expect(after.debtPayload).not.toContain(first.id);
    });

    it('cambiar de persona resuelve la deuda de la persona nueva', async () => {
      const carmen = await seedDebt({ sourceKey: 'carmen', counterparty: 'Carmen', minor: 1000n });
      const maria = await seedDebt({ sourceKey: 'maria', counterparty: 'María', minor: 4000n });
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'debt_settle',
          amount: '3.00',
          currency: 'USD',
          accountId: null,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            settlementMode: 'partial',
          }),
        }),
        operation({
          kind: 'debt_settle',
          amount: '3.00',
          currency: 'USD',
          accountId: usd,
          debt: debtData({
            direction: 'payable',
            counterparty: 'María',
            settlementMode: 'partial',
          }),
        }),
      ]);
      const service = buildService(interpreter);

      const first = await handle(service, { eventId: 'e1', text: 'le pagué 3 dólares a Carmen' });
      expect(first.captureState).toBe('awaiting_details');
      expect(first.reply).toContain('falta la cuenta');

      const changed = await handle(service, { eventId: 'e2', text: 'le pagué 3 dólares a María' });

      expect(changed.captureState).toBe('awaiting_confirmation');
      expect(changed.reply).toContain(maria.id);
      expect(changed.reply).not.toContain(carmen.id);
    });

    it('no encuentra una deuda que no existe y no inventa ninguna', async () => {      await seedDebt({ sourceKey: 'deuda', counterparty: 'Vecino' });
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'debt_settle',
          amount: '3.00',
          currency: 'USD',
          accountId: usd,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            settlementMode: 'partial',
          }),
        }),
      ]);
      const service = buildService(interpreter);

      const outcome = await handle(service, { eventId: 'e1', text: 'le pagué 3 dólares a Carmen' });

      expect(outcome.captureState).toBe('awaiting_details');
      expect(outcome.reply).toContain('no hay ninguna deuda pendiente');
      expect(await movementCount()).toBe(0);
      expect(await db.dataSource.getRepository(DebtPayment).count()).toBe(0);
    });
  });

  describe('consultas y estado pendiente', () => {
    it('responde la consulta sin tocar el borrador pendiente', async () => {
      const debt = await seedDebt({ sourceKey: 'deuda', minor: 1000n });
      const interpreter = new FakeInterpreter([
        operation({ kind: 'debt_create', amount: '8.00', currency: 'USD', debt: debtData({ direction: 'payable', counterparty: 'Carmen' }) }),
        operation({ kind: 'debt_query', debt: debtData({ direction: 'payable', counterparty: 'Carmen' }) }),
      ]);
      const service = buildService(interpreter);

      await handle(service, { eventId: 'e1', text: 'le debo 8$ a Carmen' });
      const before = await onlyRow(await db.dataSource.getRepository(Capture).find());

      const query = await handle(service, { eventId: 'e2', text: 'qué le debo a Carmen' });

      expect(query.reply).toContain(debt.id);
      expect(query.reply).toContain('Carmen');
      expect(query.reply).toContain('Lo que debo');
      expect(query.reply).toContain('pendiente 10.00');
      expect(await movementCount()).toBe(0);

      const after = await onlyRow(await db.dataSource.getRepository(Capture).find());
      expect(after).toEqual(before);
    });

    it('una consulta sin informacion suficiente no modifica el pendiente', async () => {
      const interpreter = new FakeInterpreter([
        operation({ kind: 'debt_create', amount: '8.00', currency: 'USD', debt: debtData({ direction: 'payable', counterparty: 'Carmen' }) }),
        operation({ kind: 'debt_query' }),
      ]);
      const service = buildService(interpreter);

      await handle(service, { eventId: 'e1', text: 'le debo 8$ a Carmen' });
      const before = await onlyRow(await db.dataSource.getRepository(Capture).find());

      const query = await handle(service, { eventId: 'e2', text: 'cuáles son mis deudas' });

      expect(query.reply).toContain('No hay deudas');
      // El borrador sigue vivo y en el mismo estado: la consulta no lo toca.
      expect(query.captureState).toBe('awaiting_confirmation');
      expect(await onlyRow(await db.dataSource.getRepository(Capture).find())).toEqual(before);
    });

    it('consulta antes que cualquier conversion o descarte', async () => {
      const interpreter = new FakeInterpreter([
        operation({ kind: 'debt_query', debt: debtData({ status: 'open' }) }),
      ]);
      const service = buildService(interpreter);

      const query = await handle(service, { eventId: 'e1', text: 'cuáles son mis deudas' });

      expect(query.reply).toContain('No hay deudas');
      expect(query.reply).not.toContain('conversiones');
      expect(query.captureState).toBeNull();
      expect(await db.dataSource.getRepository(Capture).count()).toBe(0);
    });
  });

  describe('durabilidad e idempotencia', () => {
    it('el borrador de deuda sobrevive a un reinicio y se confirma una sola vez', async () => {
      const interpreter = new FakeInterpreter([
        operation({ kind: 'debt_create', amount: '8.00', currency: 'USD', debt: debtData({ direction: 'payable', counterparty: 'Carmen' }) }),
      ]);
      const service = buildService(interpreter);

      await handle(service, { eventId: 'e1', text: 'le debo 8$ a Carmen' });

      await db.close();
      const reopened = await openDatabase(db.path);
      const restarted = buildService(interpreter, reopened);

      const confirmed = await handle(restarted, { eventId: 'e2', text: '/confirm' });

      expect(confirmed.captureState).toBe('registered');
      expect(confirmed.reply).toContain('Deuda:');
      expect(await reopened.getRepository(Debt).count()).toBe(1);
      expect(await reopened.getRepository(Movement).count()).toBe(0);

      await reopened.destroy();
    });

    it('reproduce el mismo evento sin volver a interpretar ni duplicar la deuda', async () => {
      const interpreter = new FakeInterpreter([
        operation({ kind: 'debt_create', amount: '8.00', currency: 'USD', debt: debtData({ direction: 'payable', counterparty: 'Carmen' }) }),
      ]);
      const service = buildService(interpreter);

      const first = await handle(service, { eventId: 'e1', text: 'le debo 8$ a Carmen' });
      const replay = await handle(service, { eventId: 'e1', text: 'le debo 8$ a Carmen' });

      expect(replay.reply).toBe(first.reply);
      expect(replay.replayed).toBe(true);
      expect(interpreter.requests).toHaveLength(1);
      expect(await db.dataSource.getRepository(CaptureEvent).count()).toBe(1);
    });

    it('no duplica la deuda cuando el mismo evento llega a la vez', async () => {
      const interpreter = new FakeInterpreter([
        operation({ kind: 'debt_create', amount: '8.00', currency: 'USD', debt: debtData({ direction: 'payable', counterparty: 'Carmen' }) }),
      ]);
      const service = buildService(interpreter);

      const [first, second] = await Promise.all([
        handle(service, { eventId: 'e1', text: 'le debo 8$ a Carmen' }),
        handle(service, { eventId: 'e1', text: 'le debo 8$ a Carmen' }),
      ]);

      expect(first.reply).toBe(second.reply);
      expect(interpreter.requests).toHaveLength(1);
      expect(await db.dataSource.getRepository(CaptureEvent).count()).toBe(1);
      expect(await debtCount()).toBe(0);
    });

    it('el confirm repetido no vuelve a escribir la deuda', async () => {
      const interpreter = new FakeInterpreter([
        operation({ kind: 'debt_create', amount: '8.00', currency: 'USD', debt: debtData({ direction: 'payable', counterparty: 'Carmen' }) }),
      ]);
      const service = buildService(interpreter);

      await handle(service, { eventId: 'e1', text: 'le debo 8$ a Carmen' });
      const confirmed = await handle(service, { eventId: 'e2', text: '/confirm' });
      const again = await handle(service, { eventId: 'e2', text: '/confirm' });

      expect(again.reply).toBe(confirmed.reply);
      expect(again.replayed).toBe(true);
      expect(await debtCount()).toBe(1);
    });
  });

  describe('salvaguardas', () => {
    it('un mensaje de deuda clasificado como gasto no registra nada y pide aclarar', async () => {
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'expense',
          amount: '8.00',
          currency: 'USD',
          accountId: usd,
          debt: debtData(),
        }),
      ]);
      const service = buildService(interpreter);

      const outcome = await handle(service, { eventId: 'e1', text: 'le debo 8$ a Carmen' });

      expect(outcome.captureState).toBe('awaiting_details');
      expect(outcome.reply).toContain('parece hablar de una deuda');
      expect(outcome.reply).toContain('No se registro nada');
      expect(await movementCount()).toBe(0);
      expect(await debtCount()).toBe(0);
    });

    it('un gasto normal con un comercio no se confunde con una deuda', async () => {
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'expense',
          amount: '8.00',
          currency: 'USD',
          accountId: usd,
          description: 'Helado',
          debt: debtData(),
        }),
      ]);
      const service = buildService(interpreter);

      const preview = await handle(service, { eventId: 'e1', text: 'Helado 8 dolares' });
      expect(preview.captureState).toBe('awaiting_confirmation');

      await handle(service, { eventId: 'e2', text: '/confirm' });
      expect(await movementCount()).toBe(1);
      expect(await debtCount()).toBe(0);
    });

    it('un borrador de deuda sin la autorizacion de pago total no paga el pendiente entero', async () => {
      const debt = await seedDebt({ sourceKey: 'deuda', minor: 1000n });

      // Un borrador escrito antes de existir el flag de autorizacion: no lo tiene.
      // Es la forma real que dejo la version anterior: importe, pendiente y cuenta
      // puestos, y el modo "full" sin ninguna autorizacion.
      const legacy = {
        version: 1,
        kind: 'debt_settle',
        direction: 'payable',
        counterparty: 'Carmen',
        debtId: debt.id,
        settlementMode: 'full',
        amount: '10.00',
        currency: 'USD',
        accountId: usd,
        occurredOn: TODAY,
        description: null,
        expectedOutstandingMinor: '1000',
      };
      expect(parseDebtDraft(JSON.stringify(legacy))?.fullIntent).toBe(false);

      await db.dataSource.getRepository(Capture).save({
        id: randomUUID(),
        chatId: 'chat-1',
        sourceKey: 'capture:antiguo',
        state: 'awaiting_confirmation',
        kind: 'debt_settle',
        amount: '10.00',
        currency: 'USD',
        accountId: usd,
        occurredOn: TODAY,
        description: null,
        debtPayload: JSON.stringify(legacy),
        sourceText: 'Carmen me pagó todo',
      });

      const interpreter = new FakeInterpreter([]);
      const service = buildService(interpreter);
      const confirmed = await handle(service, { eventId: 'e1', text: '/confirm' });

      expect(confirmed.captureState).toBe('awaiting_details');
      expect(confirmed.reply).toContain('no tiene la autorizacion del usuario');
      expect(await movementCount()).toBe(0);
      expect(await db.dataSource.getRepository(DebtPayment).count()).toBe(0);
      expect((await debts.get(debt.id)).outstandingMinor).toBe(1000n);
    });

    it('un pago parcial por el importe del pendiente es valido sin autorizacion de pago total', async () => {
      const debt = await seedDebt({ sourceKey: 'deuda', minor: 1000n });
      const interpreter = new FakeInterpreter([
        operation({
          kind: 'debt_settle',
          amount: '10.00',
          currency: 'USD',
          accountId: usd,
          debt: debtData({
            direction: 'payable',
            counterparty: 'Carmen',
            settlementMode: 'partial',
          }),
        }),
      ]);
      const service = buildService(interpreter);

      const preview = await handle(service, { eventId: 'e1', text: 'le pagué 10 dólares a Carmen' });
      expect(preview.captureState).toBe('awaiting_confirmation');
      expect(preview.reply).toContain('pago parcial');

      const confirmed = await handle(service, { eventId: 'e2', text: '/confirm' });

      expect(confirmed.captureState).toBe('registered');
      expect(await movementCount()).toBe(1);
      expect((await debts.get(debt.id)).status).toBe('paid');
    });

    it('un borrador de deuda ilegible se pide de nuevo sin mostrar el mensaje original', async () => {
      const interpreter = new FakeInterpreter([
        operation({ kind: 'debt_create', amount: '8.00', currency: 'USD', debt: debtData({ direction: 'payable', counterparty: 'Carmen' }) }),
      ]);
      const service = buildService(interpreter);

      await handle(service, { eventId: 'e1', text: 'le debo 8$ a Carmen por secretos' });
      await db.dataSource.getRepository(Capture).update({ chatId: 'chat-1' }, { debtPayload: '{esto no es json' });

      const confirmed = await handle(service, { eventId: 'e2', text: '/confirm' });

      expect(confirmed.captureState).toBe('awaiting_details');
      expect(confirmed.reply).toContain('No se pudo leer el borrador pendiente');
      expect(confirmed.reply).not.toContain('secretos');
      expect(await debtCount()).toBe(0);
      expect(await movementCount()).toBe(0);
    });

    it('acota las deudas candidatas y avisa cuando la lista se corta', async () => {
      for (let index = 0; index < 21; index += 1) {
        await seedDebt({ sourceKey: `deuda-${index}`, counterparty: `Persona ${index}`, minor: 100n });
      }
      const interpreter = new FakeInterpreter([
        operation({ kind: 'debt_query', debt: debtData({ status: 'open' }) }),
      ]);
      const service = buildService(interpreter);

      await handle(service, { eventId: 'e1', text: 'cuáles son mis deudas' });

      const request = interpreter.requests[0];
      expect(request?.debts).toHaveLength(20);
      expect(request?.debtsTruncated).toBe(true);
    });
  });
});
