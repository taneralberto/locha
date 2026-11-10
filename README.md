# Locha — Asistente financiero personal con IA

Backend NestJS + TypeORM + SQLite. Estado actual: **Etapa A en desarrollo**. Las
**unidades 1 y 2 están aceptadas**; la **unidad 3 está implementada, pero pendiente de
correcciones y revisión** (todavía no se da por aceptada). Las tres unidades son parte
del [plan general](plan-general-asistente-financiero-ia.md):

- **Unidad 1** — contexto de aplicación ejecutable, modelo mínimo de cuentas y
  movimientos, migraciones, reglas monetarias exactas y un servicio de registro
  idempotente. **Aceptada.**
- **Unidad 2** — interpretación estructurada con OpenRouter y servicio de captura durable
  (independiente del transporte). **Aceptada.**
- **Unidad 3** — bot de Telegram por *long polling* en un chat privado, consultas
  deterministas, entrega durable de las respuestas, cerrojo de una sola instancia y
  copia de seguridad con restauración. **Implementada, pendiente de correcciones y
  revisión.**

> **Aviso: no uses datos financieros reales todavía.** La unidad 3 tiene problemas
> conocidos que aún no se han corregido ni revisado. Las categorías pendientes son:
>
> - **Carrera del cerrojo obsoleto** (`src/lock/instance-lock.ts`): la comprobación y la
>   toma del cerrojo no son atómicas, así que dos procesos pueden acabar escribiendo en
>   la misma base.
> - **Pérdida de actualizaciones en el sondeo** (`src/telegram/telegram.service.ts`): una
>   actualización aceptada cuyo procesamiento falla puede quedar sin atender después de
>   que el cursor ya haya avanzado.
> - **Autorización en la recuperación** (`src/telegram/telegram.service.ts`): al retomar
>   trabajo pendiente, la revalidación del chat y del usuario autorizados no cubre
>   todos los caminos.
> - **Planificación de reintentos** (`src/telegram/telegram.service.ts`): la espera entre
>   reintentos y el contador de intentos no se gestionan con fiabilidad en todos los
>   caminos.
> - **Limpieza HTTP** (`src/http/bounded-fetch.ts`): la cancelación del cuerpo de una
>   respuesta que no se va a leer no siempre libera la conexión.
>
> Hasta que se corrijan y se revisen, **no introduzcas datos financieros reales** en esta
> instalación: usa solo datos de prueba. Esta entrega **no ha pasado una revisión de
> preparación para producción** y no debe usarse con datos reales.

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
| `/recent`              | Lista los últimos movimientos, con su **id de movimiento**      |
| `/summary`             | Totales del mes actual                                           |
| `/summary 2026-11`     | Totales de un mes concreto (`YYYY-MM`)                           |
| `/confirm`             | Registra la operación que te acaba de mostrar                    |
| `/cancel`              | Descarta la operación pendiente                                  |

Cualquier otro comando con `/` muestra la ayuda. **Las consultas nunca llaman al modelo**:
`/accounts`, `/recent` y `/summary` se calculan con los datos guardados.

`/summary` muestra los **totales de la actividad registrada** en el mes (ingresos, gastos y
neto por moneda) con importes exactos. **No son el saldo de tus cuentas**: no hay saldos
iniciales ni transferencias todavía.

La respuesta de un registro incluye el **id del movimiento** (`Movimiento: <id>`), que es el
mismo que aparece en `/recent`.

## Base de datos

El esquema solo cambia por migraciones: `synchronize` está desactivado en
`src/data/data-source.ts`.

Migraciones: `InitialSchema1767225600000` (cuentas y movimientos),
`CaptureAndInference1769904000000` (capturas, bandeja de eventos y consumo diario) y
`TelegramDelivery1772582400000` (bandejas de Telegram y cursor del polling).

> La migración de Telegram todavía no se ha publicado: si ya tenías una base creada con una
> versión anterior de esta entrega, **borra el archivo `data/locha.sqlite` y vuelve a aplicar
> las migraciones** (la base es local y se puede regenerar; haz una copia antes si te importa).

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

