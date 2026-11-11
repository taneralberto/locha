# Locha — Asistente financiero personal con IA

Backend NestJS + TypeORM + SQLite. **B1, B2, B3 y B4 aceptados técnicamente en local**:
saldos, aperturas, transferencias/conversiones, correcciones auditadas, categorías,
conciliación, presupuestos, metas y reservas virtuales por cuenta/moneda con advertencias
de déficit. Las cuatro unidades pasaron su revisión obligatoria de solo lectura sin
hallazgos y la validación integrada independiente del orquestador en Node 24.
**Etapa B completada en el alcance documentado:** mutadores manuales por CLI local,
con el bot detenido y bajo el cerrojo de instancia única; Telegram aporta consultas
deterministas y advertencias al confirmar ingresos/gastos de la captura existente.
No implica flujos B completos en lenguaje natural, pruebas con proveedores reales,
preparación para producción ni interfaz Angular. La **Etapa A mantiene su aceptación**; su evidencia
histórica se conserva abajo: **Etapa A — aceptación técnica local
completa, habilitación operativa pendiente**. Las **unidades 1 y 2 están aceptadas**; la
**unidad 3 está aceptada técnicamente para el alcance A** (implementada, corregida y
verificada con pruebas automáticas), con **verificación operativa pendiente**: falta la
prueba con el proveedor real y con Node 24, y una revisión de preparación para producción.
Las tres unidades son parte del [plan general](plan-general-asistente-financiero-ia.md):

- **Unidad 1** — contexto de aplicación ejecutable, modelo mínimo de cuentas y
  movimientos, migraciones, reglas monetarias exactas y un servicio de registro
  idempotente. **Aceptada.**
- **Unidad 2** — interpretación estructurada con OpenRouter y servicio de captura durable
  (independiente del transporte). **Aceptada.**
- **Unidad 3** — bot de Telegram por *long polling* en un chat privado, consultas
  deterministas, entrega durable de las respuestas, cerrojo de una sola instancia y
  copia de seguridad con restauración. **Aceptada técnicamente para el alcance A;
  verificación operativa pendiente.**

> **Aviso: no uses datos financieros reales todavía.** Las correcciones de la unidad 3
> están aplicadas, revisadas localmente y comprobadas con pruebas automáticas, pero
> **esta entrega no ha pasado una revisión de preparación para producción**. Lo que
> sigue pendiente:
>
> - **El modelo no está validado con frases reales.** Es una tarea manual del
>   operador: elegir el modelo y comprobarlo con el proveedor real.
> - **No se ha probado contra la API real de Telegram ni contra OpenRouter.** Las
>   pruebas usan un Telegram y un OpenRouter simulados; ninguna prueba hace llamadas
>   externas.
> - **El cerrojo obsoleto no se recupera solo.** Si el proceso muere de golpe, el
>   directorio del cerrojo hay que borrarlo a mano (decisión del operador, por
>   prudencia). La exclusión entre procesos sí está comprobada.
> - **La evidencia histórica completa de A usó Node 22.22.3.** La validación integrada
>   de B1–B4 se completó en Node 24; esto no es una nueva auditoría de A.
>
> Hasta que haya una revisión y una prueba con el proveedor real, **no introduzcas
> datos financieros reales** en esta instalación: usa solo datos de prueba.

El flujo completo es: **mensaje en Telegram → interpretación → resumen → `/confirm` →
un movimiento guardado → `/summary` con los totales del mes**.

## Requisitos

- Node.js 24 (`node --version`)
- npm 12
- Un bot de Telegram y su token (opcional: sin el, el backend funciona igual)

## Instalación

```bash
npm ci
```

`better-sqlite3` es un módulo nativo: si no hay binario precompilado para tu plataforma, npm
compila desde código fuente y necesita Python y un compilador C++ (en Windows: *Visual Studio
Build Tools* con el workload C++).

## Configuración

```bash
cp .env.example .env
```

`.env` está en `.gitignore`; no se versionan datos ni secretos.

### Base de datos

| Variable        | Por defecto         | Descripción                                     |
| --------------- | ------------------- | ----------------------------------------------- |
| `DATABASE_PATH` | `data/locha.sqlite` | Ruta del archivo SQLite (el directorio se crea) |

`DATABASE_PATH` no puede estar vacío ni ser solo espacios: la aplicación rechaza arrancar en
ese caso en lugar de abrir una base inesperada.

### Interpretación con OpenRouter (opcional)

Sin `OPENROUTER_API_KEY` y `OPENROUTER_MODEL` la aplicación **arranca igual**: la captura
responde que no está configurada y no se llama al proveedor.

| Variable                                  | Por defecto                  | Descripción                                            |
| ----------------------------------------- | ---------------------------- | ------------------------------------------------------ |
| `OPENROUTER_API_KEY`                      | (vacío)                      | Credencial de OpenRouter                                |
| `OPENROUTER_MODEL`                        | (vacío)                      | Modelo usado; debe soportar salidas estructuradas      |
| `OPENROUTER_BASE_URL`                     | `https://openrouter.ai/api/v1` | Endpoint de Chat Completions                          |
| `OPENROUTER_TIMEOUT_MS`                   | `20000`                      | Espera máxima de la llamada (ms)                        |
| `OPENROUTER_MAX_INPUT_CHARS`              | `2000`                       | Longitud máxima del texto enviado al proveedor          |
| `OPENROUTER_MAX_RESPONSE_BYTES`           | `16384`                      | Tope de la respuesta del proveedor que se lee (bytes)   |
| `OPENROUTER_MAX_REQUESTS_PER_DAY`         | `100`                        | Llamadas máximas por día                                |
| `OPENROUTER_MAX_INPUT_TOKENS_PER_CALL`    | `2000`                       | Tokens de entrada reservados por llamada                |
| `OPENROUTER_MAX_OUTPUT_TOKENS_PER_CALL`   | `500`                        | Tokens de salida reservados por llamada (`max_tokens`)  |
| `OPENROUTER_MAX_COST_MICRO_USD_PER_CALL`  | `5000`                       | Costo máximo reservado por llamada (microUSD)          |
| `OPENROUTER_DAILY_BUDGET_MICRO_USD`        | `200000`                     | Presupuesto diario reservado (microUSD)                |

Los límites son enteros: un valor definido pero no entero (`"1.5"`, `"10s"`) es un error de
configuración y la aplicación no arranca. 1 USD = 1 000 000 microUSD.

**El allowance local no es una garantía de la factura del proveedor.** La reserva diaria es
conservadora (se reserva el máximo por llamada aunque la llamada real cueste menos) y las
reservas consumidas no se devuelven. El operador debe además fijar un límite de gasto en
su cuenta de OpenRouter.

El modelo no se presupone válido: lo elige el operador y debe soportar
`response_format: { type: "json_schema" }`. **La validación del modelo con frases reales
sigue pendiente**: es una tarea manual del operador, no automatizada.

### Telegram (opcional)

