import { Account } from '../src/accounts/account.entity';
import { AccountService } from '../src/accounts/account.service';
import { Capture } from '../src/capture/capture.entity';
import { CaptureEvent } from '../src/capture/capture-event.entity';
import { CaptureService } from '../src/capture/capture.service';
import { InferenceBudgetService } from '../src/capture/inference-budget.service';
import { CorrectionAction } from '../src/capture/correction';
import { encodeMetadata } from '../src/capture/correction-metadata';
import { AiLimits } from '../src/config/configuration';
import { TransactionRunner } from '../src/data/transaction.runner';
import { ConflictError } from '../src/domain/errors';
import { DebtService } from '../src/debts/debt.service';
import { FinancialService } from '../src/financial/financial.service';
import { Movement } from '../src/financial/movement.entity';
import { MovementRevision } from '../src/financial/movement-revision.entity';
import { FakeInterpreter } from './helpers/fake-interpreter';
import { createTempDatabase, TempDatabase } from './helpers/temp-database';

const CHAT_ID = 'chat-1';
const RECEIVED_AT = '2026-11-10T20:00:00.000Z';
const LIMITS: AiLimits = {
  maxRequestsPerDay: 100,
  maxInputTokensPerCall: 2000,
  maxOutputTokensPerCall: 500,
  maxCostMicroUsdPerCall: 5000,
  dailyBudgetMicroUsd: 200000,
};

