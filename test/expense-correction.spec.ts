import { EntityManager } from 'typeorm';
import { Account } from '../src/accounts/account.entity';
import { ConflictError, NotFoundError, ValidationError } from '../src/domain/errors';
import { ExpenseCorrectionInput, FinancialService } from '../src/financial/financial.service';
import { FakeEntityManager, fakeTransactions } from './helpers/fake-entity-manager';

describe('FinancialService: correccion de un gasto confirmado', () => {
  let manager: FakeEntityManager;
  let service: FinancialService;
  let ves: Account;
  let usdt: Account;

  beforeEach(() => {
    manager = new FakeEntityManager();
    service = new FinancialService(fakeTransactions(manager));
    ves = manager.insert<Account>('account', { name: 'Bolivares', currency: 'VES', active: true });
    usdt = manager.insert<Account>('account', { name: 'Binance', currency: 'USDT', active: true });
  });

  async function gasto(account: Account = ves, currency: 'VES' | 'USDT' = 'VES', minor = 350000n) {
    const registered = await service.register({
      sourceKey: `gasto:${account.id}`,
      accountId: account.id,
      kind: 'expense',
      money: { currency, minor },
      occurredOn: '2026-11-02',
      description: 'Cena',
    });
    return registered.movement;
  }

  function correction(movementId: string, overrides: Partial<ExpenseCorrectionInput> = {}): ExpenseCorrectionInput {
    return {
      sourceKey: 'correccion:1',
      movementId,
      amountMinor: 400000n,
      accountId: ves.id,
      currency: 'VES',
      ...overrides,
    };
  }

  it('la vista previa describe la correccion y no escribe nada', async () => {
    const movement = await gasto();
    const preview = await service.previewExpenseCorrection(correction(movement.id));
    expect(preview).toMatchObject({
      movementId: movement.id,
      mode: 'edit',
      current: { accountId: ves.id, currency: 'VES', amountMinor: 350000n, occurredOn: '2026-11-02', description: 'Cena' },
      target: { accountId: ves.id, currency: 'VES', amountMinor: 400000n, occurredOn: '2026-11-02', description: 'Cena' },
      replacementSourceKey: null,
    });
    expect(manager.rows('movement')).toHaveLength(1);
    expect(manager.rows('movement_revision')).toHaveLength(0);
  });

  it('mismo medio: edita el gasto con una revision auditada y no reescribe el original', async () => {
    const movement = await gasto();
    const result = await service.correctExpense(correction(movement.id));
    expect(result).toMatchObject({ movementId: movement.id, mode: 'edit', created: true });
    const history = await service.movementHistory(movement.id);
    expect(history.effective).toMatchObject({
      amountMinor: 400000n,
      occurredOn: '2026-11-02',
      description: 'Cena',
      revision: 1,
      voided: false,
    });
    expect(history.revisions).toHaveLength(1);
    expect(history.revisions[0]).toMatchObject({ kind: 'edit', expectedRevision: 0, amountMinor: 400000n });
    expect(history.original.amountMinor).toBe(350000n);
    expect(manager.rows('movement')[0]).toMatchObject({ amountMinor: 350000n });
    expect((await service.summary('2026-11')).find((row) => row.currency === 'VES')?.expense).toBe(400000n);
  });

  it('repetir la clave no duplica: mismo medio y cambio de medio devuelven el resultado original', async () => {
    const movement = await gasto();
    const first = await service.correctExpense(correction(movement.id));
    const replay = await service.correctExpense(correction(movement.id));
    expect(replay).toMatchObject({ movementId: first.movementId, mode: 'edit', created: false });
    expect(manager.rows('movement_revision')).toHaveLength(1);
    await expect(service.correctExpense(correction(movement.id, { amountMinor: 500000n }))).rejects.toThrow(ConflictError);

    const otro = await gasto(usdt, 'USDT', 12000000n);
    const cambio = {
      sourceKey: 'correccion:2',
      movementId: otro.id,
      amountMinor: 12500000n,
      accountId: ves.id,
      currency: 'VES' as const,
    };
    const replaced = await service.correctExpense(cambio);
    expect(replaced.mode).toBe('replace');
    const repeated = await service.correctExpense(cambio);
    expect(repeated).toMatchObject({ movementId: replaced.movementId, mode: 'replace', created: false });
    expect(manager.rows('movement')).toHaveLength(3);
    expect(manager.rows('movement_revision')).toHaveLength(2);
    await expect(service.correctExpense({ ...cambio, amountMinor: 13000000n })).rejects.toThrow(ConflictError);
  });

  it('otro medio: anula el original y registra el gasto nuevo con su fecha y descripcion', async () => {
    const movement = await gasto();
    const result = await service.correctExpense(correction(movement.id, {
      sourceKey: 'correccion:3',
      amountMinor: 12500000n,
      accountId: usdt.id,
      currency: 'USDT',
    }));
    expect(result).toMatchObject({ mode: 'replace', created: true });
    expect(result.movementId).not.toBe(movement.id);

    const original = await service.movementHistory(movement.id);
    expect(original.effective).toMatchObject({ voided: true, revision: 1 });
    expect(original.revisions.map((row) => row.kind)).toEqual(['void']);

    const nuevo = await service.movementHistory(result.movementId);
    expect(nuevo.original).toMatchObject({
      accountId: usdt.id,
      kind: 'expense',
      currency: 'USDT',
      amountMinor: 12500000n,
      occurredOn: '2026-11-02',
      description: 'Cena',
    });
    expect(nuevo.revisions).toHaveLength(0);

    const resumen = await service.summary('2026-11');
    expect(resumen.find((row) => row.currency === 'VES')?.expense).toBe(0n);
    expect(resumen.find((row) => row.currency === 'USDT')?.expense).toBe(12500000n);
    const saldos = await service.balances('2026-11-30');
    expect(saldos.find((row) => row.accountId === ves.id)?.balance).toBe(0n);
    expect(saldos.find((row) => row.accountId === usdt.id)?.balance).toBe(-12500000n);
  });

  it('un gasto ya revisado o anulado no se corrige otra vez', async () => {
    const movement = await gasto();
    await service.correctExpense(correction(movement.id));
    await expect(service.correctExpense(correction(movement.id, { sourceKey: 'correccion:4' }))).rejects.toThrow(ConflictError);

    const anulado = await gasto(usdt, 'USDT', 1000n);
    await service.voidMovement({ sourceKey: 'anulacion:1', movementId: anulado.id, expectedRevision: 0, reason: 'Duplicado' });
    await expect(service.correctExpense(correction(anulado.id, {
      sourceKey: 'correccion:5',
      accountId: usdt.id,
      currency: 'USDT',
    }))).rejects.toThrow(ConflictError);
  });

  it('si el registro falla, la anulacion se revierte: no queda exito parcial', async () => {
    const movement = await gasto();
    manager.failSave('movement', new Error('injected failure'));
    await expect(service.correctExpense(correction(movement.id, {
      sourceKey: 'correccion:6',
      amountMinor: 12500000n,
      accountId: usdt.id,
      currency: 'USDT',
    }), manager as unknown as EntityManager)).rejects.toThrow('injected failure');
    expect(manager.rows('movement_revision')).toHaveLength(0);
    expect(manager.rows('movement')).toHaveLength(1);
    expect((await service.movementHistory(movement.id)).effective).toMatchObject({ voided: false, revision: 0 });

    manager.failSave('movement', new Error('injected failure'));
    await expect(service.correctExpense(correction(movement.id, {
      sourceKey: 'correccion:7',
      amountMinor: 12500000n,
      accountId: usdt.id,
      currency: 'USDT',
    }))).rejects.toThrow('injected failure');
    expect(manager.rows('movement_revision')).toHaveLength(0);
    expect(manager.rows('movement')).toHaveLength(1);
  });

  it('valida importe, cuenta, medio y tipo de gasto antes de escribir', async () => {
    const movement = await gasto();
    for (const overrides of [
      { amountMinor: 0n },
      { amountMinor: -1n },
      { amountMinor: 10 as unknown as bigint },
      { currency: 'XXX' as unknown as 'VES' },
      { accountId: '   ' },
      { sourceKey: ' ' },
      { occurredOn: '2026-02-30' },
      { reason: '  ' },
    ]) {
      await expect(service.correctExpense(correction(movement.id, overrides))).rejects.toThrow(ValidationError);
    }
    await expect(service.correctExpense(correction('missing'))).rejects.toThrow(NotFoundError);

    manager.insert('account', { name: 'Inactiva', currency: 'USD', active: false });
    const inactiva = manager.rows('account').find((row) => row.name === 'Inactiva')!;
    await expect(service.correctExpense(correction(movement.id, {
      accountId: inactiva.id as string,
      currency: 'USD',
    }))).rejects.toThrow(ValidationError);
    await expect(service.correctExpense(correction(movement.id, {
      accountId: usdt.id,
      currency: 'VES',
      amountMinor: 1n,
    }))).rejects.toThrow(/operar en/);

    const ingreso = await service.register({
      sourceKey: 'ingreso:1',
      accountId: ves.id,
      kind: 'income',
      money: { currency: 'VES', minor: 1000n },
      occurredOn: '2026-11-02',
    });
    await expect(service.correctExpense(correction(ingreso.movement.id))).rejects.toThrow(ValidationError);
    expect(manager.rows('movement_revision')).toHaveLength(0);
  });

  it('un pago de deuda y una comision no se corrigen como gasto ordinario', async () => {
    const deuda = await gasto();
    manager.insert('debt_payment', { sourceKey: 'pago:1', debtId: 'deuda:1', movementId: deuda.id, expectedOutstandingMinor: 1000n });
    await expect(service.correctExpense(correction(deuda.id))).rejects.toThrow(ConflictError);

    const comision = await gasto(usdt, 'USDT', 500n);
    manager.insert('ledger_operation', {
      sourceKey: 'transferencia:1',
      kind: 'transfer',
      accountId: usdt.id,
      currency: 'USDT',
      deltaMinor: -1000n,
      destinationAccountId: ves.id,
      destinationCurrency: 'VES',
      destinationDeltaMinor: 1000n,
      feeMovementId: comision.id,
      occurredOn: '2026-11-02',
      description: null,
    });
    await expect(service.correctExpense(correction(comision.id, {
      accountId: usdt.id,
      currency: 'USDT',
    }))).rejects.toThrow(ConflictError);
    expect(manager.rows('movement_revision')).toHaveLength(0);
  });
});