| Variable                       | Por defecto | Descripción                                            |
| ------------------------------ | ----------- | ------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN`           | (vacío)     | Token del bot (lo entrega @BotFather)                   |
| `TELEGRAM_ALLOWED_USER_ID`     | (vacío)     | Id numérico del usuario autorizado                     |
| `TELEGRAM_ALLOWED_CHAT_ID`     | (vacío)     | Id numérico del chat privado autorizado                |
| `TELEGRAM_TIMEOUT_MS`          | `40000`     | Plazo máximo de cada llamada a la API (ms)              |
| `TELEGRAM_MAX_RESPONSE_BYTES`  | `65536`     | Tope de la respuesta de la API que se lee (bytes)       |
| `TELEGRAM_POLL_TIMEOUT_SECONDS`| `25`        | Espera máxima del long polling en el lado de Telegram   |

El bot **solo se activa con las tres variables** (`TELEGRAM_BOT_TOKEN`,
`TELEGRAM_ALLOWED_USER_ID` y `TELEGRAM_ALLOWED_CHAT_ID`). Con una configuración parcial el
backend **arranca igual, pero el bot queda desactivado** y avisa por log: nunca se acepta
a medias. Un id que no sea numérico es un error de configuración y la aplicación no
arranca.

Para conocer tu id: abre `@userinfobot` (o `@RawDataBot`) en Telegram y habla con el bot
por privado; el id de usuario y el id del chat privado coinciden.

## Puesta en marcha

```bash
npm ci
cp .env.example .env      # y rellena el token y los ids si quieres el bot
npm run migration:run     # crea el esquema
npm run account:add -- --name Efectivo --currency USD
npm start                 # arranca el bot (long polling)
```

Mientras el backend está corriendo, la CLI **no** puede escribir en la base (cerrojo de una
sola instancia, ver más abajo). Para crear cuentas o copiar la base, detén el backend
(`Ctrl+C`) primero.

### Desarrollo

```bash
npm run start:dev
```

Compila con `tsc --watch` y ejecuta la aplicación; cada recompilación reinicia el backend de
forma ordenada (termina el proceso anterior y arranca el nuevo). El script es
`scripts/dev.js` y no necesita dependencias adicionales: se usa el mismo `tsc` del build
porque el código usa decoradores con `emitDecoratorMetadata`, que los transpiladores rápidos
(`tsx`) no emiten.

## Comandos del bot

El bot solo atiende el **chat privado** del usuario autorizado. Cualquier otro chat, otro
usuario, un mensaje editado o un mensaje que no sea de texto se ignoran **sin guardar nada**.

| Comando                | Qué hace                                                       |
| ---------------------- | -------------------------------------------------------------- |
| `/help`, `/start`      | Lista los comandos disponibles                                   |
| `/accounts`            | Lista tus cuentas (id, nombre, moneda, si están activas)         |
| `/balances [YYYY-MM-DD]` | Saldos por cuenta a una fecha inclusiva (hoy en Caracas por defecto) |
| `/budgets [YYYY-MM-DD]` | Presupuestos activos: límite, gastado y restante por alcance/moneda |
| `/goals [id]`          | Progreso nominal actual de todas las metas o una meta |
| `/savings`             | Saldo real, reservado virtual, disponible y déficit actuales |
| `/debts [id]`          | Deudas registradas y su pendiente, por dirección y moneda (solo lectura) |
| `/recent`              | Lista los últimos movimientos, con su **id de movimiento**      |
| `/summary`             | Totales del mes actual                                           |
| `/summary 2026-11`     | Totales de un mes concreto (`YYYY-MM`)                           |
| `/usage`               | Consumo **reservado** de inferencia del día                      |
| `/confirm`             | Registra la operación que te acaba de mostrar                    |
| `/cancel`              | Descarta la operación pendiente                                  |

Cualquier otro comando con `/` muestra la ayuda. **Las consultas nunca llaman al modelo**:
`/accounts`, `/balances`, `/budgets`, `/goals`, `/savings`, `/debts`, `/recent`, `/summary` y `/usage` se calculan con los datos guardados.

`/summary` muestra los **totales de la actividad registrada** en el mes (ingresos, gastos y
neto por moneda) con importes exactos. **No son el saldo de tus cuentas**: excluyen
aperturas y principales transferidos; las comisiones sí son gastos. Para saldos usa
`/balances`. No hay comandos de escritura de aperturas/transferencias en Telegram y
la captura con IA admite ingresos/gastos y, desde la unidad 2, deudas (crear, pagar y
consultar).

`/usage` muestra el día de Caracas, las llamadas reservadas frente al límite, los tokens
reservados, el costo reservado frente al presupuesto (en microUSD) y la reserva máxima por
llamada. Es la **reserva local conservadora**, no la factura del proveedor: la propia
respuesta lo dice. No llama al proveedor, no reserva nada y no toca el borrador pendiente.

La respuesta de un registro incluye el **id del movimiento** (`Movimiento: <id>`), que es el
mismo que aparece en `/recent`.

## Base de datos

El esquema solo cambia por migraciones: `synchronize` está desactivado en
`src/data/data-source.ts`.

Migraciones: `InitialSchema1767225600000` (cuentas y movimientos),
`CaptureAndInference1769904000000` (capturas, bandeja de eventos y consumo diario) y
`TelegramDelivery1772582400000` (bandejas de Telegram y cursor del polling) y
`LedgerOperations1775260800000` (aperturas/transferencias B1) y
`MovementCorrections1777939200000` (revisiones y conciliaciones B2) y
`Budgets1780617600000` (presupuestos B3) y
`GoalsAndSavings1783209600000` (metas y reservas virtuales B4) y
`Debts1785888000000` (deudas: `debt` y `debt_payment`) y
`DebtCapture1788566400000` (borrador de deuda: columna `debtPayload` de `capture`).

Para actualizar una base ficticia A, B1, B2, B3, B4 o B5 completa: detén el backend, haz una copia de seguridad,
actualiza/compila el código y ejecuta `npm run migration:run` antes de reiniciar.
**No borres ni recrees la base**: B4 añade solo `goal` y `savings_entry`, la migración de deudas
añade solo `debt` y `debt_payment` y la del borrador de deuda añade **una sola columna**,
sin cambiar filas, IDs, claves ni esquemas previos.
La aplicación no aplica migraciones automáticamente.

## CLI

```bash
npm run cli -- <comando> [--opcion valor]
```

`npm run cli` usa `dist/`: ejecuta `npm run build` primero (los alias de la tabla sí compilan
por su cuenta).

| Comando            | Alias                | Qué hace                                            |
| ------------------ | -------------------- | --------------------------------------------------- |
| `migration:run`    | `npm run migration:run` | Aplica las migraciones pendientes                 |
| `account:add`      | `npm run account:add`   | Crea una cuenta (`--name`, `--currency`)          |
| `account:list`     | `npm run account:list`  | Lista las cuentas                                 |
| `balance:list`     | `npm run balance:list`  | Saldos (`--on YYYY-MM-DD` opcional)               |
| `opening:add`      | `npm run opening:add`   | Una apertura fechada por cuenta                  |
| `transfer:add`     | `npm run transfer:add`  | Transferencia/conversión y comisión opcional     |
| `budget:add`       | `npm run budget:add`    | Definición inmutable de presupuesto              |
| `budget:list`      | `npm run budget:list`   | Todas las definiciones, JSON con unidades menores |
| `budget:status`    | `npm run budget:status` | Límite/gastado/restante a una fecha                |
| `goal:add/list/status` | `npm run goal:add` / `goal:list` / `goal:status` | Metas inmutables y progreso nominal |
| `savings:reserve/release` | `npm run savings:reserve` / `savings:release` | Reservar/liberar virtualmente |
| `savings:status/history` | `npm run savings:status` / `savings:history` | Estado actual e historial virtual |
| `backup`           | `npm run backup`       | Copia de seguridad (`--to <ruta>`)                |
| `restore`          | `npm run restore`      | Restaura una copia (`--from <ruta> --to <ruta>`)  |

```bash
npm run cli -- account:add --name "Efectivo" --currency USD
npm run cli -- account:list
npm run cli -- backup --to data/copia-2026-11-10.sqlite
npm run cli -- restore --from data/copia-2026-11-10.sqlite --to data/restaurada.sqlite
```

Los alias (`npm run migration:run`, etc.) compilan el proyecto antes de ejecutarse. Los
errores de validación y los conflictos terminan con código de salida `1`.

Monedas admitidas: `VES`, `USD`, `USDT`.

### B1: aperturas, conversiones y saldos

Usa los **IDs explícitos** de `account:list` (sustituye `ID_USD` y `ID_VES`):

```bash
npm run opening:add -- --source-key inicio-usd-2026 --account ID_USD --currency USD --amount 100.00 --on 2026-11-01 --description "Apertura"
npm run transfer:add -- --source-key cambio-2026-11-02 --from ID_USD --from-currency USD --sent 50.00 --to ID_VES --to-currency VES --received 20000.00 --on 2026-11-02 --description "Cambio real" --fee-account ID_USD --fee-currency USD --fee 0.50
npm run balance:list -- --on 2026-11-02
```

- **Apertura aditiva y fechada, no instantánea:** una por cuenta, importe firmado o cero
  (`--amount -10.00`, `--amount 0`). Se suma a toda actividad anterior; no la reemplaza.
  El indicador `apertura si/no` dice si ya está incluida a la fecha consultada.
- **Importes exactos:** punto decimal, USD/VES hasta 2 decimales y USDT hasta 6; sin
  redondeo, notación exponencial ni separadores de miles. Se permiten saldos negativos
  porque la actividad puede estar incompleta; no se comprueba disponibilidad de fondos.
- **Transferencias entre cuentas distintas:** `--sent` y `--received` son los principales
  positivos reales, explícitos. No se inventa tasa ni valoración. En la misma moneda
  deben ser iguales. La comisión es **extra**, no se resta del principal recibido.
- **Comisión opcional:** entrega juntos `--fee-account`, `--fee-currency` y `--fee` (> 0).
  Puede salir de otra cuenta/moneda y se registra como gasto ordinario en la misma
  transacción. Ambos lados y comisión se guardan todos o ninguno.
- **Idempotencia:** `--source-key` es obligatorio; repetir el payload normalizado completo
  devuelve el mismo ID con estado `existente`; cambiarlo produce conflicto (también si
  cambia la comisión). Un replay sigue funcionando después de desactivar una cuenta;
  las escrituras nuevas requieren cuentas activas y moneda coincidente. Las claves de
  operaciones tienen su propio espacio; las comisiones usan `ledger:<UUID-operacion>:fee`.
- **Consultas:** `balance:list [--on YYYY-MM-DD]` y `/balances [YYYY-MM-DD]` incluyen
  movimientos y operaciones con fecha <= corte; por defecto hoy en `America/Caracas`.
  Incluyen cuentas inactivas y vacías; orden por nombre e ID, sin sumar monedas distintas.
  Telegram limita la respuesta a filas completas y avisa de las omitidas; la CLI lista todas.
- En el ejemplo, sin otra actividad: USD **49.50**, VES **20000.00**. `/summary` y
  `/recent` solo ven el gasto de comisión **0.50 USD**, no la apertura ni el cambio.

API (`FinancialService`, mismo `TransactionRunner` que A):

```ts
open({ sourceKey, accountId, money: { currency, minor }, occurredOn, description? }, manager?)
transfer({ sourceKey, from: { accountId, money }, to: { accountId, money }, fee?: { accountId, money }, occurredOn, description? }, manager?)
// Ambas devuelven { operation: LedgerOperation, created: boolean }; minor es bigint.
balances(on?: string, manager?)
// AccountBalance[]: accountId, name, currency, balance: bigint, hasOpening, asOf.
```

Un `EntityManager` entregado debe pertenecer a una transacción del llamador, que debe
propagar los errores para hacer rollback. Sin él, el servicio abre la transacción serializada.
`register()` conserva su contrato de ingresos/gastos. B1 cubre aperturas, transferencias
y saldos; las correcciones/conciliación, presupuestos y metas/reservas se describen en B2–B4.

Verificación B1 (bases temporales, sin proveedores ni datos reales):

```bash
npm run typecheck
npm run build
npm test -- --runInBand test/ledger-operations.spec.ts test/ledger-migration.spec.ts test/ledger-cli.spec.ts test/telegram-commands.spec.ts test/financial.service.spec.ts test/migration.spec.ts test/backup.spec.ts test/app-context.spec.ts test/money.spec.ts test/capture.service.spec.ts
```

La cobertura B1 incluida en la validación integrada de B, abajo, verifica migración de A poblada sin
cambios históricos, backup A → restaurar → migrar, backup B1 con saldos iguales,
rollback tras comisión e inserción fallida, y CLI con procesos reales. No se aplicaron
migraciones a la base configurada del operador ni se usaron servicios externos.

### B2: correcciones auditadas, categorías y conciliación

Detén el backend; usa una base ficticia separada y migra tras hacer backup. B1 y B2
están aceptados. B2 no incluye presupuestos, objetivos ni reservas; los presupuestos
se añaden exclusivamente en B3, abajo. No cambia la captura IA ni habilita escrituras
financieras nuevas por Telegram.

```bash
npm run movement:add -- --source-key manual-1 --account ID_USD --currency USD --kind expense --amount 2.00 --on 2026-11-01 --description Helado
npm run movement:show -- --movement ID_MOVIMIENTO
npm run movement:edit -- --source-key correccion-1 --movement ID_MOVIMIENTO --expected-revision 0 --amount 2.50 --on 2026-11-02 --reason "Importe y fecha correctos" --description Helado --category Comida
npm run movement:history -- --movement ID_MOVIMIENTO
npm run movement:recent -- --limit 20
npm run summary -- --month 2026-11
npm run balance:reconcile -- --source-key conteo-1 --account ID_USD --currency USD --target -10.00 --on 2026-11-02 --reason "Conteo manual"
npm run reconciliation:list -- --account ID_USD
npm run movement:void -- --source-key anulacion-1 --movement ID_MOVIMIENTO --expected-revision 1 --reason Duplicado
```

- **Original inmutable:** ni editar ni anular reescriben `movement`. `register()` sigue
  devolviendo el original al repetir su clave. `movement:show` y `movement:history`
  muestran original, revisiones ordenadas, efectivo y operación dueña de la comisión.
  La salida de consultas CLI es JSON; los importes `*Minor` son cadenas en unidades
  menores (USD/VES 100 por unidad; USDT 1000000), no importes decimales.
- **Edición de reemplazo completo:** importe positivo, fecha, descripción y categoría.
  Si se omiten `--description` o `--category`, se borran del efectivo. La categoría es
  una etiqueta opcional, recortada, sensible a mayúsculas, de 1 a 80 caracteres; no hay
  catálogo ni clasificación IA. Se asigna mediante edición, no en el registro original.
  Cuenta, moneda y tipo son fijos: para cambiarlos, anula y crea un movimiento manual
  con `movement:add` y una clave nueva. La CLI interpreta el importe editado en la
  moneda del original, sin permitir cambiarla.
- **Auditoría y concurrencia:** toda edición/anulación requiere motivo (1–280 caracteres)
  y revisión esperada (el original es 0). Una escritura nueva con revisión obsoleta
  falla, y la anulación es terminal. Repetir una clave con el mismo payload normalizado
  devuelve la revisión original incluso después de otras ediciones/anulación o de
  desactivar la cuenta. Cambiar su payload produce conflicto. Las claves de revisiones
  y conciliaciones tienen espacios propios, separados de movimientos y operaciones.
- **Límite explícito:** no se editan ni anulan aperturas ni principales transferidos;
  intentarlo con el ID de operación falla sin reversión parcial. La comisión sí puede
  editarse/anularse independientemente, sin cambiar los principales. Repetir la
  transferencia original sigue comparando su comisión **original**, no la corregida.
- **Una sola lectura efectiva:** `recent`, `summary` y `balances` resuelven primero las
  revisiones; después filtran mes/fecha, ordenan o limitan. Los anulados se excluyen.
- **Conciliación:** objetivo firmado o cero, cuenta activa y moneda coincidente. Calcula
  a la fecha inclusiva `delta = objetivo - saldo efectivo anterior`, incluyendo aperturas,
  transferencias, comisiones y conciliaciones anteriores. Se guarda ese delta exacto,
  incluso si es cero. Solo afecta al saldo, nunca a ingresos/gastos. Repetir la clave
  no recalcula nada. Una actividad/corrección retroactiva posterior puede causar
  **deriva** respecto del objetivo: no es una instantánea que sustituya el historial.
  Las nuevas correcciones también requieren cuenta activa; las lecturas incluyen inactivas.
- **Telegram solo lectura:** `/movement <id>`, `/history <id>` y
  `/reconciliations [id-cuenta]`, sin IA ni cambios al borrador pendiente. `/recent`
  muestra categoría. Las consultas nuevas están acotadas al límite de Telegram y
  ofrecen el comando CLI para el detalle completo.
- Todos estos comandos B2 rechazan flags desconocidos, duplicados, incompletos y
  posicionales inesperados. Validación/conflicto termina con código 1 sin escrituras.

API B2 (`FinancialService`, entradas monetarias en `bigint`, `manager?` transaccional):
`editMovement({ sourceKey, movementId, expectedRevision, amountMinor, occurredOn, reason,
description?, category? })`, `voidMovement({ sourceKey, movementId, expectedRevision, reason })`,
`movementHistory(id)`, `reconcile({ sourceKey, accountId, currency, targetMinor, occurredOn,
reason })`, `reconciliations(accountId?)`. Las escrituras devuelven `{ revision, created }`
o `{ reconciliation, created }`. `effectiveMovements()` devuelve DTOs compatibles con
`Movement`, con `category`, `revision` y `voided`; no son entidades para guardar.
Todos aceptan manager opcional para componer sin transacciones/colas anidadas.

Pruebas dedicadas B2: `movement-corrections.spec.ts`,
`movement-corrections-migration.spec.ts`, `movement-corrections-cli.spec.ts` y
`telegram-commands.spec.ts`. Usan exclusivamente bases temporales; prueban replay,
concurrencia, rollback, históricos inmutables, fechas/límites efectivos, precisión y
restauración A/B1 → migración B2 → backup B2 con historial y saldos iguales.

La evidencia vigente de B2 forma parte de la validación integrada de B, abajo.
No es una nueva auditoría de A ni una declaración de preparación para producción.

### B3: presupuestos financieros (aceptado)

Son límites **informativos**, no dinero reservado ni saldo bancario: nunca bloquean
gastos ni alteran movimientos/saldos. No hay rollover, actualización, eliminación,
objetivos ni reservas en B3 (B4 los añade por separado); tampoco transferencias por IA.

```bash
npm run budget:add -- --source-key noviembre-usd --name Noviembre --currency USD --limit 100.00 --month 2026-11
npm run budget:add -- --source-key comida-q1 --name Comida --currency USD --limit 20.00 --category Comida --month 2026-11 --half first
npm run budget:add -- --source-key comida-q2 --name Comida --currency USD --limit 0 --category Comida --from 2026-11-16 --to 2026-11-30
npm run budget:list
npm run budget:status -- --on 2026-11-10
npm run budget:status -- --budget ID_PRESUPUESTO --on 2026-12-10
```

- Una definición inmutable guarda UUID, `sourceKey` (1–200), nombre (1–80), moneda,
  `limitMinor` no negativo (cero válido), categoría opcional, fechas inclusivas y
  `createdAt`. Nombre/categoría/clave se recortan; categoría exacta, sensible a
  mayúsculas, de 1–80 caracteres, sin catálogo ni inferencia. Moneda independiente
  de cuentas: no requiere cuenta, fondos ni conversión. Dinero `bigint` en servicio,
  `TEXT` en SQLite; CLI recibe decimal exacto, sin redondeo, incluso USDT de 6 decimales.
- Fechas reales `YYYY-MM-DD`, inicio ≤ fin. Elige **solo** `--from` + `--to` o
  `--month YYYY-MM` con `--half first|second` opcional. Mes completo: 1..último día;
  quincenas: 1..15 y 16..último día (incluye bisiestos). `--half` exige `--month`.
  Flags desconocidos, duplicados, incompletos o posicionales fallan con código 1.
- Se rechaza cualquier solapamiento inclusivo de fechas para la **misma moneda y
  alcance**. Global (`category = null`) y cada categoría exacta son alcances diferentes;
  pueden coexistir. **No sumar sus restantes**, ni los de monedas distintas.
- Replay: misma clave y **todo** el payload normalizado devuelve el mismo presupuesto
  con `created: false`, antes de comprobar solapamientos. Payload distinto: conflicto.
  El espacio de claves es propio de presupuestos. No hay API de edición en B3.
- `gastado` solo suma gastos **efectivos no anulados**, de esa moneda y categoría
  (o todas para global), dentro del periodo inclusivo y hasta `--on` inclusive.
  Incluye comisiones; excluye principales transferidos, aperturas, conciliaciones e
  ingresos. Las correcciones de importe/fecha/categoría y anulaciones recalculan el
  reporte; no reescriben la definición. No se guardan contadores derivados.
- `restante = límite - gastado`, puede ser negativo; `excedido` significa restante < 0.
  Sin `--budget`, solo presupuestos activos al corte. Con ID se puede consultar uno
  histórico/futuro: antes de su inicio gastado es cero; después de su fin el gasto queda
  acotado al periodo. Por defecto el corte es hoy en `America/Caracas`; se excluyen
  gastos posteriores al corte. `budget:list` lista todas las definiciones.
- Telegram: `/budgets [YYYY-MM-DD]`, activos al corte, límite/gastado/restante exactos,
  categoría y periodo. Respuesta acotada por filas con alternativa CLI. No llama IA,
  reserva allowance ni cambia el borrador pendiente. Creación exclusivamente por CLI.

API (`BudgetService`, módulo propio):
`create({ sourceKey, name, currency, limitMinor, category?, startsOn, endsOn }, manager?)`
→ `{ budget, created }`; `list(manager?)` → `Budget[]`;
`status({ budgetId?, on? }?, manager?)` → `{ budget, asOf, spent, remaining, overspent }[]`.
`overspent` es booleano. Todas las lecturas/escrituras usan la cola transaccional
compartida; `manager` permite componer sin transacción anidada. La fuente de gasto
es únicamente `FinancialService.effectiveMovements(manager)`.

Pruebas B3 (solo SQLite temporal, sin proveedores ni base real):

```bash
npm run typecheck
npm run build
npm test -- --runInBand test/budget.service.spec.ts test/budget-migration.spec.ts test/budget-cli.spec.ts test/date.spec.ts test/money.spec.ts test/telegram-commands.spec.ts
```

Incluyen precisión grande/cero, límites/fechas inválidos, quincenas, replay concurrente,
solapamientos, gasto efectivo, comisiones, rollback/cola, CLI real estricta, Telegram
sin IA/pendiente intacto y restauración A/B1/B2 → migrar B3 → restaurar mismos reportes.
Esta evidencia no reabre la auditoría de A ni declara la preparación para producción.

B3 está aceptado; su evidencia vigente está en la validación integrada de B, abajo.

### B4: metas y reservas virtuales (aceptado)

Una reserva **no es una transferencia entre cuentas**, ni un gasto. Es una asignación
nominal dentro de la cuenta y moneda originales. No modifica saldos reales, movimientos,
presupuestos ni `/summary`. No hay conversión de monedas ni garantía bancaria.

```bash
npm run goal:add -- --source-key fondo-usdt --name Fondo --currency USDT --target 100.000001 --target-on 2028-02-29
npm run goal:list
npm run goal:status -- --goal ID_META
npm run savings:reserve -- --source-key reserva-1 --goal ID_META --account ID_CUENTA_USDT --amount 20.000001
npm run savings:release -- --source-key libera-1 --goal ID_META --account ID_CUENTA_USDT --amount 0.000001
npm run savings:status -- --account ID_CUENTA_USDT
npm run savings:history -- --account ID_CUENTA_USDT --goal ID_META
```

- Meta inmutable: UUID, `sourceKey` recortada 1–200, nombre recortado 1–80, una moneda,
  `targetMinor` positivo `TEXT` canónico y exacto, `createdAt`; `targetOn` opcional es un
  día real de calendario, solo informativo. Sin edición/eliminación ni vencimiento automático.
- `savings_entry` es historial append-only por la API: UUID, clave única, `kind`
  `reserve|release`, FK cuenta/meta, moneda, `amountMinor` positivo `TEXT`, `createdAt`.
  No hay fechas de reserva elegibles, retroactividad ni programación futura. Las consultas
  de reservas son **solo actuales**: hoy en `America/Caracas`, excluyendo actividad
  financiera futura. `/balances FECHA` mantiene el saldo histórico, pero solo muestra
  reservado/disponible/déficit si FECHA es hoy; nunca mezcla reservas actuales con otro corte.
- Cuenta y meta deben coincidir en moneda. La CLI deriva el parser de `--amount` de la
  moneda conocida de la meta y comprueba la cuenta: no adivina ni convierte. Objetivos e
  importes usan `parseAmount`: cero/negativos/exceso de decimales fallan, sin redondeo.
  Todos los flags B4 son estrictos: desconocidos/duplicados/incompletos/posicionales fallan.
- Reservar exige cuenta activa y `importe <= disponible`. Una única transacción calcula
  los pares meta/cuenta y el total reservado en **todas** las metas de esa cuenta.
  `reservado = reservas - liberaciones`; `disponible = saldo real - reservado`;
  `déficit = max(0, -disponible)`. Nada se suma entre monedas diferentes.
- Liberar exige `importe <= reservado` de **esa meta/cuenta**, y se permite en cuentas
  inactivas o deficitarias. Devuelve disponibilidad virtual, no dinero real. No hay autoliberación.
- Mismos `sourceKey` y payload normalizado devuelven mismo ID y `created: false` antes
  de verificar fondos, cuenta activa o reserva actual, incluso tras liberar o perder
  respaldo. Otro payload, incluido el tipo reserve/release: conflicto sin escribir.
  Metas y entradas tienen espacios de claves propios; las entradas comparten uno.
- Se permite **sobreobjetivo** si hay disponibilidad: progreso puede superar 100%.
  Por meta se suman reservas de sus cuentas de la misma moneda; restante es
  `max(0, objetivo - reservado)`. Progreso es cociente bigint exacto, presentado en
  porcentaje con dos decimales **truncados**, sin Number para importes/ratios.
- **Registrar y advertir:** gastos, transferencias/principales/comisiones, ediciones,
  anulaciones de ingresos y conciliaciones pueden dejar saldo por debajo de las reservas.
  Se registran normalmente, **preservando** todas las reservas; disponible puede ser
  negativo y nuevas reservas quedan bloqueadas. Los comandos financieros CLI imprimen
  advertencias genéricas de las cuentas actualmente deficitarias **después del éxito**,
  también en replay; no bloquean ni atribuyen causalidad a una operación concreta.
  Cada meta con reserva positiva en una cuenta deficitaria muestra
  **«reserva nominal con cuentas deficitarias»**. No se inventa reparto/prorrateo del faltante.
- Telegram solo consulta `/goals [ID]`, `/savings`, y `/balances` actuales: deterministas,
  acotadas por filas con alternativa CLI, sin IA ni modificar pendiente/allowance.
  Un registro exitoso de captura (`/confirm`) añade advertencia actual al entregar;
  no cambia el reply durable original ni duplica movimientos. El outbox fija el texto
  diagnosticado al procesar y los reintentos de envío lo conservan. Un replay de captura
  reprocesado puede reflejar un diagnóstico actual distinto. No se advierte por una
  confirmación fallida/sin pendiente. Metas/reservas/liberaciones: **solo CLI manual**.

API del módulo `SavingsModule` (sin dependencia inversa desde `FinancialModule`):

- `GoalService.create({sourceKey, name, currency, targetMinor, targetOn?}, manager?)`
  → `{goal, created}`; `list(manager?)` → `Goal[]`; `get(id, manager?)` → `Goal`.
- `SavingsService.reserve/release({sourceKey, goalId, accountId, currency, amountMinor}, manager?)`
  → `{entry, created}`; `status(accountId?, manager?)` →
  `{accountId, name, currency, asOf, hasOpening, balance, reserved, available, deficit}[]`;
  `goalStatus(goalId?, manager?)` → `{goal, reserved, remaining, progress, nominalWithDeficit}[]`;
  `history({accountId?, goalId?}?, manager?)` → `SavingsEntry[]`; `warnings()` → `string[]`.
- Lecturas y escrituras comparten `TransactionRunner`; manager opcional permite composición
  atómica sin transacción anidada. `SavingsService` es la única aritmética de reservas.
  Importes API son bigint; JSON CLI lista/historial los serializa como cadenas menores.
  El historial tiene orden estable `createdAt, sourceKey` (empates no implican orden causal).

Rollout **solo en rutas temporales/ficticias**, no en la base real: detener backend →
backup del prefijo completo A/B1/B2/B3 → restaurar en ruta nueva → apuntar `DATABASE_PATH`
allí → compilar → `migration:run` → comparar historial/saldos anteriores → probar B4 →
backup/restaurar B4 y comparar metas/historial/disponibles. No borrar/recrear el original.
No se reaudita A. B4 está aceptado tras su revisión obligatoria de solo lectura sin hallazgos.

```bash
npm run typecheck
npm run build
npm test -- --runInBand test/savings.service.spec.ts test/savings-migration.spec.ts test/savings-telegram.spec.ts
npm test -- --runInBand test/savings-cli.spec.ts
npm run test:e2e -- --runInBand
```

### Unidad 1: dominio de deudas (en curso, sin acceso por CLI ni Telegram)

**Alcance de esta unidad: solo el dominio, la migración y sus invariantes.** No hay comando
de CLI, ni captura por lenguaje natural, ni comando de Telegram: esas superficies llegan en la
unidad 2. Hasta entonces este dominio **no es accesible desde la aplicación**; nada de lo que
se describe aquí está aceptado técnicamente.

Es el seguimiento de una obligación con la política explícita **«Seguimiento y contabilidad»**:

- **Crear es solo una obligación.** `DebtService.create` guarda la deuda (UUID, `sourceKey`
  única e inmutable, dirección `payable|receivable`, contraparte, moneda, principal positivo
  `TEXT` exacto, fecha, descripción) y **no crea movimientos, cuentas, saldos, presupuestos
  ni reservas**. No hay edición ni borrado de deudas, intereses, netting ni clasificación del
  origen: un préstamo es simplemente una deuda `payable`.
- **Cada pago es un movimiento ordinario.** `DebtService.settle` registra un **gasto** si la
  deuda es `payable` y un **ingreso** si es `receivable` (también en préstamos), con la cuenta
  y la moneda del pago, y lo liga a la deuda en la **misma transacción**: o se guardan el
  movimiento y el vínculo, o no se guarda ninguno. Cuenta activa y moneda coincidente los
  comprueba `FinancialService.register`; la moneda del pago debe ser la de la deuda y el pago
  no puede ser anterior a la fecha de la deuda.
- **Concurrencia explícita.** El pago declara `expectedOutstandingMinor` (el pendiente que el
  llamador vio): debe coincidir con el pendiente actual, y el importe debe ser `0 < importe <=
  pendiente`. Un pago obsoleto o que excede el principal se rechaza sin escribir.
- **Contraparte sin fusiones.** La comparación es exacta y canónica (NFD sin diacríticos,
  minúsculas y espacios colapsados); la forma mostrada se conserva. No hay coincidencia
  difusa ni se elige "la primera": el filtro devuelve todas las obligaciones que coinciden.
- **Corrección: anular y pagar de nuevo.** El movimiento de un pago **no se edita** (el veto
  vive en `FinancialService.saveRevision`); **anularlo sí** y reabre automáticamente la deuda:
  el pendiente vuelve a subir y las cuentas y los reportes vuelven a su estado anterior. El
  replay de la clave original devuelve siempre el pago y el movimiento **originales**, incluso
  anulados, y nunca crea un sustituto.
- **Estado derivado, nunca guardado.** `pagado` son los movimientos efectivos no anulados
  ligados a la deuda (única fuente: `FinancialService.effectiveMovements`); `pendiente` es el
  principal menos lo pagado, y el estado es `open`, `partial` o `paid`. No hay corte por
  fecha: se cuentan todos los pagos registrados.

API (módulo `DebtsModule`, importes en `bigint`, `manager?` transaccional):

- `DebtService.create({ sourceKey, direction, counterparty, money: { currency, minor }, occurredOn, description? }, manager?)` → `{ debt, created }`.
- `DebtService.settle({ sourceKey, debtId, accountId, money, occurredOn, expectedOutstandingMinor, description? }, manager?)` → `{ payment, movement, created }`.
- `DebtService.get(id, manager?)` → `{ debt, paidMinor, outstandingMinor, status, payments }`;
  `list({ direction?, currency?, counterparty?, status? }?, manager?)` → el mismo tipo de vista.

Pruebas dedicadas (solo SQLite temporal, sin proveedores ni base real):
`test/debt.service.spec.ts` y `test/debt-migration.spec.ts`.

```bash
npm run typecheck
npm run build
npm test -- --runInBand test/debt.service.spec.ts test/debt-migration.spec.ts
```

### Unidad 2 (deudas): conversación, captura y bot (en curso, sin CLI y sin aceptación global)

**Alcance de esta unidad: la conversación, la captura durable y el bot.** El dominio de
deudas es el de la unidad 1 (sin cambios). Aquí las deudas **se crean, se pagan y se
consultan escribiendo en lenguaje natural**. La CLI de deudas, la documentación final y el
cierre (unidad 3) **no** están: nada de lo que se describe aquí está aceptado técnicamente.

- **Un solo objeto `debt` en la respuesta del modelo.** El esquema estricto (Zod) gana
  los tipos `debt_create`, `debt_settle` y `debt_query` y un único objeto `debt`
  **anulable** con todas sus propiedades obligatorias y anulables: `direction`
  (`payable`/`receivable`), `counterparty`, `debtId`, `settlementMode`
  (`partial`/`full`) y `status` (`open`/`partial`/`paid`). La forma de la respuesta no
  depende del tipo de operación: el JSON Schema que se envía al proveedor se deriva del
  mismo esquema y sale sin `additionalProperties` y con todo en `required`.
- **Crear una deuda no mueve dinero.** «le debo 8$ a Carmen de dos tortas» es una deuda
  `payable` y «Carmen me debe 8$» una `receivable`: se registra la obligación con su
  principal, su contraparte, su moneda y su fecha (la del mensaje en Caracas si el
  modelo no da otra). **No hay cuenta, ni movimiento, ni saldo.** El `/confirm` devuelve
  el id de la deuda en la respuesta durable.
- **Pagar una deuda sí mueve dinero**, con las reglas del dominio: gasto si la deuda es
  `payable`, ingreso si es `receivable`, en la moneda de la deuda, en una cuenta activa de
  esa moneda y con la fecha **posterior o igual** a la de la deuda. El movimiento y el
  vínculo se escriben en la **misma transacción** que el cierre del borrador, y la
  respuesta durable lleva el id de la deuda, el del pago y el del movimiento.
- **El pendiente se congela al preparar el pago.** Un pago parcial («le pagué 3
  dólares») lleva un importe positivo y explícito; un importe que coincide con el
  pendiente salda la deuda igual. Un pago **total** («ya le pagué todo», «lo pagué
  completo», «ya saldé la deuda») lo autoriza **el texto del usuario**: sin esa frase
  el backend pregunta el importe, **aunque el modelo diga que el pago fue total**. La
  autorización se guarda en el borrador (`fullIntent`) y se conserva al aclarar la
  cuenta, incluso tras reiniciar; se pierde si cambia el objetivo (otra deuda u otra
  persona), salvo que el mensaje nuevo vuelva a pedirlo. Los borradores anteriores a
  ese campo se leen **sin** autorización: un borrador viejo nunca paga todo por su
  cuenta. Si entre el resumen y el `/confirm` cambia el pendiente (otro pago o una
  anulación), el `/confirm` **se rechaza**: no se paga un total nuevo en silencio y hay
  que volver a preparar el pago. Si el mensaje no dice la moneda del pago, se usa la de
  la deuda (el usuario ya señaló esa deuda); si dice otra, se pregunta y no se paga.
- **La deuda destino la resuelve el backend, no el modelo.** Los ids que el usuario
  **escribe en el mensaje actual** mandan sobre el borrador vivo: si escribe uno, se
  usa ese (y tiene que encajar con la contraparte, la dirección y la moneda que pide el
  mismo mensaje); si escribe varios, se pregunta cuál y no se elige ninguno. El id del
  borrador vivo solo sirve si el mensaje actual no trae ninguno **y** sigue siendo
  compatible (misma contraparte, dirección y moneda): si el usuario cambia de persona,
  se busca de nuevo entre todas las deudas. Un id propuesto por el modelo nunca resuelve
  nada. Sin id, la deuda se busca por contraparte, dirección y moneda exactas
  (comparación canónica del dominio); si hay varias, se pregunta con una lista acotada
  de ids y el usuario elige; si falta la contraparte, la dirección o la moneda, se
  pregunta y no se inventa nada.
- **La consulta es de solo lectura.** «cuáles son mis deudas», «quién me debe» o «qué le
  debo a Carmen» se responden con los datos guardados, **sin llamar al modelo para la
  cuenta** y **sin tocar el borrador pendiente**: la fila del borrador queda byte por byte
  igual. Las consultas se atienden **antes** que cualquier conversión, operación múltiple
  o descarte. `/debts` y `/debts <id>` hacen lo mismo desde el comando, con el mismo
  formateador (`src/debts/debt-format.ts`): separa lo que debo de lo que me deben, muestra
  id, contraparte, original, pagado, pendiente y estado, y da totales **por dirección y
  moneda, nunca compensados** entre direcciones ni entre monedas.
- **Salvaguarda determinista.** Si el mensaje habla de una deuda («debo», «me debe»,
  «adeudo», «préstamo») pero el modelo lo clasifica como gasto o ingreso, **no se registra
  nada**: se pregunta qué quiso decir. Un gasto normal con un comercio no se confunde con
  una deuda.
- **El borrador vive en la misma tabla `capture`.** No hay un estado pendiente nuevo ni una
  tabla nueva: la migración `DebtCapture1788566400000` (B6) **solo añade** la columna de
  texto `debtPayload`, con el JSON del borrador validado por esquema antes de usarlo (un
  JSON roto se pide de nuevo, sin mostrar nada del mensaje original). El texto original se
  borra igual que en las operaciones ordinarias, y la revocación de Telegram sigue
  cancelando el borrador por su origen.
- **El contexto del modelo está acotado.** El mensaje del usuario va **entero**; lo que se
  recorta es el contexto (cuentas, deudas candidatas y borrador), siempre por líneas
  enteras y **avisando**: si la lista de deudas se corta, el modelo no debe elegir ninguna
  y el backend sigue viendo la lista completa. El tope de contexto es propio y fijo; no se
  toca el límite de entrada ni el de salida.

Pruebas dedicadas (solo SQLite temporal, sin proveedores ni base real):
`test/debt-capture.spec.ts`, `test/debt-telegram.spec.ts` y las pruebas de esquema y
prompt en `test/openrouter.interpreter.spec.ts`.

```bash
npm run typecheck
npm run build
npm test -- --runInBand test/debt-capture.spec.ts test/debt-telegram.spec.ts test/debt-migration.spec.ts test/openrouter.interpreter.spec.ts
```

### Aceptación técnica local de B y validación integrada (2026-11-11)

**B1, B2, B3 y B4 aceptados:** cada unidad pasó la revisión obligatoria de solo lectura
sin hallazgos. El orquestador validó independientemente el conjunto en **Node 24**:

```bash
npm run typecheck && npm run build && npm test -- --runInBand && npm run test:e2e -- --runInBand && git diff --check
```

| Comprobación | Resultado integrado |
| --- | --- |
| `npm run typecheck` | Sin errores de tipos |
| `npm run build` | Compilación correcta |
| `npm test -- --runInBand` | **29 suites y 318 pruebas aprobadas** |
| `npm run test:e2e -- --runInBand` | **1 suite y 8 pruebas aprobadas** |
| `git diff --check` | Sin errores de espacios; solo avisos LF/CRLF de Windows |

Esta evidencia sustituye los recuentos parciales previos de B. Los avisos de
red/cancelación proceden de fallos simulados; no hubo llamadas a proveedores reales
ni migración de la base real. No se hicieron commits/push ni una nueva auditoría de A.
**B está completada técnicamente en local solo en el alcance documentado:** escrituras
B manuales por CLI con el bot detenido y cerrojo, consultas Telegram deterministas y
advertencias de reservas al confirmar la captura existente. No acredita flujos B
completos en lenguaje natural, pruebas de proveedores reales ni preparación para producción;
Angular sigue fuera de esta entrega.

## Copias de seguridad y restauración

- La copia se hace con la **API de backup de SQLite**, no copiando el archivo `.sqlite` a
  pelo: el resultado es consistente aunque la base esté en modo WAL.
- La copia se escribe primero en un archivo temporal y se **publica con creación
  exclusiva**: si el destino aparece mientras se copia, la copia **falla** en vez de pisarlo.
- El destino debe ser un archivo **nuevo**. Por defecto no se pisa nada; `--force` reemplaza
  el destino.
- El destino no puede ser la propia base (ni un alias suyo): se comparan las rutas
  canónicas, así que un enlace simbólico a la base no la destruye.
- La copia se **valida** antes de terminar: `integrity_check` debe dar `ok` y el esquema
  debe tener las tablas y las migraciones del proyecto.
- La restauración **siempre es en una ruta nueva**: la base actual nunca se sobrescribe. La
  copia de origen también se valida antes de restaurar.
- El backend debe estar **detenido**: el cerrojo de una sola instancia lo impide. Si el
  backend está corriendo, la copia falla.

Se aceptan copias completas de A y de B1. Si figura la migración B1, debe existir
`ledger_operation`, y viceversa. Una copia A sigue siendo válida sin esa tabla.
Para volver a trabajar con una base restaurada, apunta `DATABASE_PATH` a la ruta nueva y
aplica las migraciones pendientes antes de iniciar el backend. Un backup B1 conserva
operaciones, comisiones, IDs y saldos.

También se aceptan copias B2: el marcador de migración y **ambas** tablas
`movement_revision`/`balance_reconciliation` deben estar presentes juntos y requieren B1.
Las copias B2 conservan originales, revisiones, anulaciones y deltas de conciliación.

Las copias B3 requieren juntos `budget` y `Budgets1780617600000`, además de B2/B1
completos. Conservan las definiciones y los mismos reportes efectivos al mismo corte.
Los prefijos completos A/B1/B2 siguen siendo restaurables y se migran después.

Las copias B4 requieren juntos `goal`, `savings_entry` y `GoalsAndSavings1783209600000`,
además de B3/B2/B1 completos. Se rechazan marcadores/tablas parciales; los prefijos
completos A/B1/B2/B3 siguen siendo restaurables. B4 conserva metas, historial virtual,
IDs, replay y disponibles al mismo día/actividad financiera (no es un corte histórico).

Las copias B5 requieren juntos `debt`, `debt_payment` y `Debts1785888000000`, además de
B4/B3/B2/B1 completos.

Las copias B6 requieren la columna `debtPayload` de `capture` **junto** a su migración
`DebtCapture1788566400000`, que a su vez exige B5. Se rechaza el marcador o la columna
sueltos. Los prefijos completos A/B1/B2/B3/B4/B5 siguen siendo restaurables y se migran
después: la migración es aditiva y no reescribe los borradores anteriores (la columna
nueva queda en `null`).

## Cerrojo de una sola instancia

Solo un proceso puede escribir en la base. El cerrojo es un directorio junto al archivo
SQLite (`<DATABASE_PATH>.lock`) con un `owner.json` que guarda el pid del dueño. La ruta se
**canoniza** (se resuelven los enlaces simbólicos y la capitalizacion real del disco), así que
un alias de la base no esquiva el cerrojo.

- Se toma **antes** de abrir la base y antes de hablar con Telegram, tanto en el backend
  como en la CLI.
- Si el directorio del cerrojo ya existe, el proceso **se niega a arrancar**. No hay
  recuperación automática: puede que haya otra instancia viva, puede que el proceso
  anterior muriera de golpe y puede que el pid se haya reutilizado. Un cerrojo **nunca** se
  roba.
- **Recuperación manual**: comprueba que no haya ningún proceso con ese pid (o que ninguna
  otra instancia esté escribiendo) y borra el directorio a mano:

  ```bash
  # Linux/macOS
  ps -p <pid>            # ¿ese proceso sigue vivo?
  rm -rf data/locha.sqlite.lock
  ```

- El supervisor de desarrollo (`npm run start:dev`) sí borra el cerrojo cuando su proceso
  hijo termina: ahí sabe con certeza que no queda nadie escribiendo.

## Reglas del dominio

- **Importes exactos, sin `float`.** El dinero se maneja en unidades menores con `bigint`
  (`123456n` = 12.3456 USD) y se persiste como texto canónico en la columna `amountMinor`
  (`text`). El registro de monedas y sus escalas vive en `src/domain/money.ts` (VES/USD:
  2 decimales, USDT: 6).
- **Fechas canónicas** `YYYY-MM-DD` en la columna `occurredOn` (`text`): `src/domain/date.ts`
  valida que la fecha exista en el calendario. La fecha se guarda sin hora ni zona: el día
  por defecto es el del mensaje en **America/Caracas** (`UTC-4`), y solo cuando el mensaje
  no aporta fecha.
- **Idempotencia por `sourceKey`.** Registrar dos veces la misma clave con el mismo contenido
  devuelve el movimiento existente; con contenido distinto devuelve `ConflictError`.
- **Cuentas activas y de la misma moneda.** Un movimiento se rechaza si la cuenta no existe,
  está inactiva o opera en otra moneda.
- **Una sola transacción a la vez.** SQLite admite una transacción activa por conexión:
  `TransactionRunner` (`src/data/transaction.runner.ts`) serializa las transacciones del
  proceso sobre una cola por `DataSource`. Si se entrega un `EntityManager`, el registro no
  abre otra transacción (no anida).
- **Las lecturas también pasan por la cola.** `recent()`, `summary()` y `list()` se ejecutan
  dentro del `TransactionRunner`: nunca ven el estado anterior a un commit en curso.

## Captura de operaciones (unidad 2)

`src/capture/capture.service.ts` expone una API de transporte, no de Telegram:

```ts
interface CaptureRequest {
  eventId: string;   // identidad del evento; la entrega la fuente autorizada
  chatId: string;    // conversación (chat o canal)
  text: string;
  receivedAt: string;// marca de tiempo del mensaje
}

