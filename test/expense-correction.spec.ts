import { createHash } from 'node:crypto';
import { Account } from '../src/accounts/account.entity';
import { AccountService } from '../src/accounts/account.service';
import { DebtService } from '../src/debts/debt.service';
import { ConflictError, NotFoundError, ValidationError } from '../src/domain/errors';
import { ExpenseCorrectionInput, FinancialService } from '../src/financial/financial.service';
import { Movement } from '../src/financial/movement.entity';
import { MovementRevision } from '../src/financial/movement-revision.entity';
import { createTempDatabase, TempDatabase } from './helpers/temp-database';

/** Espejo de la derivacion de claves del servicio: prefijo propio y hash acotado. */
function claves(sourceKey: string): { revision: string; replacement: string } {
  const digest = createHash('sha256').update(sourceKey).digest('hex').slice(0, 32);
  return { revision: `correccion:rev:${digest}`, replacement: `correccion:mov:${digest}` };
}

describe('FinancialService: correccion de un gasto confirmado', () => {
  let db: TempDatabase;
  let service: FinancialService;
  let debts: DebtService;
  let ves: Account;
  let usdt: Account;
  let secuencia = 0;

  beforeEach(async () => {
    db = await createTempDatabase();
    service = new FinancialService(db.transactions);
    debts = new DebtService(db.transactions, service);
    const accounts = new AccountService(db.dataSource, db.transactions);
    ves = await accounts.add({ name: 'Bolivares', currency: 'VES' });
    usdt = await accounts.add({ name: 'Binance', currency: 'USDT' });
    secuencia = 0;
  });

  afterEach(async () => { await db.cleanup(); });

  async function gasto(account: Account = ves, currency: 'VES' | 'USDT' = 'VES', minor = 350000n, description: string | undefined = 'Cena') {
    secuencia += 1;
    const registered = await service.register({
      sourceKey: `gasto:${secuencia}`,
      accountId: account.id,
      kind: 'expense',
      money: { currency, minor },
      occurredOn: '2026-11-02',
      ...(description === undefined ? {} : { description }),
    });
    return registered.movement;
  }

  function corregir(movementId: string, overrides: Partial<ExpenseCorrectionInput> = {}): ExpenseCorrectionInput {
    return {
      sourceKey: 'correccion:1',
      movementId,
      amountMinor: 400000n,
      accountId: ves.id,
      currency: 'VES',
      ...overrides,
    };
  }

  it('las claves de la correccion son propias y no comparten espacio con la CLI', async () => {
    const movement = await gasto();
    await service.correctExpense(corregir(movement.id));
    const revision = await db.dataSource.getRepository(MovementRevision).findOneBy({ movementId: movement.id });
    expect(revision?.sourceKey).toBe(claves('correccion:1').revision);
    expect(revision?.sourceKey).not.toBe('correccion:1');
  });

  it('un reemplazo huerfano bloquea la edicion antes de aplicar y en la vista previa', async () => {
    const movement = await gasto();
    const repository = db.dataSource.getRepository(Movement);
    await repository.save(repository.create({
      sourceKey: claves('correccion:1').replacement,
      accountId: ves.id,
      kind: 'expense',
      amountMinor: 999n,
      currency: 'VES',
      occurredOn: '2026-11-02',
      description: null,
    }));
    await expect(service.correctExpense(corregir(movement.id))).rejects.toThrow(ConflictError);
    await expect(service.previewExpenseCorrection(corregir(movement.id))).rejects.toThrow(ConflictError);
    expect(await db.dataSource.getRepository(MovementRevision).count()).toBe(0);
  });

  it('un reemplazo huerfano invalida el replay de una edicion ya aplicada', async () => {
    const movement = await gasto();
    await service.correctExpense(corregir(movement.id));
    const repository = db.dataSource.getRepository(Movement);
    await repository.save(repository.create({
      sourceKey: claves('correccion:1').replacement,
      accountId: ves.id,
      kind: 'expense',
      amountMinor: 999n,
      currency: 'VES',
      occurredOn: '2026-11-02',
      description: null,
    }));
    await expect(service.correctExpense(corregir(movement.id))).rejects.toThrow(ConflictError);
    expect(await db.dataSource.getRepository(MovementRevision).count()).toBe(1);
  });

  it('una edicion de la CLI con la clave derivada sobre una comision no es un replay', async () => {
    const operation = (await service.transfer({
      sourceKey: 'transferencia:1',
      from: { accountId: ves.id, money: { currency: 'VES', minor: 500000n } },
      to: { accountId: usdt.id, money: { currency: 'USDT', minor: 12500000n } },
      fee: { accountId: ves.id, money: { currency: 'VES', minor: 100n } },
      occurredOn: '2026-11-02',
    })).operation;
    await service.editMovement({
      sourceKey: claves('correccion:1').revision,
      movementId: operation.feeMovementId!,
      expectedRevision: 0,
      amountMinor: 200n,
      occurredOn: '2026-11-02',
      reason: 'Correccion de gasto',
      description: undefined,
      category: undefined,
    });
    await expect(service.correctExpense(corregir(operation.feeMovementId!, {
      amountMinor: 200n,
    }))).rejects.toThrow(ConflictError);
    expect(await db.dataSource.getRepository(MovementRevision).count()).toBe(1);
  });

  it('una clave ocupada con otro movimiento da conflicto antes de cargar el objetivo', async () => {
    const movement = await gasto();
    await service.correctExpense(corregir(movement.id));
    await expect(service.correctExpense(corregir('no-existe', { sourceKey: 'correccion:1' }))).rejects.toThrow(ConflictError);
    await expect(service.previewExpenseCorrection(corregir('no-existe', { sourceKey: 'correccion:1' }))).rejects.toThrow(ConflictError);
    await expect(service.correctExpense(corregir('no-existe', { sourceKey: 'correccion:libre' }))).rejects.toThrow(NotFoundError);
  });

  it('con los dos artefactos plantados no se escribe nada', async () => {
    const movement = await gasto();
    const clavesDerivadas = claves('correccion:1');
    const revisiones = db.dataSource.getRepository(MovementRevision);
    await revisiones.save(revisiones.create({
      sourceKey: clavesDerivadas.revision,
      movementId: movement.id,
      revision: 1,
      expectedRevision: 0,
      kind: 'void',
      reason: 'Correccion de gasto',
      amountMinor: null,
      occurredOn: null,
      description: null,
      category: null,
    }));
    const repository = db.dataSource.getRepository(Movement);
    const plantado = await repository.save(repository.create({
      sourceKey: clavesDerivadas.replacement,
      accountId: usdt.id,
      kind: 'expense',
      amountMinor: 12500000n,
      currency: 'USDT',
      occurredOn: '2026-11-02',
      description: 'Cena',
    }));
    const result = await service.correctExpense(corregir(movement.id, {
      amountMinor: 12500000n,
      accountId: usdt.id,
      currency: 'USDT',
    }));
    expect(result).toMatchObject({ movementId: plantado.id, mode: 'replace', created: false });
    expect(await db.dataSource.getRepository(MovementRevision).count()).toBe(1);
    expect(await db.dataSource.getRepository(Movement).count()).toBe(2);
  });

  it('la vista previa describe la correccion y no escribe nada', async () => {
    const movement = await gasto();
    const preview = await service.previewExpenseCorrection(corregir(movement.id));
    expect(preview).toMatchObject({
      movementId: movement.id,
      mode: 'edit',
      current: { accountId: ves.id, currency: 'VES', amountMinor: 350000n, occurredOn: '2026-11-02', description: 'Cena' },
      target: { accountId: ves.id, currency: 'VES', amountMinor: 400000n, occurredOn: '2026-11-02', description: 'Cena' },
    });
    expect(preview).not.toHaveProperty('replacementSourceKey');
    expect(await db.dataSource.getRepository(MovementRevision).count()).toBe(0);
    expect(await db.dataSource.getRepository(Movement).count()).toBe(1);
  });

  it('la vista previa comparte el preflight: origen inactivo y clave ocupada la rechazan', async () => {
    const movement = await gasto();
    await db.dataSource.getRepository(Account).update(ves.id, { active: false });
    await expect(service.previewExpenseCorrection(corregir(movement.id))).rejects.toThrow(ValidationError);
    await db.dataSource.getRepository(Account).update(ves.id, { active: true });

    // Otra correccion con la misma clave deja ocupadas las claves de esta.
    const otro = await gasto(ves, 'VES', 500000n);
    await service.correctExpense(corregir(otro.id));
    await expect(service.previewExpenseCorrection(corregir(movement.id))).rejects.toThrow(ConflictError);
    expect(await db.dataSource.getRepository(MovementRevision).count()).toBe(1);
  });

  it('mismo medio: edita el gasto con una revision auditada y no reescribe el original', async () => {
    const movement = await gasto();
    const result = await service.correctExpense(corregir(movement.id));
    expect(result).toMatchObject({ movementId: movement.id, mode: 'edit', created: true });
    const history = await service.movementHistory(movement.id);
    expect(history.effective).toMatchObject({
      amountMinor: 400000n,
      occurredOn: '2026-11-02',
      description: 'Cena',
      category: null,
      revision: 1,
      voided: false,
    });
    expect(history.revisions).toHaveLength(1);
    expect(history.revisions[0]).toMatchObject({ kind: 'edit', expectedRevision: 0, amountMinor: 400000n });
    expect(history.original.amountMinor).toBe(350000n);
    expect((await service.summary('2026-11')).find((row) => row.currency === 'VES')?.expense).toBe(400000n);
    expect((await service.balances('2026-11-30')).find((row) => row.accountId === ves.id)?.balance).toBe(-400000n);
  });

  it('otro medio: anula el original y registra el gasto nuevo con su fecha y descripcion', async () => {
    const movement = await gasto();
    const result = await service.correctExpense(corregir(movement.id, {
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

  it('repetir la clave no duplica: mismo medio y cambio de medio devuelven el resultado original', async () => {
    const movement = await gasto();
    const first = await service.correctExpense(corregir(movement.id));
    const replay = await service.correctExpense(corregir(movement.id));
    expect(replay).toMatchObject({ movementId: first.movementId, mode: 'edit', created: false });
    expect(await db.dataSource.getRepository(MovementRevision).count()).toBe(1);
    await expect(service.correctExpense(corregir(movement.id, { amountMinor: 500000n }))).rejects.toThrow(ConflictError);

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
    expect(await db.dataSource.getRepository(Movement).count()).toBe(3);
    expect(await db.dataSource.getRepository(MovementRevision).count()).toBe(2);
    await expect(service.correctExpense({ ...cambio, amountMinor: 13000000n })).rejects.toThrow(ConflictError);
    await expect(service.correctExpense({ ...cambio, accountId: usdt.id, currency: 'USDT' })).rejects.toThrow(ConflictError);
  });

  it('un cambio de modo, objetivo o payload con la misma clave no escribe', async () => {
    const a = await gasto(ves, 'VES', 350000n);
    const b = await gasto(ves, 'VES', 500000n);
    await service.correctExpense(corregir(a.id));

    // Misma clave, otro gasto y otro modo: la correccion ya esta ocupada.
    await expect(service.correctExpense(corregir(b.id, {
      amountMinor: 600000n,
      accountId: usdt.id,
      currency: 'USDT',
    }))).rejects.toThrow(ConflictError);
    expect((await service.movementHistory(b.id)).effective).toMatchObject({ revision: 0, voided: false, amountMinor: 500000n });
    expect(await db.dataSource.getRepository(MovementRevision).count()).toBe(1);
    expect(await db.dataSource.getRepository(Movement).count()).toBe(2);

    // Misma clave, mismo gasto, otro modo.
    await expect(service.correctExpense(corregir(a.id, {
      accountId: usdt.id,
      currency: 'USDT',
    }))).rejects.toThrow(ConflictError);
    expect(await db.dataSource.getRepository(MovementRevision).count()).toBe(1);
    expect(await db.dataSource.getRepository(Movement).count()).toBe(2);

    // A la inversa: una correccion con cambio de medio tampoco cede a una edicion.
    const c = await gasto(ves, 'VES', 700000n);
    const d = await gasto(ves, 'VES', 800000n);
    await service.correctExpense(corregir(c.id, {
      sourceKey: 'correccion:2',
      amountMinor: 900000n,
      accountId: usdt.id,
      currency: 'USDT',
    }));
    await expect(service.correctExpense(corregir(d.id, { sourceKey: 'correccion:2' }))).rejects.toThrow(ConflictError);
    expect((await service.movementHistory(d.id)).effective).toMatchObject({ revision: 0, voided: false, amountMinor: 800000n });
    expect(await db.dataSource.getRepository(MovementRevision).count()).toBe(2);
  });

  it('una edicion de la CLI con la misma clave no se toma por replay de la correccion', async () => {
    const movement = await gasto();
    await service.editMovement({
      sourceKey: 'correccion:1',
      movementId: movement.id,
      expectedRevision: 0,
      amountMinor: 400000n,
      occurredOn: '2026-11-02',
      reason: 'Correccion de gasto',
      description: 'Cena',
      category: undefined,
    });
    await expect(service.correctExpense(corregir(movement.id))).rejects.toThrow(ConflictError);
    expect(await db.dataSource.getRepository(MovementRevision).count()).toBe(1);
  });

  it('la edicion de la CLI sobre una comision tampoco es un replay de la correccion', async () => {
    const operation = (await service.transfer({
      sourceKey: 'transferencia:1',
      from: { accountId: ves.id, money: { currency: 'VES', minor: 500000n } },
      to: { accountId: usdt.id, money: { currency: 'USDT', minor: 12500000n } },
      fee: { accountId: ves.id, money: { currency: 'VES', minor: 100n } },
      occurredOn: '2026-11-02',
    })).operation;
    await service.editMovement({
      sourceKey: 'correccion:1',
      movementId: operation.feeMovementId!,
      expectedRevision: 0,
      amountMinor: 200n,
      occurredOn: '2026-11-02',
      reason: 'Correccion de gasto',
      description: undefined,
      category: undefined,
    });
    await expect(service.correctExpense(corregir(operation.feeMovementId!, {
      amountMinor: 200n,
    }))).rejects.toThrow(ConflictError);
    expect(await db.dataSource.getRepository(MovementRevision).count()).toBe(1);
  });

  it('un replay exacto sigue funcionando tras otras revisiones y con la cuenta desactivada', async () => {
    const movement = await gasto();
    const first = await service.correctExpense(corregir(movement.id));
    await service.editMovement({
      sourceKey: 'cli:2',
      movementId: movement.id,
      expectedRevision: 1,
      amountMinor: 500000n,
      occurredOn: '2026-11-03',
      reason: 'Ajuste posterior',
    });
    await db.dataSource.getRepository(Account).update(ves.id, { active: false });
    const replay = await service.correctExpense(corregir(movement.id));
    expect(replay).toMatchObject({ movementId: first.movementId, mode: 'edit', created: false });
    expect(await db.dataSource.getRepository(MovementRevision).count()).toBe(2);
  });

  it('un gasto ya revisado o anulado no se corrige otra vez', async () => {
    const movement = await gasto();
    await service.correctExpense(corregir(movement.id));
    await expect(service.correctExpense(corregir(movement.id, { sourceKey: 'correccion:2' }))).rejects.toThrow(ConflictError);

    const anulado = await gasto(usdt, 'USDT', 1000n);
    await service.voidMovement({ sourceKey: 'anulacion:1', movementId: anulado.id, expectedRevision: 0, reason: 'Duplicado' });
    await expect(service.correctExpense(corregir(anulado.id, {
      sourceKey: 'correccion:3',
      accountId: usdt.id,
      currency: 'USDT',
    }))).rejects.toThrow(ConflictError);
  });

  it('el fallo del registro no deja exito parcial dentro de una transaccion exterior', async () => {
    const movement = await gasto();
    await db.dataSource.query(
      "CREATE TRIGGER injected BEFORE INSERT ON movement WHEN NEW.sourceKey LIKE 'correccion:mov:%' BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    try {
      await db.transactions.run(async (manager) => {
        await expect(service.correctExpense(corregir(movement.id, {
          amountMinor: 12500000n,
          accountId: usdt.id,
          currency: 'USDT',
        }), manager)).rejects.toThrow('injected failure');
        // La transaccion exterior sigue viva: otra escritura si se confirma.
        await service.register({
          sourceKey: 'posterior',
          accountId: usdt.id,
          kind: 'expense',
          money: { currency: 'USDT', minor: 10n },
          occurredOn: '2026-11-05',
        }, manager);
      });
    } finally {
      await db.dataSource.query('DROP TRIGGER injected');
    }
    expect(await db.dataSource.getRepository(MovementRevision).count()).toBe(0);
    expect(await db.dataSource.getRepository(Movement).count()).toBe(2);
    expect((await service.movementHistory(movement.id)).effective).toMatchObject({
      voided: false,
      revision: 0,
      amountMinor: 350000n,
    });
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
    ]) {
      await expect(service.correctExpense(corregir(movement.id, overrides))).rejects.toThrow(ValidationError);
    }
    await expect(service.correctExpense(corregir('missing'))).rejects.toThrow(NotFoundError);

    await db.dataSource.getRepository(Account).update(usdt.id, { active: false });
    await expect(service.correctExpense(corregir(movement.id, {
      accountId: usdt.id,
      currency: 'USDT',
    }))).rejects.toThrow(ValidationError);
    await db.dataSource.getRepository(Account).update(usdt.id, { active: true });
    await expect(service.correctExpense(corregir(movement.id, {
      accountId: usdt.id,
      currency: 'VES',
    }))).rejects.toThrow(/operar en/);

    const ingreso = (await service.register({
      sourceKey: 'ingreso:1',
      accountId: ves.id,
      kind: 'income',
      money: { currency: 'VES', minor: 1000n },
      occurredOn: '2026-11-02',
    })).movement;
    await expect(service.correctExpense(corregir(ingreso.id))).rejects.toThrow(ValidationError);
    expect(await db.dataSource.getRepository(MovementRevision).count()).toBe(0);
  });

  it('un pago de deuda y una comision no se corrigen como gasto ordinario', async () => {
    const deuda = (await debts.create({
      sourceKey: 'deuda:1',
      direction: 'payable',
      counterparty: 'Carmen',
      money: { currency: 'VES', minor: 500000n },
      occurredOn: '2026-10-01',
    })).debt;
    const pago = await debts.settle({
      sourceKey: 'pago:1',
      debtId: deuda.id,
      accountId: ves.id,
      money: { currency: 'VES', minor: 500000n },
      occurredOn: '2026-11-02',
      expectedOutstandingMinor: 500000n,
    });
    await expect(service.correctExpense(corregir(pago.movement.id))).rejects.toThrow(ConflictError);

    const operation = (await service.transfer({
      sourceKey: 'transferencia:1',
      from: { accountId: ves.id, money: { currency: 'VES', minor: 500000n } },
      to: { accountId: usdt.id, money: { currency: 'USDT', minor: 12500000n } },
      fee: { accountId: ves.id, money: { currency: 'VES', minor: 100n } },
      occurredOn: '2026-11-02',
    })).operation;
    await expect(service.correctExpense(corregir(operation.feeMovementId!, {
      amountMinor: 200n,
    }))).rejects.toThrow(ConflictError);
    expect(await db.dataSource.getRepository(MovementRevision).count()).toBe(0);
  });
});
