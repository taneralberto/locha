import { Logger } from '@nestjs/common';
import { Account } from '../src/accounts/account.entity';
import { AccountService } from '../src/accounts/account.service';
import { BudgetService } from '../src/budgets/budget.service';
import { GoalService } from '../src/savings/goal.service';
import { SavingsService } from '../src/savings/savings.service';
import { CaptureService } from '../src/capture/capture.service';
import { InferenceBudgetService } from '../src/capture/inference-budget.service';
import { TelegramSettings } from '../src/config/configuration';
import { TransactionRunner } from '../src/data/transaction.runner';
import { DebtService } from '../src/debts/debt.service';
import { FinancialService } from '../src/financial/financial.service';
import { Movement } from '../src/financial/movement.entity';
import { MovementRevision } from '../src/financial/movement-revision.entity';
import { TelegramInbox } from '../src/telegram/telegram-inbox.entity';
import { TelegramCommands } from '../src/telegram/telegram-commands';
import { TelegramMessage, TelegramUpdate } from '../src/telegram/telegram-update';
import { TelegramService } from '../src/telegram/telegram.service';
import { FakeInterpreter } from './helpers/fake-interpreter';
import { FakeTelegramClient, waitUntil } from './helpers/fake-telegram';
import { createTempDatabase, TempDatabase } from './helpers/temp-database';

const USER_ID = 111;
const CHAT_ID = 111;
const RECEIVED_AT = '2026-11-10T20:00:00.000Z';

const SETTINGS: TelegramSettings = {
  enabled: true,
  partial: false,
  botToken: 'token-de-prueba',
  allowedUserId: USER_ID,
  allowedChatId: CHAT_ID,
  timeoutMs: 1_000,
  maxResponseBytes: 65_536,
  pollTimeoutSeconds: 1,
};

const LIMITS = {
  maxRequestsPerDay: 100,
  maxInputTokensPerCall: 2000,
  maxOutputTokensPerCall: 500,
  maxCostMicroUsdPerCall: 5000,
  dailyBudgetMicroUsd: 200000,
};

function messageUpdate(updateId: number, text: string): TelegramUpdate {
  const message: TelegramMessage = {
    chatId: String(CHAT_ID),
    chatType: 'private',
    userId: String(USER_ID),
    isBot: false,
    text,
    receivedAt: RECEIVED_AT,
  };
  return { updateId, message };
}

/** Pulsacion de un boton del ultimo mensaje del bot. */
function callbackUpdate(updateId: number, messageId: number, data: string): TelegramUpdate {
  return {
    updateId,
    message: null,
    callback: {
      callbackId: `cb-${updateId}`,
      data,
      chatId: String(CHAT_ID),
      chatType: 'private',
      userId: String(USER_ID),
      isBot: false,
      messageId,
      inline: false,
      receivedAt: RECEIVED_AT,
    },
  };
}