interface CaptureOutcome {
  eventId: string;
  chatId: string;
  captureState: 'awaiting_details' | 'awaiting_confirmation' | 'registered' | 'cancelled' | 'unsupported' | null;
  reply: string;     // respuesta durable al usuario
  replayed: boolean; // el evento ya estaba procesado
  movementId: string | null;
}

captureService.handle(request): Promise<CaptureOutcome>;
```

El evento es **idempotente**: repetir el mismo `eventId` en la misma conversación reproduce la
respuesta guardada, sin volver a interpretar ni volver a gastar. La bandeja (`capture_event`)
es la única fuente de esa identidad. El bot usa `telegram:<update_id>` como `eventId`.

### Reglas conservadoras del backend

Estas reglas se derivan de los principios del plan (no inventar información, las transferencias
no son gastos, la IA no modifica saldos). Son una decisión conservadora del backend ante la
ambigüedad, no una preferencia personal:

- **Nada se registra sin `/confirm`.** Siempre se muestra un borrador validado por el backend
  y se espera una confirmación explícita. Esto también protege de las alucinaciones del modelo:
  lo que se registra es lo que el usuario vio.
- **`/confirm` exige un resumen vigente.** Solo se registra un borrador en estado
  `awaiting_confirmation`. Si el último mensaje no dejó un resumen completo (por ejemplo, el
  modelo no pudo interpretarlo), `/confirm` no registra nada: hay que enviar la operación otra
  vez para ver el resumen y solo entonces confirmar.
- **Nunca se inventan datos.** Si falta el importe, la moneda o la cuenta se pregunta; la
  cuenta nunca se deduce sola.
- **La fecha solo tiene valor por defecto cuando el mensaje no aporta fecha:** la del mensaje en
  `America/Caracas`. Cualquier otro valor no nulo se conserva: si el modelo da una fecha vacía,
  en blanco o que no existe (por ejemplo `2026-02-30`), no se sustituye en silencio — se pide
  una fecha válida y la operación no se puede confirmar hasta tenerla.
- **Solo ingresos y gastos.** Una conversión o transferencia nunca es un movimiento: se rechaza
  tanto si el modelo la clasifica como `transfer` como si el texto la describe de forma
  explícita. La detección del texto es determinista y no depende del modelo; cubre el cambio de
  moneda (“cambié 50 USDT por bolívares”, “convertí 100 USD a VES”, “pasé 50 USD a VES”), la
  transferencia entre cuentas con verbo explícito (“transferí 50 USD de Efectivo a Banco”,
  “trasladé 50 USDT a la cuenta Banco”, “moví 50 USD de Efectivo a Banco”) y el paso de dinero
  entre cuentas nombradas (“de la cuenta Efectivo a la cuenta Banco”). El sustantivo
  “transferencia” solo cuenta como movimiento si el mensaje dice adónde va el dinero
  (“transferencia de 100 USD a la cuenta Banco”): “pagué por transferencia” es un medio de pago
  de un gasto normal y no se rechaza.
- **Un mensaje, una operación.** Si el mensaje describe varias operaciones se pide reescribirlo;
  nunca se guarda solo la primera.
- **Las deudas también se registran por aquí** (unidad 2): «le debo 8$ a Carmen» crea la
  obligación **sin mover dinero** y «le pagué 3 dólares a Carmen» la paga con un movimiento
  ordinario. Una consulta de deudas es de solo lectura y no toca el borrador pendiente.
  El detalle está en la sección «Unidad 2».
- **`/confirm` y `/cancel` son deterministas**: no llaman al modelo.
- **Los fallos internos no se muestran.** Si el registro falla por un error inesperado, la
  respuesta al usuario es genérica; solo se muestran los errores de dominio conocidos (cuenta
  inactiva, moneda incoherente, conflicto de clave).

### Estados

El borrador de una conversación (`capture`) vive en uno de estos estados:

| Estado                 | Significado                                                     |
| ---------------------- | --------------------------------------------------------------- |
| `awaiting_details`     | Faltan datos: se piden y se espera la aclaración                |
| `awaiting_confirmation`| Borrador completo: se espera `/confirm`                          |
| `registered`           | El movimiento quedó registrado                                   |
| `cancelled`            | El usuario descartó el borrador con `/cancel`                    |
| `unsupported`          | El mensaje no es registrable (conversión, varias operaciones...) |

Solo hay **un borrador vivo por conversación** (índice único parcial en la migración). El
`sourceKey` del borrador es el del movimiento que se registrará al confirmar y no cambia aunque
el borrador se corrija. El texto original solo se guarda mientras el borrador está vivo: en los
estados terminales se borra.

### Atomicidad y concurrencia

- Movimiento + borrador + cierre del evento se escriben en **una sola transacción** del
  `TransactionRunner` compartido. La respuesta al usuario se devuelve **después** del commit.
- El `handle` completo se serializa por conexión: no hay dos inferencias ni dos escrituras
  simultáneas sobre el mismo borrador.
- **Nunca se mantiene una transacción abierta durante la llamada al proveedor.** La reserva de
  presupuesto y la inferencia son pasos separados.
- Si la inferencia se interrumpe (timeout, respuesta inválida, rechazo), el evento queda
  `uncertain`, la reserva se consume y el sistema **no reintenta solo**.
- **Una corrección fallida cancela el borrador anterior.** Cuando la interpretación de un
  mensaje falla, el borrador vivo de la conversación se cancela en la misma transacción y el
  usuario tiene que **reenviar la operación completa**. Es una decisión de seguridad
  financiera: un `/confirm` posterior no puede confirmar el borrador anterior a una
  corrección que no se pudo interpretar.

### Interpretación (`src/interpreter`)

- Un único esquema de ejecución **zod** (`src/interpreter/operation.schema.ts`) define la
  respuesta del modelo; el JSON Schema que se manda al proveedor se **deriva** de ahí
  (`response_format` con `json_schema` y `strict: true`). La forma es cerrada: `amount`,
  `currency`, `accountId`, `kind` (`income`, `expense`, `transfer`, `unclear`, `unsupported`),
  `occurredOn` y `description`; todos admiten `null`. No se usan herramientas.
- Una sola llamada HTTP por mensaje, con espera acotada, entrada acotada y respuesta leída con
  un tope de bytes. **No hay reintentos automáticos.**
- El plazo abarca **toda** la llamada: las cabeceras y la lectura del cuerpo. Si el proveedor
  manda las cabeceras y luego se queda colgado, la lectura se aborta y no se queda esperando
  para siempre. Los fallos de red, de cancelación y de lectura se informan sin detalle.
- No se registran secretos, mensajes del usuario ni respuestas del proveedor.

## Bot de Telegram (unidad 3)

`src/telegram/` contiene el bot. El transporte es la **API oficial de Telegram por HTTPS**
(`getUpdates` y `sendMessage`), con el token solo en la URL y **nunca en un log**.

### Autorización (falla cerrada)

1. La actualización debe ser un `message` (las editadas, las de canal y las de otros tipos se
   ignoran).
2. El chat debe ser **privado** (`chat.type === "private"`).
3. El chat debe ser el **chat autorizado** (`TELEGRAM_ALLOWED_CHAT_ID`).
4. El remitente debe ser el **usuario autorizado** (`TELEGRAM_ALLOWED_USER_ID`) y no un bot.
5. El mensaje debe ser **de texto**.

La autorización ocurre **antes** de guardar el texto, antes de interpretar y antes de
responder. Lo que no pasa el filtro no se guarda en ninguna tabla.

### Ciclo durable

| Tabla              | Para qué sirve                                                              |
| ------------------ | --------------------------------------------------------------------------- |
| `telegram_inbox`   | Actualizaciones aceptadas, con su `update_id` único y el texto original acotado |
| `telegram_outbox`  | Respuestas pendientes de enviar, con sus intentos y la hora del próximo intento |
| `telegram_cursor`  | Último `update_id` aceptado o ignorado                                        |

El ciclo tiene **tres pasos separados**: aceptar (durable), procesar y entregar.

- **Aceptar.** El cursor **solo avanza** después de aceptar o ignorar una actualización de
  forma durable. Si la aceptación falla, **se corta el lote**: el cursor no avanza y la
  actualización se vuelve a pedir en el sondeo siguiente.
- **Procesar.** El procesamiento sale **solo** de la lectura ordenada de la bandeja de
  entrada (por `update_id`): es la única vía, así que el orden durable se respeta siempre
  y un `/confirm` nunca se aplica a un borrador anterior a una corrección pendiente. Al
  arrancar se procesa lo pendiente antes de volver a consultar a Telegram, y lo que se
  acaba de aceptar se procesa en el mismo ciclo (sin esperar al siguiente). Si **no se
  puede leer** lo pendiente, no se procesa nada nuevo (sigue aceptando y entregando); si
  **no se puede limpiar** lo revocado, tampoco se procesa nada: hasta que la limpieza
  funcione no se toca ningún borrador. Si el procesamiento de una actualización falla, la
  actualización **se conserva** y **su chat queda bloqueado**: no se procesa nada más de
  ese chat, pero el bot **sigue sondeando, aceptando y entregando** lo que ya está
  listo. El bloqueo espera con una espera acotada (1 s, 2 s, 4 s… hasta 60 s)
  **independiente del sondeo**; al reiniciar se pierde (vive en memoria) y la
  actualización se vuelve a intentar desde el principio.
- **Entregar.** La respuesta se escribe en la bandeja de salida **después del commit de la
  captura**. Si el proceso se interrumpe justo ahí, al arrancar se vuelve a procesar la
  actualización: la captura es idempotente, así que **no se duplica ningún movimiento**.
- El envío es **“al menos una vez”**: si el proceso se interrumpe después de enviar y antes de
  marcar la entrega como hecha, la respuesta puede llegar **dos veces**. Es el comportamiento
  documentado y aceptado: preferimos repetir un texto antes que perderlo. Un movimiento
  nunca se duplica.
- Un envío fallido **no se pierde**: la respuesta sigue pendiente y se reintenta con una
  espera acotada (1 s, 2 s, 4 s… hasta 60 s). La hora del próximo intento se guarda en la
  base, así que el retraso se respeta también después de un reinicio. Solo se descarta una
  respuesta cuando Telegram la rechaza de forma definitiva (un 4xx que no sea 408 ni 429) o
  cuando el chat o el usuario **ya no están autorizados**.
- Las respuestas de un chat salen **en orden**: si una anterior está retrasada o falla de
  forma transitoria, las siguientes de ese chat esperan su turno (con su intento y su
  plazo guardados).
- Al recuperar trabajo pendiente se **vuelve a comprobar la lista de autorizados**, en una
  sola transacción: la actualización pendiente se descarta, la respuesta pendiente se
  descarta (con su texto vaciado) y el **borrador vivo cuya origen en Telegram ya no está
  autorizada se cancela** (para que un `/confirm` posterior no pueda confirmar un borrador
  revocado). La procedencia del borrador se busca por su **clave estable**, que está
  ligada a la actualización que lo creó: un borrador **nuevo** del usuario vigente no se
  cancela por las filas históricas de otro usuario del mismo chat, y los borradores de
  **otros transportes** (sin evidencia de que vengan de Telegram) no se tocan. Los
  movimientos ya registrados y el historial de eventos **no se tocan**.
- Lo que ya no está autorizado se descarta **antes** de mirar el plazo de reintento: su
  texto no se queda pendiente aunque la entrega estuviera retrasada.
- El texto original se borra de la bandeja de entrada cuando la actualización queda
  procesada, y el texto de una respuesta descartada se vacía.

### Red

- Cada llamada tiene un **plazo que cubre cabeceras y cuerpo**, y la respuesta se lee con un
  **tope de bytes** (`src/http/bounded-fetch.ts`, la misma utilidad que usa OpenRouter).
- Una respuesta con error **no se queda colgada**: su cuerpo se cancela y la llamada se
  aborta antes de soltar el plazo. La cancelación **no se espera**: una cancelación colgada
  no puede romper el plazo ni el apagado.
- Una lectura que termina **después de la cancelación no es una respuesta**: no se devuelve
  un resultado parcial.
- Los fallos de transporte se reintentan con una **espera acotada** (1 s, 2 s, 4 s… hasta
  60 s como máximo).
- Las actualizaciones se procesan **de una en una**.
- `SIGINT` y `SIGTERM` cierran el bot de forma ordenada: se corta el sondeo y el envío en
  vuelo, se espera a que terminen y se suelta el cerrojo. No queda trabajo suelto.

### Privacidad

- El token, el texto del usuario y las respuestas **no se registran nunca**.
- En la base solo queda lo necesario: el texto del mensaje mientras el borrador o la
  actualización están vivos; después se borra.
- Los errores que se guardan o se registran son un **motivo** (`timeout`, `network`, `http`),
  nunca el detalle.

## Scripts

| Comando                | Descripción                                              |
| ---------------------- | -------------------------------------------------------- |
| `npm run typecheck`    | `tsc --noEmit` sobre `src` y `test`                      |
| `npm run build`        | Compila a `dist/`                                        |
| `npm start`            | Levanta el backend (con el bot si está configurado)       |
| `npm run start:dev`    | Compila en modo watch y reinicia el backend al cambiar   |
| `npm test`             | Pruebas unitarias y de integración (Jest)                |
| `npm run test:e2e`     | Suite de extremo a extremo (Telegram y OpenRouter falsos)  |
| `npm run cli -- …`     | Comandos de línea sobre el mismo `DataSource`            |
| `npm run migration:run`| Aplica las migraciones pendientes                         |
| `npm run account:add`  | Crea una cuenta                                           |
| `npm run account:list` | Lista las cuentas                                         |
| `npm run backup`       | Copia de seguridad                                        |
| `npm run restore`      | Restaura una copia en una ruta nueva                      |

## Pruebas

`npm test` cubre: migración inicial (columnas `amountMinor` y `occurredOn` declaradas como
texto), migraciones (bandejas de Telegram y cursor), reapertura de la base con persistencia
de datos, importes exactos y grandes (`9007199254740993.99`), precisión sin `float`,
validación de fechas/monedas/cuentas, duplicados y conflictos por `sourceKey`, registros
paralelos, recuperación de la cola tras una transacción fallida, y totales por moneda (con
totales de un solo mes).

De la unidad 2: el interpretador contra un `fetch` simulado (respuesta estricta, JSON inválido,
estado de error, tiempo agotado —incluido el proveedor que manda las cabeceras y luego se
cuelga—, rechazo del modelo, respuesta desmedida, fallo de lectura saneado y configuración
ausente), y la captura con un interpretador de prueba (flujo completo de confirmación, que no se
registra nada antes de `/confirm`, `/confirm` sin resumen vigente, aclaración con el contexto del
borrador, persistencia del borrador entre reinicios, evento repetido que no vuelve a interpretar,
dos eventos iguales simultáneos, transferencias y conversiones —incluida “Transferí 50 USD de
Efectivo a Banco”— con cero escrituras, medio de pago (“pagué por transferencia”) que no se
confunde con un traslado entre cuentas, fecha inválida, vacía o en blanco que no se sustituye por
la de hoy (con controles de fecha válida y de fecha ausente), importes, cuentas y monedas
inválidos, presupuesto diario agotado, reversión de la escritura cuando el registro falla, error
inesperado que no filtra su detalle al usuario y clave de movimiento que no confunde conversación
con evento).

De la unidad 3: la configuración del bot (todo o nada, configuración parcial desactivada, ids no
numéricos), el cliente de la API de Telegram (offset y espera, envío, credencial ausente en los
errores, tiempo agotado, respuesta desmedida, sobre de la API inválido —no JSON, `ok: false` o
sin mensaje— que no se da por enviado, cuerpo de error cancelado, fecha fuera de rango que no
invalida el lote), el servicio de sondeo (autorización de chat y usuario, mensajes de grupo,
editados, de bot y sin texto, bandejas de entrada y de salida, actualización repetida, retraso
entre reintentos respetado también tras un reinicio, respuesta que no se pierde tras muchos
fallos, reanudación de lo pendiente, lote cortado cuando una actualización falla, trabajo
pendiente de un chat que ya no está autorizado que se descarta sin interpretar ni responder,
apagado ordenado que cancela el envío en vuelo), el **ciclo separado en tres pasos**
(actualización que no se puede procesar que se conserva y bloquea a las siguientes de su
chat sin dejar de sondear ni de entregar, recuperación en orden cuando el procesamiento
vuelve a funcionar, espera de reintento de procesamiento independiente del sondeo, entrega
por chat que no se adelanta cuando la anterior está retrasada o falla de forma transitoria,
fallo puntual de la bandeja de salida que no para el ciclo, respuesta que se reproduce sin
volver a interpretar cuando solo falla la creación de la bandeja de salida, revocación de un
chat que descarta lo pendiente y cancela su borrador sin tocar lo ya registrado, y chat
reautorizado que no puede confirmar un borrador revocado, **orden durable** (un `/confirm`
nuevo no se procesa mientras no se puede leer lo pendiente, y al recuperarse se registra la
corrección y no el borrador viejo; con la lectura o la limpieza fallando no se procesa
nada; el borrador se cancela por su procedencia, no solo por su chat), los comandos
deterministas (ayuda, cuentas, recientes con id, resumen del mes con totales exactos, mes
inválido, `/usage` con el
día de Caracas vacío, con consumo, con el límite alcanzado y con el cambio de día sin
modificar el estado, comando desconocido sin llamar al modelo), las llamadas HTTP acotadas
(cancelación normal, rechazada y colgada, tiempo agotado y cancelación externa sin éxito
parcial), el cerrojo de una sola instancia (doble instancia, cerrojo obsoleto que **no**
se roba, cerrojo desconocido, alias por enlace simbólico y **exclusión entre procesos** con
un proceso limpio) y la copia de seguridad (copia válida, destino que ya existe, destino que
aparece durante la copia, alias de la base que no se destruye, restauración en ruta nueva,
archivo inválido).

`npm run test:e2e` ejecuta el flujo completo con un **Telegram simulado** y un **OpenRouter
simulado**: mensaje → aclaración → `/confirm` → **un** movimiento → `/summary`; actualización
repetida (no duplica el movimiento); usuario no autorizado (no guarda nada); trabajo pendiente de
un chat que ya no está autorizado (se descarta sin interpretar ni responder); reanudación tras un
reinicio; fallo de envío (se reintenta); y copia de seguridad + restauración con los mismos
totales. **Ninguna prueba hace llamadas externas ni usa credenciales reales.**

## Límites conocidos de esta entrega

- **Captura IA solo de ingresos y gastos.** Las transferencias/conversiones se registran
  únicamente por CLI B1; Telegram no las registra ni por texto ni por comandos.
- **Correcciones solo por CLI B2.** Telegram consulta el historial; no edita ni anula.
  Aperturas y principales transferidos no admiten corrección/anulación en B2.
- **Mutadores B manuales por CLI.** Presupuestos, metas, reservas y liberaciones no
  admiten captura natural ni escritura Telegram. Reservas nominales pueden perder
  respaldo; se registra y advierte, no se bloquean gastos ni se liberan automáticamente.
- **`/summary` no es un saldo.** Son los totales de actividad del mes; no incluye
  aperturas ni principales transferidos. `/balances` conserva cada moneda sin valorarla.
- **Las fechas son días, no instantes.** Se guarda `YYYY-MM-DD`; el día por defecto es el del
  mensaje en America/Caracas.
- **Un usuario, una instancia.** El bot está pensado para un usuario personal y una sola
  instancia local; no hay multiusuario, ni roles, ni web.
- **El modelo no está validado.** El modelo de OpenRouter lo elige el operador y su calidad
  con frases reales está pendiente de comprobación manual.
- **El límite de gasto es del operador.** El allowance local es conservador pero no es la
  factura: hay que fijar también el límite de gasto en la cuenta de OpenRouter.
- **El texto del mensaje se conserva solo mientras hace falta**: 1000 caracteres en el borrador
  de la captura y 4096 en la bandeja de entrada de Telegram; después se borra.
- **Sin copia de seguridad automática.** La copia es un comando manual (`npm run backup`).
- **Las fotos y los documentos no se procesan.** El bot solo entiende texto.
- **El bloqueo por chat vive en memoria.** Si el bot se reinicia con una actualización a
  medias, se vuelve a intentar desde el principio: no se guarda el contador de intentos.
  Lo que hay pendiente se lee siempre de la base: el bloqueo es solo un reloj de espera.
- **La procedencia de un borrador se busca en Telegram.** Un borrador creado por otro
  transporte (sin fila en la bandeja de entrada de Telegram) no se cancela al revocar un
  chat: no hay evidencia de que sea de este transporte.
- **Una corrección fallida pide reenviar la operación completa.** El borrador anterior se
  cancela a propósito, para que un `/confirm` no pueda registrar algo que el usuario ya
  había corregido.
- **La revocación se aplica al arrancar.** La lista de autorizados se lee al construir el
  bot y no cambia durante la ejecución: el trabajo pendiente de un chat revocado se limpia
  en el primer ciclo, no en caliente.
- **El requisito de Node 24 sigue en pie.** La validación integrada de B1–B4 se
  completó en Node 24; la evidencia completa histórica de A se conserva abajo.

## Plan técnico de cierre (Etapa A, registro histórico)

Cerrar la Etapa A es una lista corta y verificable. Lo que ya está hecho, revisado
localmente y comprobado con pruebas automáticas:

1. **Ciclo durable en tres pasos** (aceptar, procesar, entregar): todo el procesamiento sale
   de la lectura ordenada de lo pendiente, así que un `/confirm` nunca se aplica a un
   borrador anterior a una corrección pendiente; si no se puede leer lo pendiente o no se
   puede limpiar lo revocado, no se procesa nada; una actualización que no se puede
   procesar se conserva y bloquea a las siguientes de su chat sin dejar de sondear ni de
   entregar; las respuestas de un chat salen en orden; lo revocado se limpia en una sola
   transacción sin tocar lo ya registrado.
2. **Captura conservadora**: una interpretación fallida cancela el borrador vivo y pide
   reenviar la operación completa; `/confirm` sigue siendo obligatorio y nunca duplica un
   movimiento.
3. **`/usage` determinista**: solo lee la reserva local del día, nunca llama al proveedor
   ni reserva nada.
4. **Llamadas HTTP acotadas**: una cancelación colgada no puede romper el plazo ni el
   apagado, y una lectura cancelada no devuelve un resultado parcial.
5. **Cerrojo de una sola instancia**: la exclusión entre procesos está comprobada con un
   proceso limpio; la recuperación de un cerrojo obsoleto sigue siendo manual.

Lo que falta para cerrar la Etapa A (tareas del operador, no automatizables en el código y
**no bloquean** el cierre del código):

- **Validar el modelo con frases reales** contra el proveedor y elegirlo de forma
  definitiva.
- **Probar contra la API real de Telegram** con un bot de pruebas y sin datos financieros
  reales.
- **Revisión de preparación para producción**: leer el código con criterio de seguridad y
  decidir si la entrega puede usarse con datos reales. Una revisión no equivale a
  producción.
- **Ejecutar la suite en Node 24**, que es la versión que exige `package.json`.

### Evidencia de la aceptación técnica local (2026-11-10)

Revisión final del código sin hallazgos y comprobación local en Node 22.22.3:

| Comprobación | Resultado |
| --- | --- |
| `npm run typecheck` | Sin errores de tipos |
| `npm run build` | Compilación correcta |
| `npm test -- --runInBand` | 15 suites y 184 pruebas, todas en verde |
| `npm run test:e2e -- --runInBand` | 7 pruebas, todas en verde |
| `git diff --check` | Limpio |

Esto acredita el **código** de la Etapa A en local; **no habilita el uso operativo**: los
avisos de arriba siguen vigentes (datos reales, proveedores reales, Node 24 y revisión de
preparación para producción).

El registro anterior corresponde al cierre histórico de A y no reabre su aceptación.
B1/B2/B3/B4 están aceptados técnicamente en local; B está completada en el alcance
manual CLI y consultas/advertencias Telegram documentado, no como habilitación operativa.
