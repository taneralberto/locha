'use strict';

/**
 * Servidor de desarrollo: compila el proyecto con `tsc --watch` y ejecuta la
 * aplicacion. Cuando TypeScript recompila, la aplicacion se reinicia de forma
 * ordenada: primero se termina la anterior y despues arranca la nueva.
 *
 * Se usa el mismo `tsc` del build (y no `tsx` ni `nodemon`) porque el codigo usa
 * decoradores con `emitDecoratorMetadata`, que los transpiladores rapidos no emiten.
 *
 * En Windows el proceso hijo no recibe SIGTERM (se termina de golpe), asi que el
 * supervisor borra el cerrojo de la instancia cuando el hijo ya termino: sabe con
 * certeza que no hay nadie mas escribiendo en la base.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const mainFile = path.join(dist, 'main.js');

let app = null;
let restarting = false;
let pending = null;
let removeLock = null;

function compile() {
  const result = spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.build.json'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error('La compilacion fallo. No se arranca la aplicacion.');
    process.exit(result.status ?? 1);
  }
}

function databasePath() {
  require(path.join(root, 'node_modules', 'dotenv')).config({ quiet: true });
  return process.env.DATABASE_PATH || 'data/locha.sqlite';
}

function releaseLock() {
  if (!removeLock) {
    return;
  }
  try {
    removeLock(databasePath());
  } catch (error) {
    console.error(`No se pudo soltar el cerrojo: ${error.message}`);
  }
}

function startApp() {
  app = spawn(process.execPath, [mainFile], { cwd: root, stdio: 'inherit' });
  app.on('exit', (code, signal) => {
    app = null;
    releaseLock();
    if (restarting) {
      restarting = false;
      startApp();
      return;
    }
    if (signal === 'SIGINT' || signal === 'SIGTERM') {
      process.exit(0);
    }
    process.exit(code ?? 0);
  });
}

function restartApp() {
  if (!app) {
    startApp();
    return;
  }
  restarting = true;
  app.kill('SIGTERM');
}

function scheduleRestart() {
  if (pending) {
    clearTimeout(pending);
  }
  pending = setTimeout(() => {
    pending = null;
    restartApp();
  }, 250);
}

function main() {
  compile();
  removeLock = require(path.join(dist, 'lock', 'instance-lock.js')).removeLockFor;
  startApp();

  const compiler = spawn(process.execPath, [tscBin, '-p', 'tsconfig.build.json', '--watch'], {
    cwd: root,
    stdio: 'inherit',
  });
  compiler.on('exit', (code) => {
    console.error('El compilador termino. Se cierra la aplicacion.');
    if (app) {
      app.kill('SIGTERM');
    }
    process.exit(code ?? 0);
  });

  fs.watch(dist, { recursive: true }, () => scheduleRestart());

  const stop = () => {
    if (pending) {
      clearTimeout(pending);
    }
    compiler.kill('SIGTERM');
    if (app) {
      app.kill('SIGTERM');
    }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
