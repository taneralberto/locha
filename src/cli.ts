import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { config as loadEnvFile } from 'dotenv';
import { DataSource } from 'typeorm';
import { AccountService } from './accounts/account.service';
import { AppModule } from './app.module';
import { resolveDatabasePath } from './config/configuration';
import { backupDatabase, restoreDatabase } from './data/backup';
import { CURRENCY_CODES, isCurrency } from './domain/money';
import { acquireInstanceLock, lockPathFor, releaseInstanceLock } from './lock/instance-lock';

const USAGE = `Uso: npm run cli -- <comando> [--opcion valor]

Comandos:
  account:add --name <nombre> --currency <${CURRENCY_CODES.join('|')}>   Crea una cuenta
  account:list                                                         Lista las cuentas
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
  return { command, flags: parseFlags(rest) };
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || !arg.startsWith('--')) {
      continue;
    }
    const [key, inlineValue] = arg.slice(2).split('=');
    if (key === undefined || key.length === 0) {
      continue;
    }
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    }
  }
  return flags;
}

void main().catch((error: unknown) => {
  releaseInstanceLock();
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
