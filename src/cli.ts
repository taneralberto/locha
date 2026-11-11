import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { config as loadEnvFile } from 'dotenv';
import { DataSource } from 'typeorm';
import { AccountService } from './accounts/account.service';
import { AppModule } from './app.module';
import { BudgetService } from './budgets/budget.service';
import { GoalService } from './savings/goal.service';
import { SavingsService } from './savings/savings.service';
import { formatGoalStatus, formatSavingsStatus } from './savings/savings-format';
import { resolveDatabasePath } from './config/configuration';
import { backupDatabase, restoreDatabase } from './data/backup';
import { monthPeriod, quincenaPeriod } from './domain/date';
import { CURRENCY_CODES, formatAmount, isCurrency, parseAmount, parseBudgetLimit, parseOpeningAmount } from './domain/money';
import { FinancialService, TransferLeg } from './financial/financial.service';
import { acquireInstanceLock, lockPathFor, releaseInstanceLock } from './lock/instance-lock';

const USAGE = `Uso: npm run cli -- <comando> [--opcion valor]

Comandos:
  account:add --name <nombre> --currency <${CURRENCY_CODES.join('|')}>   Crea una cuenta
  account:list                                                         Lista las cuentas
  balance:list [--on YYYY-MM-DD]                                       Saldos por cuenta
  movement:add --source-key <clave> --account <id> --currency <moneda> --kind <income|expense> --amount <importe> --on YYYY-MM-DD [--description <texto>]
  movement:edit --source-key <clave> --movement <id> --expected-revision <n> --amount <importe> --on YYYY-MM-DD --reason <texto> [--description <texto> --category <etiqueta>]
  movement:void --source-key <clave> --movement <id> --expected-revision <n> --reason <texto>
  movement:show|movement:history --movement <id>                         Original, revisiones y estado efectivo
  movement:recent [--limit <1..200>]                                    Movimientos efectivos
  summary [--month YYYY-MM]                                            Actividad efectiva
  balance:reconcile --source-key <clave> --account <id> --currency <moneda> --target <firmado> --on YYYY-MM-DD --reason <texto>
  reconciliation:list [--account <id>]                                 Conciliaciones auditadas
  budget:add --source-key <clave> --name <nombre> --currency <moneda> --limit <importe> [--category <etiqueta>] (--from YYYY-MM-DD --to YYYY-MM-DD | --month YYYY-MM [--half first|second])
  budget:list                                                         Definiciones inmutables
  budget:status [--budget <id>] [--on YYYY-MM-DD]                       Consumo efectivo (sin id: activos)
  goal:add --source-key <clave> --name <nombre> --currency <moneda> --target <importe> [--target-on YYYY-MM-DD]
  goal:list                                                          Metas inmutables
  goal:status [--goal <id>]                                           Progreso nominal actual
  savings:reserve|savings:release --source-key <clave> --goal <id> --account <id> --amount <importe>
  savings:status [--account <id>]                                     Saldo, reservado, disponible y deficit actuales
  savings:history [--account <id>] [--goal <id>]                        Historial virtual append-only
  opening:add --source-key <clave> --account <id> --currency <moneda> --amount <firmado> --on YYYY-MM-DD [--description <texto>]
  transfer:add --source-key <clave> --from <id> --from-currency <moneda> --sent <importe> --to <id> --to-currency <moneda> --received <importe> --on YYYY-MM-DD [--description <texto>] [--fee-account <id> --fee-currency <moneda> --fee <importe>]
  migration:run                                                        Aplica las migraciones pendientes
  backup --to <ruta>                                                   Copia de seguridad de la base
  restore --from <ruta> --to <ruta>                                    Restaura una copia en una ruta nueva`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { command, flags } = resolveCommand(args);

  // El archivo `.env` se carga aqui para conocer la ruta de la base antes de abrirla.
  loadEnvFile({ quiet: true });
  const databasePath = resolveDatabasePath(process.env);
  acquireInstanceLock({ path: lockPathFor(databasePath), label: 'locha-cli' });
  process.on('exit', () => releaseInstanceLock());

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    // Sin esto Nest aborta el proceso sin mostrar el error de configuracion.
    abortOnError: false,
  });

  try {
    switch (command) {
      case 'account:add': {
        const accounts = app.get(AccountService);
        const name = flags['name'];
        const currency = flags['currency'];
        if (!name || !currency) {
          throw new Error('Faltan las opciones --name y --currency.');
        }
        if (!isCurrency(currency)) {
          throw new Error(`Moneda no soportada "${currency}". Use ${CURRENCY_CODES.join(', ')}.`);
        }
        const account = await accounts.add({ name, currency });
        console.log(`Cuenta creada ${account.id} | ${account.name} | ${account.currency}`);
        break;
      }
      case 'account:list': {
        const accounts = await app.get(AccountService).list();
        if (accounts.length === 0) {
          console.log('No hay cuentas registradas.');
          break;
        }
        for (const account of accounts) {
          const state = account.active ? 'activa' : 'inactiva';
          console.log(`${account.id} | ${account.name} | ${account.currency} | ${state}`);
        }
        break;
      }
      case 'balance:list': {
        allowFlags(flags, ['on']);
        const rows = await app.get(FinancialService).balances(flags['on']);
        if (rows.length === 0) {
          console.log('No hay cuentas registradas.');
        }
        for (const row of rows) {
          console.log(`${row.accountId} | ${row.name} | ${row.currency} | ${formatAmount(row.balance, row.currency)} | apertura ${row.hasOpening ? 'si' : 'no'} | al ${row.asOf}`);
        }
        break;
      }
      case 'movement:add': {
        allowFlags(flags, ['source-key', 'account', 'currency', 'kind', 'amount', 'on', 'description']);
        const currency = requiredCurrency(flags, 'currency');
        const kind = requiredFlag(flags, 'kind');
        if (kind !== 'income' && kind !== 'expense') throw new Error('Use --kind income|expense.');
        const result = await app.get(FinancialService).register({
          sourceKey: requiredFlag(flags, 'source-key'), accountId: requiredFlag(flags, 'account'), kind,
          money: { currency, minor: parseAmount(requiredFlag(flags, 'amount'), currency) },
          occurredOn: requiredFlag(flags, 'on'), description: flags['description'],
        });
        console.log(`Movimiento ${result.movement.id} | ${result.created ? 'creado' : 'existente'}`);
        break;
      }
      case 'movement:edit':
      case 'movement:void': {
        allowFlags(flags, ['source-key', 'movement', 'expected-revision', 'reason', ...(command === 'movement:edit' ? ['amount', 'on', 'description', 'category'] : [])]);
        const financial = app.get(FinancialService);
        const input = {
          sourceKey: requiredFlag(flags, 'source-key'), movementId: requiredFlag(flags, 'movement'),
          expectedRevision: integerFlag(flags, 'expected-revision', 0, Number.MAX_SAFE_INTEGER - 1),
          reason: requiredFlag(flags, 'reason'),
        };
        const result = command === 'movement:void' ? await financial.voidMovement(input) : await financial.editMovement({
          ...input,
          amountMinor: parseAmount(requiredFlag(flags, 'amount'), (await financial.movementHistory(input.movementId)).original.currency),
          occurredOn: requiredFlag(flags, 'on'), description: flags['description'], category: flags['category'],
        });
        console.log(`Revision ${result.revision.id} | ${result.revision.kind} | ${result.revision.revision} | ${result.created ? 'creada' : 'existente'}`);
        break;
      }
      case 'movement:show':
      case 'movement:history': {
        allowFlags(flags, ['movement']);
        printJson(await app.get(FinancialService).movementHistory(requiredFlag(flags, 'movement')));
        break;
      }
      case 'movement:recent': {
        allowFlags(flags, ['limit']);
        printJson(await app.get(FinancialService).recent(flags['limit'] === undefined ? undefined : integerFlag(flags, 'limit', 1, 200)));
        break;
      }
      case 'summary': {
        allowFlags(flags, ['month']);
        printJson(await app.get(FinancialService).summary(flags['month']));
        break;
      }
      case 'balance:reconcile': {
        allowFlags(flags, ['source-key', 'account', 'currency', 'target', 'on', 'reason']);
        const currency = requiredCurrency(flags, 'currency');
        const result = await app.get(FinancialService).reconcile({
          sourceKey: requiredFlag(flags, 'source-key'), accountId: requiredFlag(flags, 'account'), currency,
          targetMinor: parseOpeningAmount(requiredFlag(flags, 'target'), currency),
          occurredOn: requiredFlag(flags, 'on'), reason: requiredFlag(flags, 'reason'),
        });
        console.log(`Conciliacion ${result.reconciliation.id} | delta ${formatAmount(result.reconciliation.deltaMinor, currency)} ${currency} | ${result.created ? 'creada' : 'existente'}`);
        break;
      }
      case 'reconciliation:list': {
        allowFlags(flags, ['account']);
        printJson(await app.get(FinancialService).reconciliations(flags['account']));
        break;
      }
      case 'budget:add': {
        allowFlags(flags, ['source-key', 'name', 'currency', 'limit', 'category', 'from', 'to', 'month', 'half']);
        const hasMonth = flags['month'] !== undefined;
        if ((hasMonth && (flags['from'] !== undefined || flags['to'] !== undefined)) || (!hasMonth && flags['half'] !== undefined)) {
          throw new Error('Use --from y --to O --month [--half first|second], no ambos.');
        }
        const half = flags['half'];
        if (half !== undefined && half !== 'first' && half !== 'second') throw new Error('Use --half first|second.');
        const period = hasMonth
          ? (half === undefined ? monthPeriod(requiredFlag(flags, 'month')) : quincenaPeriod(requiredFlag(flags, 'month'), half))
          : { startsOn: requiredFlag(flags, 'from'), endsOn: requiredFlag(flags, 'to') };
        const currency = requiredCurrency(flags, 'currency');
        const result = await app.get(BudgetService).create({
          sourceKey: requiredFlag(flags, 'source-key'), name: requiredFlag(flags, 'name'), currency,
          limitMinor: parseBudgetLimit(requiredFlag(flags, 'limit'), currency), category: flags['category'], ...period,
        });
        console.log(`Presupuesto ${result.budget.id} | ${result.created ? 'creado' : 'existente'}`);
        break;
      }
      case 'budget:list': {
        allowFlags(flags, []);
        printJson(await app.get(BudgetService).list());
        break;
      }
      case 'budget:status': {
        allowFlags(flags, ['budget', 'on']);
        const rows = await app.get(BudgetService).status({ budgetId: flags['budget'], on: flags['on'] });
        if (rows.length === 0) console.log('No hay presupuestos activos.');
        for (const { budget, asOf, spent, remaining, overspent } of rows) {
          console.log(`${budget.id} | ${budget.name} | ${budget.currency} | ${budget.category === null ? 'global' : `categoria ${budget.category}`} | ${budget.startsOn}..${budget.endsOn} | al ${asOf} | limite ${formatAmount(budget.limitMinor, budget.currency)} | gastado ${formatAmount(spent, budget.currency)} | restante ${formatAmount(remaining, budget.currency)}${overspent ? ' | excedido' : ''}`);
        }
        console.log('Limites informativos, no saldo bancario; sin rollover. Alcances y monedas independientes: no sumar restantes.');
        break;
      }
      case 'goal:add': {
        allowFlags(flags, ['source-key', 'name', 'currency', 'target', 'target-on']);
        const currency = requiredCurrency(flags, 'currency');
        const result = await app.get(GoalService).create({
          sourceKey: requiredFlag(flags, 'source-key'), name: requiredFlag(flags, 'name'), currency,
          targetMinor: parseAmount(requiredFlag(flags, 'target'), currency), targetOn: flags['target-on'],
        });
        console.log(`Meta ${result.goal.id} | ${result.created ? 'creada' : 'existente'}`);
        break;
      }
      case 'goal:list': {
        allowFlags(flags, []);
        printJson(await app.get(GoalService).list());
        break;
      }
      case 'goal:status': {
        allowFlags(flags, ['goal']);
        const rows = await app.get(SavingsService).goalStatus(flags['goal']);
        if (rows.length === 0) console.log('No hay metas registradas.');
        for (const row of rows) console.log(formatGoalStatus(row));
        console.log('Reservas nominales, no garantia de fondos. Se permite superar el 100%; no se prorratean deficits.');
        break;
      }
      case 'savings:reserve':
      case 'savings:release': {
        allowFlags(flags, ['source-key', 'goal', 'account', 'amount']);
        const goal = await app.get(GoalService).get(requiredFlag(flags, 'goal'));
        const input = {
          sourceKey: requiredFlag(flags, 'source-key'), goalId: goal.id, accountId: requiredFlag(flags, 'account'),
          currency: goal.currency, amountMinor: parseAmount(requiredFlag(flags, 'amount'), goal.currency),
        };
        const savings = app.get(SavingsService);
        const result = command === 'savings:reserve' ? await savings.reserve(input) : await savings.release(input);
        console.log(`Reserva ${result.entry.id} | ${result.entry.kind} | ${result.entry.currency} | ${result.created ? 'creada' : 'existente'}`);
        break;
      }
      case 'savings:status': {
        allowFlags(flags, ['account']);
        const rows = await app.get(SavingsService).status(flags['account']);
        if (rows.length === 0) console.log('No hay cuentas registradas.');
        for (const row of rows) console.log(formatSavingsStatus(row));
        console.log('Reservas virtuales actuales; no son transferencias. No sumar monedas distintas.');
        break;
      }
      case 'savings:history': {
        allowFlags(flags, ['account', 'goal']);
        printJson(await app.get(SavingsService).history({ accountId: flags['account'], goalId: flags['goal'] }));
        break;
      }
      case 'opening:add': {
        allowFlags(flags, ['source-key', 'account', 'currency', 'amount', 'on', 'description']);
        const currency = requiredCurrency(flags, 'currency');
        const result = await app.get(FinancialService).open({
          sourceKey: requiredFlag(flags, 'source-key'),
          accountId: requiredFlag(flags, 'account'),
          money: { currency, minor: parseOpeningAmount(requiredFlag(flags, 'amount'), currency) },
          occurredOn: requiredFlag(flags, 'on'),
          description: flags['description'],
        });
        console.log(`Operacion ${result.operation.id} | opening | ${result.created ? 'creada' : 'existente'}`);
        break;
      }
      case 'transfer:add': {
        allowFlags(flags, ['source-key', 'from', 'from-currency', 'sent', 'to', 'to-currency', 'received', 'on', 'description', 'fee-account', 'fee-currency', 'fee']);
        const leg = (accountFlag: string, currencyFlag: string, amountFlag: string): TransferLeg => {
          const currency = requiredCurrency(flags, currencyFlag);
          return {
            accountId: requiredFlag(flags, accountFlag),
            money: { currency, minor: parseAmount(requiredFlag(flags, amountFlag), currency) },
          };
        };
        const hasFee = ['fee-account', 'fee-currency', 'fee'].some((key) => flags[key] !== undefined);
        const result = await app.get(FinancialService).transfer({
          sourceKey: requiredFlag(flags, 'source-key'),
          from: leg('from', 'from-currency', 'sent'),
          to: leg('to', 'to-currency', 'received'),
          fee: hasFee ? leg('fee-account', 'fee-currency', 'fee') : undefined,
          occurredOn: requiredFlag(flags, 'on'),
          description: flags['description'],
        });
        console.log(`Operacion ${result.operation.id} | transfer | ${result.created ? 'creada' : 'existente'}${result.operation.feeMovementId ? ` | comision ${result.operation.feeMovementId}` : ''}`);
        break;
      }
      case 'migration:run': {
        const applied = await app.get(DataSource).runMigrations();
        if (applied.length === 0) {
          console.log('No habia migraciones pendientes.');
          break;
        }
        console.log(`Migraciones aplicadas: ${applied.map((migration) => migration.name).join(', ')}`);
        break;
      }
      case 'backup': {
        const destination = flags['to'];
        if (!destination) {
          throw new Error('Falta la opcion --to con la ruta de la copia de seguridad.');
        }
        const result = await backupDatabase(databasePath, destination, {
          force: flags['force'] !== undefined,
        });
        console.log(`Copia de seguridad creada: ${result.destination} (${result.bytes} bytes)`);
        break;
      }
      case 'restore': {
        const source = flags['from'];
        const destination = flags['to'];
        if (!source || !destination) {
          throw new Error('Faltan las opciones --from (copia) y --to (ruta nueva).');
        }
        const result = await restoreDatabase(source, destination);
        console.log(`Copia restaurada en: ${result.destination} (${result.bytes} bytes)`);
        break;
      }
      default:
        console.log(USAGE);
        process.exitCode = 1;
    }
    if (['movement:add', 'movement:edit', 'movement:void', 'balance:reconcile', 'opening:add', 'transfer:add'].includes(command)) {
      for (const warning of await app.get(SavingsService).warnings()) console.log(warning);
    }
  } finally {
    await app.close();
    releaseInstanceLock();
  }
}