describe('CaptureService: correccion de un gasto con botones', () => {
  let database: TempDatabase;
  let service: CaptureService;
  let interpreter: FakeInterpreter;
  let financial: FinancialService;
  let ves: Account;
  let usdt: Account;

  beforeEach(async () => {
    database = await createTempDatabase();
    const accounts = new AccountService(database.dataSource, database.transactions);
    ves = await accounts.add({ name: 'Bolivares', currency: 'VES' });
    usdt = await accounts.add({ name: 'Binance', currency: 'USDT' });
    const transactions = new TransactionRunner(database.dataSource);
    financial = new FinancialService(transactions);
    interpreter = new FakeInterpreter([]);
    service = new CaptureService(
      database.dataSource,
      transactions,
      financial,
      interpreter,
      new InferenceBudgetService(transactions, LIMITS),
      new DebtService(transactions, financial),
    );
  });

  afterEach(async () => {
    await database.cleanup();
  });

  function operation(overrides: Record<string, unknown> = {}) {
    return {
      amount: '1500.00',
      currency: 'VES',
      accountId: ves.id,
      kind: 'expense' as const,
      occurredOn: '2026-11-02',
      description: 'Cena',
      debt: null,
      ...overrides,
    };
  }

  /** Registra un gasto normal y devuelve el evento que lo confirmo (la oferta). */
  async function gastoRegistrado(
    accountId = ves.id,
    overrides: Record<string, unknown> = {},
  ): Promise<{ eventId: string; movementId: string }> {
    interpreter.responses.push(operation({ accountId, ...overrides }));
    await service.handle({ eventId: 'e1', chatId: CHAT_ID, text: 'Cena 1500 bs', receivedAt: RECEIVED_AT });
    const confirmed = await service.handle({
      eventId: 'e2',
      chatId: CHAT_ID,
      text: '/confirm',
      receivedAt: RECEIVED_AT,
    });
    expect(confirmed.captureState).toBe('registered');
    const event = await database.dataSource.getRepository(CaptureEvent).findOneBy({
      eventId: 'e2',
      chatId: CHAT_ID,
    });
    return { eventId: 'e2', movementId: event?.movementId as string };
  }

  /** Pulsa un boton del prompt indicado. */
  async function pulsar(
    promptEventId: string,
    action: CorrectionAction,
    eventId: string,
  ): Promise<{ reply: string | null; buttons: { text: string; data: string }[][] }> {
    const result = await service.applyCorrectionAction({
      originEventId: promptEventId,
      eventId,
      chatId: CHAT_ID,
      userId: '111',
      action,
    });
    return { reply: result.reply, buttons: result.buttons };
  }

  async function borrador(): Promise<Capture | null> {
    const rows = await database.dataSource.getRepository(Capture).find({ where: { chatId: CHAT_ID } });
    return rows.find((row) => row.state === 'awaiting_details' || row.state === 'awaiting_confirmation') ?? null;
  }

  it('registra el gasto y ofrece la correccion con su boton', async () => {
    const gasto = await gastoRegistrado();
    const buttons = await service.deliveryButtons(gasto.eventId, CHAT_ID);
    expect(buttons).toEqual([[{ text: 'Corregir este gasto', data: 'corr:iniciar' }]]);
    // Un ingreso no ofrece correccion.
    const event = await database.dataSource.getRepository(CaptureEvent).findOneBy({ eventId: 'e2' });
    expect(event?.metadata).toContain('"kind":"offer"');
  });

  it('el boton de inicio pide el importe y conserva fecha y descripcion', async () => {
    const gasto = await gastoRegistrado();
    const inicio = await pulsar(gasto.eventId, { type: 'start' }, 'e3');
    expect(inicio.reply).toContain('Cuanto fue');
    expect(inicio.buttons).toEqual([[{ text: 'Cancelar', data: 'corr:cancelar' }]]);
    const draft = await borrador();
    expect(draft?.kind).toBe('expense_correction');
    expect(draft?.amount).toBeNull();
    expect(draft?.correctionTargetEventId).not.toBeNull();
  });

  it('literal: 1500 VES pasa a 2 USDT conservando fecha y descripcion', async () => {
    const gasto = await gastoRegistrado();
    await pulsar(gasto.eventId, { type: 'start' }, 'e3');

    const valor = await service.handle({
      eventId: 'e4',
      chatId: CHAT_ID,
      text: '2$ por USDT',
      receivedAt: RECEIVED_AT,
    });
    expect(valor.captureState).toBe('awaiting_confirmation');
    expect(valor.reply).toContain('1500.00 VES');
    expect(valor.reply).toContain('2.000000 USDT');

    const draft = await borrador();
    expect(draft?.amount).toBe('2');
    expect(draft?.currency).toBe('USDT');
    expect(draft?.accountId).toBe(usdt.id);

    const aplicacion = await pulsar('e4', { type: 'apply' }, 'e5');
    expect(aplicacion.reply).toContain('Correccion aplicada');

    const financial = new FinancialService(database.transactions);
    const effective = (await financial.effectiveMovements()).find((row) => row.id === gasto.movementId);
    expect(effective?.voided).toBe(true);
    const movements = await database.dataSource.getRepository(Movement).find();
    const corregido = movements.find((row) => row.id !== gasto.movementId);
    expect(corregido).toMatchObject({
      accountId: usdt.id,
      currency: 'USDT',
      amountMinor: 2000000n,
      occurredOn: '2026-11-02',
      description: 'Cena',
    });
    // El saldo se movio una sola vez: el original quedo anulado.
    const balances = await financial.balances('2026-11-30');
    expect(balances.find((row) => row.accountId === ves.id)?.balance).toBe(0n);
    expect(balances.find((row) => row.accountId === usdt.id)?.balance).toBe(-2000000n);
  });

  it('con varias cuentas compatibles el usuario elige con botones sobre la lista guardada', async () => {
    const otro = await new AccountService(database.dataSource, database.transactions).add({
      name: 'Binance Dos',
      currency: 'USDT',
    });
    const gasto = await gastoRegistrado();
    await pulsar(gasto.eventId, { type: 'start' }, 'e3');

    const valor = await service.handle({
      eventId: 'e4',
      chatId: CHAT_ID,
      text: '2 USDT',
      receivedAt: RECEIVED_AT,
    });
    expect(valor.captureState).toBe('awaiting_details');
    const event = await database.dataSource.getRepository(CaptureEvent).findOneBy({ eventId: 'e4' });
    const metadata = JSON.parse(event?.metadata as string) as { accounts: { id: string }[] };
    expect(metadata.accounts).toHaveLength(2);

    const elegido = await pulsar('e4', { type: 'account', index: 1 }, 'e5');
    expect(elegido.reply).toContain('2.000000 USDT');
    const draft = await borrador();
    expect(draft?.accountId).toBe(otro.id);
  });

  it('una cuenta retirada no se puede elegir: se pide otro dato sin tocar el ledger', async () => {
    const otro = await new AccountService(database.dataSource, database.transactions).add({
      name: 'Binance Dos',
      currency: 'USDT',
    });
    const gasto = await gastoRegistrado();
    await pulsar(gasto.eventId, { type: 'start' }, 'e3');
    await service.handle({
      eventId: 'e4',
      chatId: CHAT_ID,
      text: '2 USDT',
      receivedAt: RECEIVED_AT,
    });
    await database.dataSource.getRepository(Account).update(otro.id, { active: false });

    const elegido = await pulsar('e4', { type: 'account', index: 1 }, 'e5');
    expect(elegido.reply).toContain('no esta disponible');
    expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
    const movements = await database.dataSource.getRepository(Movement).find();
    expect(movements[0]?.amountMinor).toBe(150000n);
  });

  it('un borrador normal o de deuda vivo no se pisa', async () => {
    const gasto = await gastoRegistrado();
    interpreter.responses.push(operation());
    await service.handle({ eventId: 'e3', chatId: CHAT_ID, text: 'Cafe 5 dolares', receivedAt: RECEIVED_AT });
    expect((await borrador())?.kind).toBe('expense');

    const inicio = await pulsar(gasto.eventId, { type: 'start' }, 'e4');
    expect(inicio.reply).toContain('operacion pendiente');
    expect((await borrador())?.kind).toBe('expense');
  });

  it('un origen viejo o de otro chat no aplica nada', async () => {
    const gasto = await gastoRegistrado();
    const inicio = await pulsar(gasto.eventId, { type: 'start' }, 'e3');
    expect(inicio.reply).toContain('Cuanto fue');

    // Un boton de otro chat: no hay evento que lo respalde.
    const cruzado = await service.applyCorrectionAction({
      originEventId: gasto.eventId,
      eventId: 'e4',
      chatId: 'chat-2',
      userId: '111',
      action: { type: 'apply' },
    });
    expect(cruzado.reply).toContain('no esta disponible');
    expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
  });

  it('un /confirm sobre un borrador correctivo es inerte y /cancel lo descarta', async () => {
    const gasto = await gastoRegistrado();
    await pulsar(gasto.eventId, { type: 'start' }, 'e3');

    const confirm = await service.handle({
      eventId: 'e4',
      chatId: CHAT_ID,
      text: '/confirm',
      receivedAt: RECEIVED_AT,
    });
    expect(confirm.reply).toContain('boton');
    expect(await database.dataSource.getRepository(Movement).count()).toBe(1);

    const cancel = await service.handle({
      eventId: 'e5',
      chatId: CHAT_ID,
      text: '/cancel',
      receivedAt: RECEIVED_AT,
    });
    expect(cancel.captureState).toBe('cancelled');
    expect(await borrador()).toBeNull();
  });

  it('el boton de cancelar del prompt descarta la correccion', async () => {
    const gasto = await gastoRegistrado();
    await pulsar(gasto.eventId, { type: 'start' }, 'e3');
    const cancelado = await pulsar('e3', { type: 'cancel' }, 'e4');
    expect(cancelado.reply).toContain('descartada');
    expect(await borrador()).toBeNull();
    expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
  });

  it('un valor invalido se rechaza y el borrador sigue vivo', async () => {
    const gasto = await gastoRegistrado();
    await pulsar(gasto.eventId, { type: 'start' }, 'e3');
    for (const text of ['-2 USDT', '2 EUR', '1.500 USDT', '2 USD por USDT', 'ayer cafe']) {
      const respuesta = await service.handle({
        eventId: `e-${text}`,
        chatId: CHAT_ID,
        text,
        receivedAt: RECEIVED_AT,
      });
      expect(respuesta.reply).toContain('No se entiende');
      expect(await borrador()).not.toBeNull();
    }
    expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
  });

  it('el mismo evento repetido no aplica la correccion dos veces', async () => {
    const gasto = await gastoRegistrado();
    await pulsar(gasto.eventId, { type: 'start' }, 'e3');
    await service.handle({
      eventId: 'e4',
      chatId: CHAT_ID,
      text: '2 USDT',
      receivedAt: RECEIVED_AT,
    });
    const primero = await pulsar('e4', { type: 'apply' }, 'e5');
    const segundo = await pulsar('e4', { type: 'apply' }, 'e5');
    expect(primero.reply).toContain('aplicada');
    expect(segundo.reply).toBe(primero.reply);
    const movements = await database.dataSource.getRepository(Movement).find();
    expect(movements.filter((row) => row.kind === 'expense')).toHaveLength(2);
  });

  it('un boton de la version anterior no aplica ni cancela: solo vale el de la vigente', async () => {
    const gasto = await gastoRegistrado();
    await pulsar(gasto.eventId, { type: 'start' }, 'e3');
    await service.handle({
      eventId: 'e4',
      chatId: CHAT_ID,
      text: '2 USDT',
      receivedAt: RECEIVED_AT,
    });
    // La version 2 es la revision: el boton de cambiar importe abre la version 3.
    const cambiar = await pulsar('e4', { type: 'amount' }, 'e5');
    expect(cambiar.reply).toContain('Cuanto fue');
    expect(cambiar.buttons).toEqual([[{ text: 'Cancelar', data: 'corr:cancelar' }]]);

    // El boton de aplicar de la version 2 ya no vale: no aplica ni destruye nada.
    const viejo = await pulsar('e4', { type: 'apply' }, 'e6');
    expect(viejo.reply).toContain('no esta disponible');
    expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
    expect(await borrador()).not.toBeNull();

    // El boton de cancelar de la version 2 tampoco: el borrador sigue vivo.
    const viejoCancelar = await pulsar('e4', { type: 'cancel' }, 'e7');
    expect(viejoCancelar.reply).toContain('no esta disponible');
    expect(await borrador()).not.toBeNull();

    // La version 3 si vale: el importe nuevo y su boton exacto aplican una vez.
    await service.handle({
      eventId: 'e8',
      chatId: CHAT_ID,
      text: '3 USDT',
      receivedAt: RECEIVED_AT,
    });
    const aplicado = await pulsar('e8', { type: 'apply' }, 'e9');
    expect(aplicado.reply).toContain('aplicada');
    const repetido = await pulsar('e8', { type: 'apply' }, 'e10');
    expect(repetido.reply).toContain('no esta disponible');
    const movements = await database.dataSource.getRepository(Movement).find();
    expect(movements.filter((row) => row.kind === 'expense')).toHaveLength(2);
    const corregido = movements.find((row) => row.currency === 'USDT');
    expect(corregido?.amountMinor).toBe(3000000n);
  });

  it('el texto en la fase de revision no emite botones nuevos ni altera el borrador', async () => {
    const gasto = await gastoRegistrado();
    await pulsar(gasto.eventId, { type: 'start' }, 'e3');
    await service.handle({
      eventId: 'e4',
      chatId: CHAT_ID,
      text: '2 USDT',
      receivedAt: RECEIVED_AT,
    });
    const antes = await borrador();

    const respuesta = await service.handle({
      eventId: 'e5',
      chatId: CHAT_ID,
      text: '5 USDT',
      receivedAt: RECEIVED_AT,
    });
    expect(respuesta.reply).toContain('botones');

    const despues = await borrador();
    expect(despues?.amount).toBe(antes?.amount);
    expect(despues?.currency).toBe(antes?.currency);
    expect(despues?.accountId).toBe(antes?.accountId);
    expect(despues?.state).toBe(antes?.state);
    expect(despues?.sourceKey).toBe(antes?.sourceKey);
    // El mensaje del texto no lleva teclado: no se fabrica un menu sin antes ni despues.
    const event = await database.dataSource.getRepository(CaptureEvent).findOneBy({ eventId: 'e5' });
    expect(event?.metadata).toBeNull();
    expect(await service.deliveryButtons('e5', CHAT_ID)).toEqual([]);
  });

  it('el texto en la fase de cuentas no emite botones nuevos ni altera el borrador', async () => {
    await new AccountService(database.dataSource, database.transactions).add({
      name: 'Binance Dos',
      currency: 'USDT',
    });
    const gasto = await gastoRegistrado();
    await pulsar(gasto.eventId, { type: 'start' }, 'e3');
    await service.handle({
      eventId: 'e4',
      chatId: CHAT_ID,
      text: '2 USDT',
      receivedAt: RECEIVED_AT,
    });
    const antes = await borrador();
    expect(antes?.state).toBe('awaiting_details');

    const respuesta = await service.handle({
      eventId: 'e5',
      chatId: CHAT_ID,
      text: '5 USDT',
      receivedAt: RECEIVED_AT,
    });
    expect(respuesta.reply).toContain('botones');

    const despues = await borrador();
    expect(despues?.amount).toBe(antes?.amount);
    expect(despues?.state).toBe(antes?.state);
    expect(despues?.sourceKey).toBe(antes?.sourceKey);
    const event = await database.dataSource.getRepository(CaptureEvent).findOneBy({ eventId: 'e5' });
    expect(event?.metadata).toBeNull();
  });

  it('el resumen muestra las dos cuentas, la fecha y la descripcion aunque el importe no cambie', async () => {
    const otro = await new AccountService(database.dataSource, database.transactions).add({
      name: 'Binance Dos',
      currency: 'USDT',
    });
    const gasto = await gastoRegistrado(usdt.id, { currency: 'USDT', amount: '1500.00' });
    await pulsar(gasto.eventId, { type: 'start' }, 'e3');
    await service.handle({
      eventId: 'e4',
      chatId: CHAT_ID,
      text: '1500 USDT',
      receivedAt: RECEIVED_AT,
    });
    // El mismo importe y la misma moneda: solo cambia la cuenta.
    const resumen = await pulsar('e4', { type: 'account', index: 1 }, 'e5');
    expect(resumen.reply).toContain('antes');
    expect(resumen.reply).toContain('despues');
    // Las dos cuentas: la de antes y la de despues.
    expect(resumen.reply).toContain('- antes: 1500.000000 USDT en Binance\n');
    expect(resumen.reply).toContain('- despues: 1500.000000 USDT en Binance Dos');
    // Y la fecha y la descripcion, que no cambian.
    expect(resumen.reply).toContain('2026-11-02');
    expect(resumen.reply).toContain('Cena');
    expect((await borrador())?.accountId).toBe(otro.id);
  });

  it.each([
    ['corrupto', '{roto'],
    ['ausente', null],
  ])('un prompt con metadatos %s no se usa ni se renderiza', async (_caso, metadata) => {
    const gasto = await gastoRegistrado();
    await pulsar(gasto.eventId, { type: 'start' }, 'e3');
    await service.handle({
      eventId: 'e4',
      chatId: CHAT_ID,
      text: '2 USDT',
      receivedAt: RECEIVED_AT,
    });
    await database.dataSource.getRepository(CaptureEvent).update({ eventId: 'e4' }, { metadata });

    // Un prompt ilegible no renderiza ningun boton.
    expect(await service.deliveryButtons('e4', CHAT_ID)).toEqual([]);
    const aplicar = await pulsar('e4', { type: 'apply' }, 'e5');
    expect(aplicar.reply).toContain('no esta disponible');
    expect(aplicar.buttons).toEqual([]);
    // Y no modifica nada: ni el ledger ni el borrador.
    expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
    expect(await borrador()).not.toBeNull();
  });

  it('un prompt con metadatos de otra fase no vale', async () => {
    const gasto = await gastoRegistrado();
    await pulsar(gasto.eventId, { type: 'start' }, 'e3');
    await service.handle({
      eventId: 'e4',
      chatId: CHAT_ID,
      text: '2 USDT',
      receivedAt: RECEIVED_AT,
    });
    // Los metadatos son de la fase de importe, no de la de revision.
    await database.dataSource.getRepository(CaptureEvent).update(
      { eventId: 'e4' },
      { metadata: encodeMetadata({ kind: 'amount', origin: 'capture:otra' }) },
    );
    const aplicar = await pulsar('e4', { type: 'apply' }, 'e5');
    expect(aplicar.reply).toContain('no esta disponible');
    expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
    expect(await borrador()).not.toBeNull();
  });

  it('un fallo al aplicar se propaga: el mismo evento se reintenta y aplica una sola vez', async () => {
    const gasto = await gastoRegistrado();
    await pulsar(gasto.eventId, { type: 'start' }, 'e3');
    await service.handle({
      eventId: 'e4',
      chatId: CHAT_ID,
      text: '2 USDT',
      receivedAt: RECEIVED_AT,
    });
    const spy = jest
      .spyOn(financial, 'correctExpense')
      .mockRejectedValueOnce(new Error('fallo de escritura'));

    // Un fallo de infraestructura no es una respuesta: se propaga.
    await expect(pulsar('e4', { type: 'apply' }, 'e5')).rejects.toThrow('fallo de escritura');
    // No se toco el ledger ni el borrador.
    expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
    expect((await borrador())?.state).toBe('awaiting_confirmation');
    // Y el evento no quedo cerrado: el mismo evento se puede reintentar.
    expect(
      await database.dataSource.getRepository(CaptureEvent).findOneBy({ eventId: 'e5' }),
    ).toBeNull();

    // El mismo evento se reintenta y aplica una sola vez.
    spy.mockRestore();
    const reintento = await pulsar('e4', { type: 'apply' }, 'e5');
    expect(reintento.reply).toContain('aplicada');
    const movements = await database.dataSource.getRepository(Movement).find();
    expect(movements.filter((row) => row.kind === 'expense')).toHaveLength(2);
  });

  it('un rechazo de dominio es una respuesta terminal y durable', async () => {
    const gasto = await gastoRegistrado();
    await pulsar(gasto.eventId, { type: 'start' }, 'e3');
    await service.handle({
      eventId: 'e4',
      chatId: CHAT_ID,
      text: '2 USDT',
      receivedAt: RECEIVED_AT,
    });
    jest
      .spyOn(financial, 'correctExpense')
      .mockRejectedValueOnce(new ConflictError('El gasto ya fue revisado.'));

    // El rechazo se responde, no se propaga: no tiene sentido reintentarlo.
    const rechazo = await pulsar('e4', { type: 'apply' }, 'e5');
    expect(rechazo.reply).toContain('No se pudo aplicar');
    expect(rechazo.reply).toContain('ya fue revisado');
    // Y es durable: el mismo evento reproduce la misma respuesta.
    const repetido = await pulsar('e4', { type: 'apply' }, 'e5');
    expect(repetido.reply).toBe(rechazo.reply);
    expect(await database.dataSource.getRepository(Movement).count()).toBe(1);
  });

  it('un fallo despues de aplicar revierte los dos asientos', async () => {
    const gasto = await gastoRegistrado();
    await pulsar(gasto.eventId, { type: 'start' }, 'e3');
    await service.handle({
      eventId: 'e4',
      chatId: CHAT_ID,
      text: '2 USDT',
      receivedAt: RECEIVED_AT,
    });
    const original = financial.correctExpense.bind(financial);
    jest.spyOn(financial, 'correctExpense').mockImplementation(async (input, manager) => {
      await original(input, manager);
      throw new Error('fallo despues de aplicar');
    });

    // El fallo de infraestructura se propaga: la transaccion se revierte entera.
    await expect(pulsar('e4', { type: 'apply' }, 'e5')).rejects.toThrow('fallo despues de aplicar');
    // Ni la anulacion del original ni el movimiento de reemplazo: los dos asientos
    // desaparecieron.
    const movements = await database.dataSource.getRepository(Movement).find();
    expect(movements.filter((row) => row.kind === 'expense')).toHaveLength(1);
    const revisions = await database.dataSource.getRepository(MovementRevision).find();
    expect(revisions).toHaveLength(0);
    // El borrador sigue vivo: la correccion se puede reintentar.
    expect((await borrador())?.state).toBe('awaiting_confirmation');
  });

  it('un fallo al preparar la revision se revierte y el mismo evento se reintenta', async () => {
    const gasto = await gastoRegistrado();
    await pulsar(gasto.eventId, { type: 'start' }, 'e3');
    jest
      .spyOn(financial, 'previewExpenseCorrection')
      .mockRejectedValueOnce(new Error('fallo de lectura'));

    await expect(
      service.handle({
        eventId: 'e4',
        chatId: CHAT_ID,
        text: '2 USDT',
        receivedAt: RECEIVED_AT,
      }),
    ).rejects.toThrow('fallo de lectura');

    // El borrador se preserva y el evento no quedo cerrado a medias.
    const vivo = await borrador();
    expect(vivo?.amount).toBeNull();
    expect(vivo?.currency).toBeNull();
    expect(vivo?.state).toBe('awaiting_details');
    expect(
      await database.dataSource.getRepository(CaptureEvent).findOneBy({ eventId: 'e4' }),
    ).toBeNull();

    // El mismo evento se reintenta y la transicion se completa.
    jest.restoreAllMocks();
    const valor = await service.handle({
      eventId: 'e4',
      chatId: CHAT_ID,
      text: '2 USDT',
      receivedAt: RECEIVED_AT,
    });
    expect(valor.reply).toContain('2.000000 USDT');
    expect((await borrador())?.state).toBe('awaiting_confirmation');
  });
});