describe('Telegram: correccion de un gasto con botones', () => {
  let database: TempDatabase;
  let client: FakeTelegramClient;
  let telegram: TelegramService;
  let ves: Account;
  let usdt: Account;

  beforeEach(async () => {
    database = await createTempDatabase();
    const accounts = new AccountService(database.dataSource, database.transactions);
    ves = await accounts.add({ name: 'Bolivares', currency: 'VES' });
    usdt = await accounts.add({ name: 'Binance', currency: 'USDT' });
    client = new FakeTelegramClient();
    telegram = buildService();
  });

  afterEach(async () => {
    await telegram.stop();
    await database.cleanup();
  });

  function buildService(): TelegramService {
    const transactions = new TransactionRunner(database.dataSource);
    const financial = new FinancialService(transactions);
    const capture = new CaptureService(
      database.dataSource,
      transactions,
      financial,
      new FakeInterpreter([
        {
          amount: '1500.00',
          currency: 'VES',
          accountId: ves.id,
          kind: 'expense',
          occurredOn: '2026-11-02',
          description: 'Cena',
          debt: null,
        },
      ]),
      new InferenceBudgetService(transactions, LIMITS),
      new DebtService(transactions, financial),
    );
    const commands = new TelegramCommands(
      capture,
      financial,
      new AccountService(database.dataSource, transactions),
      new InferenceBudgetService(transactions, LIMITS),
      LIMITS,
      new BudgetService(transactions, financial),
      new SavingsService(transactions, financial, new GoalService(transactions)),
      new DebtService(transactions, financial),
    );
    return new TelegramService(
      database.dataSource,
      transactions,
      commands,
      capture,
      client,
      SETTINGS,
    );
  }

  it('1500 VES pasan a 2 USDT con dos pulsaciones y sin doblemovimiento', async () => {
    client.enqueue(messageUpdate(1, 'Cena 1500 bs'));
    await telegram.start();
    await waitUntil(() => client.sent.length === 1);

    client.enqueue(messageUpdate(2, '/confirm'));
    await waitUntil(() => client.sent.length === 2);
    const aviso = client.sent[1]!;
    expect(aviso.text).toContain('Registrado');
    // El aviso ofrece la correccion con su boton.
    expect(aviso.buttons).toEqual([[{ text: 'Corregir este gasto', data: 'corr:iniciar' }]]);
    const avisoId = 1002;

    // Primera pulsacion: el boton de inicio pide el importe.
    client.enqueue(callbackUpdate(3, avisoId, 'corr:iniciar'));
    await waitUntil(() => client.sent.length === 3);
    expect(client.sent[2]!.text).toContain('Cuanto fue');

    // El usuario responde el importe: 2$ por USDT.
    client.enqueue(messageUpdate(4, '2$ por USDT'));
    await waitUntil(() => client.sent.length === 4);
    const revision = client.sent[3]!;
    expect(revision.text).toContain('1500.00 VES');
    expect(revision.text).toContain('2.000000 USDT');
    expect(revision.buttons.flat().map((button) => button.data)).toContain('corr:aplicar');
    const revisionId = 1004;

    // Segunda pulsacion: aplicar la correccion.
    client.enqueue(callbackUpdate(5, revisionId, 'corr:aplicar'));
    await waitUntil(() => client.sent.length === 5);
    expect(client.sent[4]!.text).toContain('Correccion aplicada');

    const financial = new FinancialService(database.transactions);
    const movements = await database.dataSource.getRepository(
      (await import('../src/financial/movement.entity')).Movement,
    ).find();
    expect(movements.filter((row) => row.kind === 'expense')).toHaveLength(2);
    const corregido = movements.find((row) => row.currency === 'USDT');
    expect(corregido).toMatchObject({
      amountMinor: 2000000n,
      accountId: usdt.id,
      occurredOn: '2026-11-02',
      description: 'Cena',
    });
    const balances = await financial.balances('2026-11-30');
    expect(balances.find((row) => row.accountId === ves.id)?.balance).toBe(0n);
    expect(balances.find((row) => row.accountId === usdt.id)?.balance).toBe(-2000000n);
  });

  it('con varias cuentas el boton de cuenta elige de la lista guardada', async () => {
    await new AccountService(database.dataSource, database.transactions).add({
      name: 'Binance Dos',
      currency: 'USDT',
    });
    client.enqueue(messageUpdate(1, 'Cena 1500 bs'));
    await telegram.start();
    await waitUntil(() => client.sent.length === 1);
    client.enqueue(messageUpdate(2, '/confirm'));
    await waitUntil(() => client.sent.length === 2);
    const avisoId = 1002;

    client.enqueue(callbackUpdate(3, avisoId, 'corr:iniciar'));
    await waitUntil(() => client.sent.length === 3);
    client.enqueue(messageUpdate(4, '2 USDT'));
    await waitUntil(() => client.sent.length === 4);
    const cuentas = client.sent[3]!;
    const datos = cuentas.buttons.flat().filter((button) => button.data.startsWith('corr:cuenta:'));
    expect(datos).toHaveLength(2);
    const promptCuentas = 1004;

    client.enqueue(callbackUpdate(5, promptCuentas, 'corr:cuenta:0'));
    await waitUntil(() => client.sent.length === 5);
    expect(client.sent[4]!.text).toContain('2.000000 USDT');
  });

  it('el boton de cancelar del prompt descarta la correccion sin tocar el ledger', async () => {
    client.enqueue(messageUpdate(1, 'Cena 1500 bs'));
    await telegram.start();
    await waitUntil(() => client.sent.length === 1);
    client.enqueue(messageUpdate(2, '/confirm'));
    await waitUntil(() => client.sent.length === 2);
    const avisoId = 1002;

    client.enqueue(callbackUpdate(3, avisoId, 'corr:iniciar'));
    await waitUntil(() => client.sent.length === 3);
    client.enqueue(callbackUpdate(4, 1003, 'corr:cancelar'));
    await waitUntil(() => client.sent.length === 4);
    expect(client.sent[3]!.text).toContain('descartada');

    const financial = new FinancialService(database.transactions);
    const balances = await financial.balances('2026-11-30');
    expect(balances.find((row) => row.accountId === ves.id)?.balance).toBe(-150000n);
  });

  it('un boton viejo no hace nada', async () => {
    client.enqueue(messageUpdate(1, 'Cena 1500 bs'));
    await telegram.start();
    await waitUntil(() => client.sent.length === 1);
    client.enqueue(messageUpdate(2, '/confirm'));
    await waitUntil(() => client.sent.length === 2);

    // Un boton de una entrega que no es la del prompt: no cambia nada.
    client.enqueue(callbackUpdate(3, 9999, 'corr:iniciar'));
    await waitUntil(() => client.acks.length === 1);
    expect(client.sent).toHaveLength(2);
    const financial = new FinancialService(database.transactions);
    const balances = await financial.balances('2026-11-30');
    expect(balances.find((row) => row.accountId === ves.id)?.balance).toBe(-150000n);
  });

  it('tras cambiar el importe, el boton de aplicar de la version anterior no hace nada', async () => {
    client.enqueue(messageUpdate(1, 'Cena 1500 bs'));
    await telegram.start();
    await waitUntil(() => client.sent.length === 1);
    client.enqueue(messageUpdate(2, '/confirm'));
    await waitUntil(() => client.sent.length === 2);
    const avisoId = 1002;

    client.enqueue(callbackUpdate(3, avisoId, 'corr:iniciar'));
    await waitUntil(() => client.sent.length === 3);
    client.enqueue(messageUpdate(4, '2$ por USDT'));
    await waitUntil(() => client.sent.length === 4);
    const revisionId = 1004;

    // Cambiar el importe: la version del importe es la vigente.
    client.enqueue(callbackUpdate(5, revisionId, 'corr:importe'));
    await waitUntil(() => client.sent.length === 5);
    expect(client.sent[4]!.text).toContain('Cuanto fue');

    // El boton de aplicar de la version anterior ya no vale.
    client.enqueue(callbackUpdate(6, revisionId, 'corr:aplicar'));
    await waitUntil(() => client.sent.length === 6);
    expect(client.sent[5]!.text).toContain('no esta disponible');

    // Y el de cancelar tampoco: la correccion sigue viva.
    client.enqueue(callbackUpdate(7, revisionId, 'corr:cancelar'));
    await waitUntil(() => client.sent.length === 7);
    expect(client.sent[6]!.text).toContain('no esta disponible');

    const financial = new FinancialService(database.transactions);
    const balances = await financial.balances('2026-11-30');
    expect(balances.find((row) => row.accountId === ves.id)?.balance).toBe(-150000n);
  });

  it('la seleccion de cuenta de una version anterior no vale', async () => {
    await new AccountService(database.dataSource, database.transactions).add({
      name: 'Binance Dos',
      currency: 'USDT',
    });
    client.enqueue(messageUpdate(1, 'Cena 1500 bs'));
    await telegram.start();
    await waitUntil(() => client.sent.length === 1);
    client.enqueue(messageUpdate(2, '/confirm'));
    await waitUntil(() => client.sent.length === 2);
    const avisoId = 1002;

    client.enqueue(callbackUpdate(3, avisoId, 'corr:iniciar'));
    await waitUntil(() => client.sent.length === 3);
    client.enqueue(messageUpdate(4, '2 USDT'));
    await waitUntil(() => client.sent.length === 4);
    const cuentasId = 1004;

    // La cuenta elegida deja la version de las cuentas vieja.
    client.enqueue(callbackUpdate(5, cuentasId, 'corr:cuenta:0'));
    await waitUntil(() => client.sent.length === 5);
    expect(client.sent[4]!.text).toContain('2.000000 USDT');
    const revisionId = 1005;

    client.enqueue(callbackUpdate(6, revisionId, 'corr:importe'));
    await waitUntil(() => client.sent.length === 6);
    expect(client.sent[5]!.text).toContain('Cuanto fue');

    // La seleccion de la version de las cuentas ya no vale.
    client.enqueue(callbackUpdate(7, cuentasId, 'corr:cuenta:1'));
    await waitUntil(() => client.sent.length === 7);
    expect(client.sent[6]!.text).toContain('no esta disponible');

    const financial = new FinancialService(database.transactions);
    const balances = await financial.balances('2026-11-30');
    expect(balances.find((row) => row.accountId === ves.id)?.balance).toBe(-150000n);
  });

  it('el texto en la revision no emite botones y deja el borrador como estaba', async () => {
    client.enqueue(messageUpdate(1, 'Cena 1500 bs'));
    await telegram.start();
    await waitUntil(() => client.sent.length === 1);
    client.enqueue(messageUpdate(2, '/confirm'));
    await waitUntil(() => client.sent.length === 2);
    const avisoId = 1002;

    client.enqueue(callbackUpdate(3, avisoId, 'corr:iniciar'));
    await waitUntil(() => client.sent.length === 3);
    client.enqueue(messageUpdate(4, '2$ por USDT'));
    await waitUntil(() => client.sent.length === 4);
    const revisionId = 1004;

    // Un texto en la revision: no se fabrica ningun menu.
    client.enqueue(messageUpdate(5, '5$ por USDT'));
    await waitUntil(() => client.sent.length === 5);
    expect(client.sent[4]!.text).toContain('botones');
    expect(client.sent[4]!.buttons).toEqual([]);

    // El borrador sigue como estaba: su boton de aplicar sigue valiendo.
    client.enqueue(callbackUpdate(6, revisionId, 'corr:aplicar'));
    await waitUntil(() => client.sent.length === 6);
    expect(client.sent[5]!.text).toContain('Correccion aplicada');

    const financial = new FinancialService(database.transactions);
    const balances = await financial.balances('2026-11-30');
    expect(balances.find((row) => row.accountId === ves.id)?.balance).toBe(0n);
    expect(balances.find((row) => row.accountId === usdt.id)?.balance).toBe(-2000000n);
  });

  it('un fallo al cerrar el evento tras aplicar deja la pulsacion pendiente y se reintenta sola', async () => {
    client.enqueue(messageUpdate(1, 'Cena 1500 bs'));
    await telegram.start();
    await waitUntil(() => client.sent.length === 1);
    client.enqueue(messageUpdate(2, '/confirm'));
    await waitUntil(() => client.sent.length === 2);
    const avisoId = 1002;

    client.enqueue(callbackUpdate(3, avisoId, 'corr:iniciar'));
    await waitUntil(() => client.sent.length === 3);
    client.enqueue(messageUpdate(4, '2$ por USDT'));
    await waitUntil(() => client.sent.length === 4);
    const revisionId = 1004;

    // El trigger hace fallar el cierre del evento de la pulsacion (update 5), que es
    // lo que ocurre **despues** de que el dominio haya escrito.
    await database.dataSource.query(
      `CREATE TRIGGER fallo_cierre BEFORE UPDATE ON capture_event
       WHEN OLD.eventId = 'telegram:5'
       BEGIN SELECT RAISE(ABORT, 'fallo de cierre'); END`,
    );
    const avisos = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      client.enqueue(callbackUpdate(5, revisionId, 'corr:aplicar'));
      await waitUntil(() =>
        avisos.mock.calls.some((call) => String(call[0]).includes('actualizacion 5 de Telegram')),
      );

      // El ledger no se toco: el original sigue activo y no hay reemplazo.
      const movements = await database.dataSource.getRepository(Movement).find();
      expect(movements.filter((row) => row.kind === 'expense')).toHaveLength(1);
      const revisions = await database.dataSource.getRepository(MovementRevision).find();
      expect(revisions).toHaveLength(0);

      // La pulsacion sigue pendiente: la bandeja la conserva y no se confirma.
      const inbox = await database.dataSource.getRepository(TelegramInbox).findOneBy({
        updateId: 5,
      });
      expect(inbox?.state).toBe('accepted');
      expect(inbox?.callback).not.toBeNull();
      expect(client.acks.map((ack) => ack.callbackId)).not.toContain('cb-5');
      // Y al usuario no le llega ningun aviso: no se responde lo que no se aplico.
      expect(client.sent).toHaveLength(4);

      // Se quita el trigger: el transporte reintenta **el mismo** evento, sin que el
      // usuario vuelva a pulsar, y la correccion se escribe una sola vez.
      await database.dataSource.query(`DROP TRIGGER fallo_cierre`);
      await waitUntil(() => client.sent.length === 5);
      expect(client.sent[4]!.text).toContain('Correccion aplicada');
      expect(client.acks.map((ack) => ack.callbackId)).toContain('cb-5');

      const despues = await database.dataSource.getRepository(Movement).find();
      expect(despues.filter((row) => row.kind === 'expense')).toHaveLength(2);
      const revisiones = await database.dataSource.getRepository(MovementRevision).find();
      expect(revisiones).toHaveLength(1);
      const financial = new FinancialService(database.transactions);
      const balances = await financial.balances('2026-11-30');
      expect(balances.find((row) => row.accountId === ves.id)?.balance).toBe(0n);
      expect(balances.find((row) => row.accountId === usdt.id)?.balance).toBe(-2000000n);
    } finally {
      avisos.mockRestore();
      await database.dataSource.query(`DROP TRIGGER IF EXISTS fallo_cierre`);
    }
  });
});