Para volver a trabajar con una base restaurada, apunta `DATABASE_PATH` a la ruta nueva.

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
  `uncertain`, la reserva se consume y se responde “envíalo de nuevo o usa `/cancel`”. El
  sistema **no reintenta solo**.

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

- El cursor **solo avanza** después de aceptar o ignorar una actualización de forma durable.
- Si una actualización **no se puede atender, se corta el lote**: el cursor no puede
  avanzar más allá de una actualización que falló, y el sondeo vuelve a empezar en el
  cursor guardado.
- Al arrancar se **procesa lo pendiente** antes de volver a consultar a Telegram.
- La respuesta se escribe en la bandeja de salida **después** del commit de la captura. Si el
  proceso se interrumpe justo ahí, al arrancar se vuelve a procesar la actualización: la
  captura es idempotente, así que **no se duplica ningún movimiento**.
- El envío es **“al menos una vez”**: si el proceso se interrumpe después de enviar y antes de
  marcar la entrega como hecha, la respuesta puede llegar **dos veces**. Es el comportamiento
  documentado y aceptado: preferimos repetir un texto antes que perderlo. Un movimiento
  nunca se duplica.
- Un envío fallido **no se pierde**: la respuesta sigue pendiente y se reintenta con una
  espera acotada (1 s, 2 s, 4 s… hasta 60 s). La hora del próximo intento se guarda en la
  base, así que el retraso se respeta también después de un reinicio. Solo se descarta una
  respuesta cuando Telegram la rechaza de forma definitiva (un 4xx que no sea 408 ni 429) o
  cuando el chat o el usuario **ya no están autorizados**.
- Al recuperar trabajo pendiente se **vuelve a comprobar la lista de autorizados**: si el
  chat o el usuario ya no están en la configuración vigente, el mensaje se borra **sin
  interpretarlo y sin responder**.
- El texto original se borra de la bandeja de entrada cuando la actualización queda
  procesada.

### Red

- Cada llamada tiene un **plazo que cubre cabeceras y cuerpo**, y la respuesta se lee con un
  **tope de bytes** (`src/http/bounded-fetch.ts`, la misma utilidad que usa OpenRouter).
- Una respuesta con error **no se queda colgada**: su cuerpo se cancela y la llamada se
  aborta antes de soltar el plazo.
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
apagado ordenado que cancela el envío en vuelo), los comandos deterministas (ayuda, cuentas,
recientes con id, resumen del mes con totales exactos, mes inválido, comando desconocido sin
llamar al modelo), el cerrojo de una sola instancia (doble instancia, cerrojo obsoleto que **no**
se roba, cerrojo desconocido, alias por enlace simbólico) y la copia de seguridad (copia
válida, destino que ya existe, destino que aparece durante la copia, alias de la base que no se
destruye, restauración en ruta nueva, archivo inválido).

`npm run test:e2e` ejecuta el flujo completo con un **Telegram simulado** y un **OpenRouter
simulado**: mensaje → aclaración → `/confirm` → **un** movimiento → `/summary`; actualización
repetida (no duplica el movimiento); usuario no autorizado (no guarda nada); trabajo pendiente de
un chat que ya no está autorizado (se descarta sin interpretar ni responder); reanudación tras un
reinicio; fallo de envío (se reintenta); y copia de seguridad + restauración con los mismos
totales. **Ninguna prueba hace llamadas externas ni usa credenciales reales.**

## Límites conocidos de esta entrega

- **Solo ingresos y gastos.** Una conversión o transferencia entre cuentas o monedas no se
  registra; solo se avisa. Las transferencias llegan en la Etapa B.
- **No hay correcciones.** No se puede editar ni anular un movimiento: el flujo es
  “registrar y, si te equivocaste, avisar por otro canal”. La corrección y la anulación
  llegan en la Etapa B.
- **`/summary` no es un saldo.** Son los totales de la actividad registrada en el mes, sin
  saldos iniciales, sin transferencias y sin valor de mercado. No hay conversión de moneda.
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