interface ResolvedCommand {
  command: string;
  flags: Record<string, string>;
}

function resolveCommand(args: string[]): ResolvedCommand {
  const [first, second] = args;
  const command = first === 'migration' && second === 'run' ? 'migration:run' : (first ?? '');
  const rest = first === 'migration' && second === 'run' ? args.slice(2) : args.slice(1);
  const strict = ['balance:list', 'opening:add', 'transfer:add', 'movement:add', 'movement:edit', 'movement:void',
    'movement:show', 'movement:history', 'movement:recent', 'summary', 'balance:reconcile', 'reconciliation:list',
    'budget:add', 'budget:list', 'budget:status', 'goal:add', 'goal:list', 'goal:status',
    'savings:reserve', 'savings:release', 'savings:status', 'savings:history'].includes(command);
  return { command, flags: parseFlags(rest, strict) };
}

function parseFlags(args: string[], strict = false): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || !arg.startsWith('--')) {
      if (strict) {
        throw new Error(`Opcion invalida "${String(arg)}".`);
      }
      continue;
    }
    const [key, ...values] = arg.slice(2).split('=');
    const inlineValue = strict
      ? (values.length === 0 ? undefined : values.join('='))
      : values[0];
    if (key === undefined || key.length === 0) {
      if (strict) {
        throw new Error('Opcion vacia.');
      }
      continue;
    }
    if (strict && flags[key] !== undefined) {
      throw new Error(`Opcion repetida --${key}.`);
    }
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else if (strict) {
      flags[key] = '';
    }
  }
  return flags;
}

function requiredFlag(flags: Record<string, string>, key: string): string {
  const value = flags[key];
  if (!value) {
    throw new Error(`Falta la opcion --${key} con su valor.`);
  }
  return value;
}

function integerFlag(flags: Record<string, string>, key: string, min: number, max: number): number {
  const raw = requiredFlag(flags, key);
  const value = Number(raw);
  if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`--${key} debe ser un entero entre ${min} y ${max}.`);
  }
  return value;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, (_key, entry: unknown) => typeof entry === 'bigint' ? entry.toString() : entry, 2));
}

function requiredCurrency(flags: Record<string, string>, key: string) {
  const currency = requiredFlag(flags, key);
  if (!isCurrency(currency)) {
    throw new Error(`Moneda no soportada "${currency}". Use ${CURRENCY_CODES.join(', ')}.`);
  }
  return currency;
}

function allowFlags(flags: Record<string, string>, allowed: string[]): void {
  for (const key of Object.keys(flags)) {
    if (!allowed.includes(key)) {
      throw new Error(`Opcion desconocida --${key}.`);
    }
    requiredFlag(flags, key);
  }
}

void main().catch((error: unknown) => {
  releaseInstanceLock();
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
