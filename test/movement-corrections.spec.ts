import { Account } from '../src/accounts/account.entity';
import { AccountService } from '../src/accounts/account.service';
import { ConflictError, NotFoundError, ValidationError } from '../src/domain/errors';
import { EditMovementInput, FinancialService, RegisterInput } from '../src/financial/financial.service';
import { MovementRevision } from '../src/financial/movement-revision.entity';
import { BalanceReconciliation } from '../src/financial/balance-reconciliation.entity';
import { createTempDatabase, TempDatabase } from './helpers/temp-database';

describe('FinancialService B2: correcciones y conciliaciones', () => {
  let db: TempDatabase;
  let service: FinancialService;
  let account: Account;
  let movementId: string;
  let originalInput: RegisterInput;

  beforeEach(async () => {
    db = await createTempDatabase();
    service = new FinancialService(db.transactions);
    account = await new AccountService(db.dataSource, db.transactions).add({ name: 'Efectivo', currency: 'USD' });
    originalInput = { sourceKey: 'original', accountId: account.id, kind: 'expense', money: { currency: 'USD', minor: 100n }, occurredOn: '2026-10-10', description: 'Original' };
    movementId = (await service.register(originalInput)).movement.id;
  });

  afterEach(async () => { await db.cleanup(); });

  function edit(overrides: Partial<EditMovementInput> = {}): EditMovementInput {
    return { sourceKey: 'edit:1', movementId, expectedRevision: 0, amountMinor: 250n, occurredOn: '2026-11-11', reason: 'Importe y fecha correctos', description: ' Nuevo ', category: ' Comida ', ...overrides };
  }

  async function balance(on = '2026-11-30') {
    return (await service.balances(on)).find((row) => row.accountId === account.id)!.balance;
  }

  it('original inmutable y replay original; proyeccion antes de filtrar fecha, mes, orden y limite', async () => {
    const before = await db.dataSource.query('SELECT * FROM movement');
    await service.register({ ...originalInput, sourceKey: 'second', occurredOn: '2026-11-01', money: { currency: 'USD', minor: 20n } });
    await service.editMovement(edit());
    expect((await service.recent(1))[0]).toMatchObject({ id: movementId, amountMinor: 250n, occurredOn: '2026-11-11', category: 'Comida', revision: 1, sourceKey: 'original', accountId: account.id, currency: 'USD', kind: 'expense' });
    expect((await service.summary('2026-10')).find((row) => row.currency === 'USD')?.expense).toBe(0n);
    expect((await service.summary('2026-11')).find((row) => row.currency === 'USD')?.expense).toBe(270n);
    expect(await balance('2026-11-10')).toBe(-20n);
    expect(await balance('2026-11-11')).toBe(-270n);
    expect(await service.register(originalInput)).toMatchObject({ created: false, movement: { id: movementId, amountMinor: 100n, occurredOn: '2026-10-10' } });
    expect(await db.dataSource.query('SELECT * FROM movement WHERE id = ?', [movementId])).toEqual(before);
    await service.editMovement(edit({ sourceKey: 'earlier', expectedRevision: 1, occurredOn: '2026-09-01', description: undefined, category: undefined }));
    expect((await service.recent(1))[0]?.sourceKey).toBe('second');
    expect((await service.summary('2026-09')).find((row) => row.currency === 'USD')?.expense).toBe(250n);
    expect((await service.movementHistory(movementId)).effective).toMatchObject({ category: null, description: null, revision: 2 });
    expect(await balance('2026-09-01')).toBe(-250n);
  });

  it('replay antes de estado actual/cuenta, conflicto de payload, anulacion terminal e historial ordenado', async () => {
    const input = edit();
    const first = await service.editMovement(input);
    await service.editMovement(edit({ sourceKey: 'edit:2', expectedRevision: 1, category: 'comida' }));
    const voidInput = { sourceKey: 'void:1', movementId, expectedRevision: 2, reason: 'Duplicado' };
    await service.voidMovement(voidInput);
    await db.dataSource.getRepository(Account).update(account.id, { active: false });
    expect(await service.editMovement({ ...input, category: 'Comida', description: 'Nuevo' })).toMatchObject({ created: false, revision: { id: first.revision.id } });
    expect((await service.voidMovement(voidInput)).created).toBe(false);
    expect((await service.register(originalInput)).created).toBe(false);
    await expect(service.editMovement({ ...input, reason: 'Otro' })).rejects.toThrow(ConflictError);
    await expect(service.editMovement(edit({ sourceKey: 'new', expectedRevision: 3 }))).rejects.toThrow(/terminal/);
    await expect(service.voidMovement({ ...voidInput, sourceKey: 'new', expectedRevision: 3 })).rejects.toThrow(/terminal/);
    const history = await service.movementHistory(movementId);
    expect(history.revisions.map((row) => [row.revision, row.kind, row.category])).toEqual([[1, 'edit', 'Comida'], [2, 'edit', 'comida'], [3, 'void', null]]);
    expect(history.revisions[2]).toMatchObject({ amountMinor: null, occurredOn: null, description: null });
    expect(history.effective).toMatchObject({ voided: true, revision: 3, category: 'comida' });
    expect(await service.recent()).toEqual([]);
    expect(await balance()).toBe(0n);
    expect((await service.summary()).find((row) => row.currency === 'USD')?.expense).toBe(0n);
  });

  it('repeticiones concurrentes, claves conflictivas y revisiones obsoletas no duplican', async () => {
    const repeated = await Promise.all([service.editMovement(edit()), service.editMovement(edit())]);
    expect(repeated.map((row) => row.created)).toEqual([true, false]);
    const stale = await Promise.allSettled([
      service.editMovement(edit({ sourceKey: 'next:1', expectedRevision: 1 })),
      service.voidMovement({ sourceKey: 'next:2', movementId, expectedRevision: 1, reason: 'stale' }),
    ]);
    expect(stale.map((row) => row.status)).toEqual(['fulfilled', 'rejected']);
    expect(stale[1]?.status === 'rejected' && stale[1].reason).toBeInstanceOf(ConflictError);
    await expect(service.voidMovement({ sourceKey: 'edit:1', movementId, expectedRevision: 0, reason: 'Conflict' })).rejects.toThrow(ConflictError);
    expect(await db.dataSource.getRepository(MovementRevision).count()).toBe(2);
  });

  it('todos los campos del payload de revision participan en la idempotencia', async () => {
    await service.editMovement(edit());
    for (const change of [
      { movementId: 'missing' }, { expectedRevision: 1 }, { amountMinor: 251n },
      { occurredOn: '2026-11-12' }, { reason: 'Diferente' }, { description: undefined },
      { category: 'comida' }, { category: undefined },
    ]) await expect(service.editMovement(edit(change))).rejects.toThrow(ConflictError);
    expect(await db.dataSource.getRepository(MovementRevision).count()).toBe(1);
  });

  it('valida revision, razon, etiquetas, importe, fechas, cuenta y movimiento sin escribir', async () => {
    for (const override of [
      { expectedRevision: -1 }, { expectedRevision: 0.5 }, { expectedRevision: Number.MAX_SAFE_INTEGER },
      { reason: ' ' }, { reason: 'x'.repeat(281) }, { category: ' ' }, { category: 'x'.repeat(81) },
      { description: '' }, { amountMinor: 0n }, { amountMinor: -1n }, { occurredOn: '2026-02-30' },
    ]) await expect(service.editMovement(edit(override))).rejects.toThrow(ValidationError);
    await expect(service.editMovement(edit({ movementId: 'missing' }))).rejects.toThrow(NotFoundError);
    await expect(service.editMovement(edit({ expectedRevision: 1 }))).rejects.toThrow(ConflictError);
    await db.dataSource.getRepository(Account).update(account.id, { active: false });
    await expect(service.editMovement(edit())).rejects.toThrow(ValidationError);
    await expect(service.voidMovement({ sourceKey: 'v', movementId, expectedRevision: 0, reason: 'r' })).rejects.toThrow(ValidationError);
    expect(await db.dataSource.getRepository(MovementRevision).count()).toBe(0);
  });

  it('comision editable/anulable independiente; replay transferencia usa la comision ORIGINAL', async () => {
    const other = await new AccountService(db.dataSource, db.transactions).add({ name: 'Otra', currency: 'VES' });
    const input = { sourceKey: 'transfer', from: { accountId: account.id, money: { currency: 'USD' as const, minor: 500n } }, to: { accountId: other.id, money: { currency: 'VES' as const, minor: 200000n } }, fee: { accountId: account.id, money: { currency: 'USD' as const, minor: 10n } }, occurredOn: '2026-11-01' };
    const operation = (await service.transfer(input)).operation;
    const originals = await db.dataSource.query('SELECT * FROM movement ORDER BY id');
    await service.editMovement(edit({ movementId: operation.feeMovementId!, amountMinor: 50n }));
    expect((await service.movementHistory(operation.feeMovementId!)).feeOwner?.id).toBe(operation.id);
    expect((await service.transfer(input)).created).toBe(false);
    expect(await balance()).toBe(-650n);
    await service.voidMovement({ sourceKey: 'fee:void', movementId: operation.feeMovementId!, expectedRevision: 1, reason: 'Sin comision' });
    expect(await service.transfer(input)).toMatchObject({ created: false, operation: { id: operation.id } });
    expect(await balance()).toBe(-600n);
    expect(await db.dataSource.query('SELECT * FROM movement ORDER BY id')).toEqual(originals);
    const opening = await service.open({ sourceKey: 'opening', accountId: account.id, money: { currency: 'USD', minor: 0n }, occurredOn: '2026-11-01' });
    for (const id of [operation.id, opening.operation.id]) {
      await expect(service.editMovement(edit({ sourceKey: id, movementId: id }))).rejects.toThrow(/no esta soportado/);
      await expect(service.voidMovement({ sourceKey: id, movementId: id, expectedRevision: 0, reason: 'No' })).rejects.toThrow(/no esta soportado/);
    }
  });

  it('conciliacion inclusiva fija, cero auditado, replay sin recalculo y deriva retroactiva', async () => {
    const input = { sourceKey: 'reconcile', accountId: account.id, currency: 'USD' as const, targetMinor: -50n, occurredOn: '2026-10-10', reason: 'Conteo' };
    const first = await service.reconcile(input);
    expect(first.reconciliation).toMatchObject({ beforeMinor: -100n, deltaMinor: 50n, targetMinor: -50n });
    expect(await balance('2026-10-09')).toBe(0n);
    expect(await balance('2026-10-10')).toBe(-50n);
    const zero = await service.reconcile({ ...input, sourceKey: 'zero' });
    expect(zero.reconciliation.deltaMinor).toBe(0n);
    await service.register({ ...originalInput, sourceKey: 'backdated', occurredOn: '2026-10-01', money: { currency: 'USD', minor: 10n } });
    expect(await balance()).toBe(-60n);
    await db.dataSource.getRepository(Account).update(account.id, { active: false });
    expect(await service.reconcile(input)).toMatchObject({ created: false, reconciliation: { id: first.reconciliation.id, beforeMinor: -100n, deltaMinor: 50n } });
    await expect(service.reconcile({ ...input, reason: 'Cambio' })).rejects.toThrow(ConflictError);
    await expect(service.reconcile({ ...input, sourceKey: 'new' })).rejects.toThrow(ValidationError);
    expect((await service.summary('2026-10')).find((row) => row.currency === 'USD')?.expense).toBe(110n);
    expect((await service.reconciliations(account.id)).map((row) => row.sourceKey)).toEqual(['reconcile', 'zero']);
    await expect(service.reconciliations('missing')).rejects.toThrow(NotFoundError);
  });

  it.each(['USD', 'VES', 'USDT'] as const)('objetivos grandes, negativos y cero exactos %s; concurrencia', async (currency) => {
    const targetAccount = currency === 'USD' ? account : await new AccountService(db.dataSource, db.transactions).add({ name: currency, currency });
    const input = { sourceKey: 'large', accountId: targetAccount.id, currency, targetMinor: -9007199254740993123456n, occurredOn: '2026-11-01', reason: 'Conteo' };
    const results = await Promise.all([service.reconcile(input), service.reconcile(input)]);
    expect(results.map((row) => row.created)).toEqual([true, false]);
    expect((await service.balances('2026-11-01')).find((row) => row.accountId === targetAccount.id)?.balance).toBe(input.targetMinor);
    const positive = await service.reconcile({ ...input, sourceKey: 'positive', targetMinor: -input.targetMinor });
    expect(positive.reconciliation.deltaMinor).toBe(-input.targetMinor * 2n);
    await service.reconcile({ ...input, sourceKey: 'zero', targetMinor: 0n });
    expect((await service.balances('2026-11-01')).find((row) => row.accountId === targetAccount.id)?.balance).toBe(0n);
    const raw = await db.dataSource.query('SELECT targetMinor, typeof(targetMinor) AS type FROM balance_reconciliation WHERE sourceKey = ?', ['large']);
    expect(raw).toEqual([{ targetMinor: input.targetMinor.toString(), type: 'text' }]);
    await expect(service.reconcile({ ...input, sourceKey: 'wrong-currency', currency: currency === 'USD' ? 'VES' : 'USD' })).rejects.toThrow(ValidationError);
  });

  it('conciliaciones nuevas concurrentes se serializan; payload cambiado, razon y fecha se validan', async () => {
    const input = { sourceKey: 'rec:1', accountId: account.id, currency: 'USD' as const, targetMinor: 0n, occurredOn: '2026-10-10', reason: 'Conteo' };
    const results = await Promise.all([
      service.reconcile(input), service.reconcile({ ...input, sourceKey: 'rec:2', targetMinor: 10n }),
    ]);
    expect(results.map((row) => row.reconciliation.beforeMinor)).toEqual([-100n, 0n]);
    expect(results.map((row) => row.reconciliation.deltaMinor)).toEqual([100n, 10n]);
    expect(await balance('2026-10-10')).toBe(10n);
    for (const change of [{ accountId: 'missing' }, { currency: 'VES' as const }, { targetMinor: 1n }, { occurredOn: '2026-10-11' }, { reason: 'Otro' }]) {
      await expect(service.reconcile({ ...input, ...change })).rejects.toThrow(ConflictError);
    }
    await expect(service.reconcile({ ...input, sourceKey: 'missing', accountId: 'missing' })).rejects.toThrow(NotFoundError);
    for (const change of [{ reason: ' ' }, { reason: 'x'.repeat(281) }, { occurredOn: '2026-02-30' }, { sourceKey: ' ' }]) {
      await expect(service.reconcile({ ...input, ...change })).rejects.toThrow(ValidationError);
    }
    await service.reconcile({ ...input, sourceKey: 'later', occurredOn: '2026-10-11' });
    expect((await service.reconciliations()).map((row) => row.sourceKey)).toEqual(['later', 'rec:1', 'rec:2']);
  });

  it('composicion con manager sin colas anidadas, rollback del llamador y fallos de insercion', async () => {
    const rec = { sourceKey: 'rec', accountId: account.id, currency: 'USD' as const, targetMinor: 0n, occurredOn: '2026-11-11', reason: 'Conteo' };
    await expect(db.transactions.run(async (manager) => {
      await service.editMovement(edit(), manager);
      await service.reconcile(rec, manager);
      await service.voidMovement({ sourceKey: 'v', movementId, expectedRevision: 1, reason: 'Duplicado' }, manager);
      expect((await service.movementHistory(movementId, manager)).effective.voided).toBe(true);
      expect((await service.reconciliations(undefined, manager))).toHaveLength(1);
      throw new Error('rollback caller');
    })).rejects.toThrow('rollback caller');
    expect(await db.dataSource.getRepository(MovementRevision).count()).toBe(0);
    expect(await db.dataSource.getRepository(BalanceReconciliation).count()).toBe(0);
    for (const table of ['movement_revision', 'balance_reconciliation']) {
      await db.dataSource.query(`CREATE TRIGGER injected BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
      await expect(table === 'movement_revision' ? service.editMovement(edit()) : service.reconcile(rec)).rejects.toThrow('injected failure');
      await db.dataSource.query('DROP TRIGGER injected');
    }
    expect((await service.editMovement(edit())).created).toBe(true);
    expect((await service.reconcile(rec)).created).toBe(true);
  });
});
