# Guía de puesta en marcha y pruebas — A aceptada, B1–B4 aceptados técnicamente en local

Para probarlo **no necesitas hosting, dominio ni webhook**: funciona localmente mediante *long polling* de Telegram. Tampoco hay interfaz web todavía.

**Etapa B completada en el alcance documentado:** B1, B2, B3 y B4 pasaron sus revisiones
obligatorias de solo lectura sin hallazgos y la validación integrada independiente del
orquestador. Todos los nuevos mutadores B son manuales por CLI local, con el bot detenido
y bajo el cerrojo de instancia única; Telegram ofrece consultas deterministas y advertencias
al confirmar ingresos/gastos de la captura existente. No son flujos B completos en lenguaje
natural ni pruebas de proveedores reales o preparación para producción. No hay Angular.
La aceptación de A se conserva sin reauditoría.

## 1. Requisitos

- **Node.js 24** y npm.
- Un bot creado con **@BotFather** y su token.
- Tu ID de Telegram: puedes consultarlo con **@userinfobot**.
- Una clave de **OpenRouter**, con saldo disponible, y un modelo que soporte salidas estructuradas `json_schema`.

**Guarda los tokens únicamente en `.env`; no los pegues en el chat.** Configura también un límite de gasto en OpenRouter: el presupuesto local no garantiza el importe facturado.

## 2. Instalar y configurar

Desde el proyecto:

```bash
cd /home/lukateric/dev/locha

node --version   # debe mostrar v24...
npm ci

# Crea .env únicamente si no existe:
test -f .env || cp .env.example .env
```

Edita `.env` y completa:

```dotenv
# Base separada para las pruebas manuales:
DATABASE_PATH=data/pruebas-etapa-a.sqlite

OPENROUTER_API_KEY=tu_clave
OPENROUTER_MODEL=id_del_modelo

TELEGRAM_BOT_TOKEN=token_del_bot
TELEGRAM_ALLOWED_USER_ID=tu_id_numerico
TELEGRAM_ALLOWED_CHAT_ID=tu_id_numerico
```

En un chat privado, ambos IDs normalmente coinciden. **La elección y compatibilidad real del modelo siguen pendientes de validar.**

## 3. Ejecutar las pruebas automáticas

No necesitan tokens, saldo ni conexión con los proveedores:

```bash
npm run typecheck
npm run build
npm test -- --runInBand
npm run test:e2e -- --runInBand
git diff --check
```

Validación integrada independiente del orquestador (2026-11-11, **Node 24**), tras la
aceptación de las cuatro revisiones B sin hallazgos. Comando exacto ejecutado:

```bash
npm run typecheck && npm run build && npm test -- --runInBand && npm run test:e2e -- --runInBand && git diff --check
```

Tipos y compilación correctos; **29 suites y 318 pruebas aprobadas**, más **1 suite e2e
y 8 pruebas aprobadas**. `git diff --check` sin errores de espacios, solo avisos LF/CRLF
de Windows. Esta es la evidencia vigente de B1–B4 y sustituye los recuentos parciales.
La evidencia histórica de A se conserva en README, sin reauditarla. Las suites CLI
compilan y usan procesos reales con bases temporales; ninguna prueba migra tu base
configurada ni usa proveedores reales. Sin commits/push.

## 4. Arrancar y probar desde Telegram

Primero prepara la base y las cuentas ficticias:

```bash
npm run migration:run

npm run account:add -- --name Efectivo --currency USD
npm run account:add -- --name Bolivares --currency VES
npm run account:add -- --name Cripto --currency USDT

npm start
```

Abre el chat de tu bot y prueba:

| Mensaje | Resultado esperado |
|---|---|
| `/help` | Muestra la ayuda |
| `/accounts` | Lista las tres cuentas |
| `/balances` | Saldos por cuenta a hoy en Caracas, sin llamar a IA |
| `Gasté 2 USD en helado de la cuenta Efectivo` | Presenta un borrador; todavía no registra |
| `/confirm` | Registra exactamente un movimiento |
| `/recent` | Muestra el movimiento y su ID |
| `/summary` | Muestra gastos de 2 USD |
| `/usage` | Muestra las reservas de consumo de IA |

Después comprueba:
- Un mensaje incompleto pide aclaración.
- `/cancel` descarta el borrador.
- Reiniciar con `Ctrl+C` y `npm start` conserva los movimientos.
- Una transferencia por texto sigue rechazándose sin registrarla como gasto: B1 solo
  permite escribir aperturas/transferencias mediante CLI determinista.

**Usa únicamente datos ficticios por ahora.** Para añadir cuentas, migrar o hacer backups, detén primero el backend. Estos pasos están contrastados con el `README.md`, `.env.example` y los comandos actuales del proyecto.

## 5. Probar solo B1 (sin IA)

Con el backend detenido y una **base de pruebas separada**:

1. Si actualizas desde A, haz primero `npm run backup -- --to data/copia-a.sqlite`
   (ruta nueva). Aplica `npm run migration:run`; no borres la base ni edites migraciones
   antiguas. Una copia A completa puede restaurarse en una ruta nueva y luego migrarse.
2. Ejecuta `npm run account:list` y copia los IDs de las cuentas ficticias USD y VES.
3. Sustituye `ID_USD` y `ID_VES` en estos comandos:

```bash
npm run opening:add -- --source-key prueba-b1-apertura --account ID_USD --currency USD --amount 100.00 --on 2026-11-01
npm run transfer:add -- --source-key prueba-b1-cambio --from ID_USD --from-currency USD --sent 50.00 --to ID_VES --to-currency VES --received 20000.00 --on 2026-11-02 --fee-account ID_USD --fee-currency USD --fee 0.50
npm run balance:list -- --on 2026-11-02
```

Sin actividad adicional: USD 49.50 y VES 20000.00. Si reutilizas las cuentas de la prueba
A, resta además el gasto ya registrado. La apertura es **aditiva**, no reemplaza el pasado.

Repite ambos comandos: deben mostrar el **mismo ID** y `existente`. Cambia el importe
con la misma clave: debe fallar con código 1. No hay edición/anulación en B1; revisa
los datos antes de escribir. La apertura es única por cuenta, puede ser negativa o cero.

Inicia `npm start` y consulta `/balances 2026-11-02`: mismos saldos sin inferencia.
`/summary 2026-11` y `/recent` no muestran el principal convertido como gasto/ingreso;
solo la comisión es gasto. Una consulta anterior excluye operaciones futuras. Las cuentas
sin apertura se identifican y pueden tener saldos incompletos o negativos.

Detén el backend, crea un backup B1, restaura en una ruta nueva, cambia `DATABASE_PATH`
a esa ruta y migra antes de arrancar: los saldos deben coincidir. B1 cubre aperturas,
transferencias y saldos; B2–B4, descritos a continuación, completan el alcance técnico
local documentado de B con correcciones/conciliación, presupuestos y metas/reservas.
No hay tasas automáticas ni suma de monedas distintas: se usan los principales reales
explícitos enviados y recibidos.

## 6. Probar B2 (sin IA, solo base ficticia)

No migres la base real durante la revisión. Detén el backend y selecciona una base de
pruebas mediante `DATABASE_PATH`. Haz backup A/B1 en una ruta nueva, actualiza/compila,
ejecuta `npm run migration:run` y conserva las migraciones antiguas sin modificarlas.
B2 añade `movement_revision` y `balance_reconciliation`, no cambia filas A/B1.

Con `ID_USD` de `account:list`:

```bash
npm run movement:add -- --source-key prueba-b2-original --account ID_USD --currency USD --kind expense --amount 2.00 --on 2026-11-01
npm run movement:show -- --movement ID_MOVIMIENTO
npm run movement:edit -- --source-key prueba-b2-edit --movement ID_MOVIMIENTO --expected-revision 0 --amount 2.50 --on 2026-11-02 --reason "Importe correcto" --category Comida
npm run movement:history -- --movement ID_MOVIMIENTO
npm run movement:recent -- --limit 10
npm run summary -- --month 2026-11
npm run balance:reconcile -- --source-key prueba-b2-conteo --account ID_USD --currency USD --target -10.00 --on 2026-11-02 --reason "Conteo ficticio"
npm run reconciliation:list -- --account ID_USD
npm run balance:list -- --on 2026-11-02
```

Comprueba que el original sigue en 200 unidades menores, el efectivo en 250, categoría
`Comida`, revisión 1. El JSON CLI usa cadenas en unidades menores; `--amount`/`--target`
usan decimales exactos. Repetir la edición y la conciliación da los mismos IDs con
`existente`; cambiar el payload con la misma clave falla sin escribir. El saldo al corte
es -10.00; el ajuste no aparece en `summary`. Otra conciliación nueva con el mismo
objetivo conserva un delta cero auditado.

```bash
npm run movement:void -- --source-key prueba-b2-void --movement ID_MOVIMIENTO --expected-revision 1 --reason Duplicado
npm run movement:history -- --movement ID_MOVIMIENTO
```

La anulación es terminal: otra edición nueva falla. El original y el replay de la
edición anterior siguen disponibles. El anulado desaparece de recientes/resumen/saldo.
El delta de conciliación **no se recalcula**: ahora puede haber deriva del objetivo.
Una revisión obsoleta también falla. Edición reemplaza importe/fecha/descripcion/categoría:
omitir descripción o categoría las limpia. Las etiquetas son opcionales, recortadas,
sensibles a mayúsculas, de hasta 80 caracteres, sin registro ni cambios de IA.

Para cambiar cuenta, moneda o tipo: anula y crea otro movimiento manual con otra clave.
No intentes editar/anular aperturas o principales transferidos: B2 lo rechaza explícitamente
sin reversión parcial. La comisión sí es independiente; el historial muestra su operación
dueña. Editarla/anularla no cambia el replay de la transferencia original.

Arranca el bot y prueba `/movement ID_MOVIMIENTO`, `/history ID_MOVIMIENTO`,
`/reconciliations ID_USD` y `/recent`: sin IA y sin modificar el pendiente. Las consultas
acotadas ofrecen alternativa CLI cuando el detalle no cabe en Telegram. Las escrituras
B2 son solo por CLI; todos sus flags son estrictos.

Detén el backend, crea backup B2 y restaura en ruta nueva. Apunta `DATABASE_PATH` allí,
migra y compara historial, conciliaciones y saldos. Se aceptan prefijos completos A/B1;
si hay marcador B2 deben existir ambas tablas B2 y el prefijo B1.

Validación automatizada dedicada (bases temporales, sin proveedores):

```bash
npm run typecheck
npm run build
npm test -- --runInBand test/movement-corrections.spec.ts test/movement-corrections-migration.spec.ts test/movement-corrections-cli.spec.ts test/telegram-commands.spec.ts
```

**Estado:** B1–B4 aceptados técnicamente en local, con revisiones sin hallazgos.
La evidencia integrada vigente está en la sección 3; no se reaudita A ni se habilita
producción o migración de la base real.

## 7. Probar solo B3: presupuestos financieros (sin IA)

**B3 aceptado técnicamente en local.** No uses ni migres la base real: selecciona
una base ficticia en `DATABASE_PATH`. Detén backend, haz backup A/B1/B2, compila y
migra. B3 añade únicamente `budget`; conserva todo el historial previo. Las copias de
prefijos completos A/B1/B2 siguen siendo válidas; una copia B3 exige tabla y marcador
`Budgets1780617600000` juntos y los prefijos B2/B1 completos.

```bash
npm run budget:add -- --source-key prueba-b3-global --name Noviembre --currency USD --limit 10.00 --month 2026-11
npm run budget:add -- --source-key prueba-b3-comida1 --name Comida --currency USD --limit 2.00 --category Comida --month 2026-11 --half first
npm run budget:add -- --source-key prueba-b3-comida2 --name Comida --currency USD --limit 0 --category Comida --from 2026-11-16 --to 2026-11-30
npm run budget:list
npm run budget:status -- --on 2026-11-10
npm run budget:status -- --budget ID_PRESUPUESTO --on 2026-12-10
```

Comprueba:

1. Repetir definición con misma clave da mismo ID y `existente`; cambiar nombre,
   moneda, límite, categoría o fechas con esa clave falla sin escribir. Definiciones
   inmutables, no hay actualización/eliminación en B3. Nombre hasta 80 y clave hasta
   200 caracteres, recortados. Límite cero válido, negativos rechazados.
2. Global y categoría pueden coexistir; misma moneda/categoría exacta solapada falla
   incluso si comparten solo un día. Categoría opcional, recortada, sensible a mayúsculas,
   hasta 80 caracteres. No hay catálogo ni clasificación IA. Monedas independientes.
3. Solo fechas reales inclusivas, inicio ≤ fin. `--from` exige `--to`, excluye `--month`.
   `--half first|second` exige mes: 1..15 o 16..último día. Prueba febrero 2024
   (29 días) y 2026 (28). Flags duplicados/desconocidos/incompletos fallan.
4. Registra un gasto con CLI B2 y asigna `Comida` con `movement:edit`. Debe contarse
   tanto en global como en su categoría, **sin sumar restantes**. Edítalo en importe,
   fecha/categoría y anúlalo: el reporte refleja el efectivo, el original no cambia.
   Comisiones sí cuentan; ingreso/principal/apertura/conciliación nunca cuentan.
5. `restante = límite - gastado`; puede ser negativo y mostrar `excedido`. No bloquea
   gastos ni mueve dinero, no hay rollover/reservas ni relación con saldo bancario.
   `budget:list` devuelve JSON con `limitMinor` en cadena exacta de unidades menores;
   status formatea decimales (USDT: seis). No hay conversiones ni redondeo.
6. Sin ID solo periodos activos al corte; con ID admite históricos/futuros, gastado cero
   antes del inicio y acotado al fin. Sin fecha usa hoy en Caracas, excluyendo gastos
   posteriores al corte.
7. En Telegram, `/budgets 2026-11-10`: mismo límite/gastado/restante y categoría,
   respuesta acotada con alternativa CLI. Un pendiente permanece intacto, sin IA ni
   allowance nuevo. `/help` incluye el comando. No se crean presupuestos por Telegram.
8. Detén backend, backup B3 → restaura ruta nueva → migra → compara definiciones y
   reportes al mismo corte. No cambies migraciones previas ni borres la base original.

```bash
npm run typecheck
npm run build
npm test -- --runInBand test/budget.service.spec.ts test/budget-migration.spec.ts test/budget-cli.spec.ts test/date.spec.ts test/money.spec.ts test/telegram-commands.spec.ts
```

Estas pruebas usan únicamente archivos temporales y clientes simulados; incluyen
precisión fuera del rango seguro de Number, replay concurrente y transacciones con
rollback/lecturas en cola. API `BudgetService.create/list/status`, manager opcional y
contratos detallados en README. B4 se prueba por separado abajo; sin inferencia de transferencias.

La evidencia vigente de B3 es la validación integrada de la sección 3.

## 8. Probar solo B4: metas y reservas virtuales (aceptado)

**B4 aceptado técnicamente en local tras revisión obligatoria sin hallazgos.**
No cambies la base real ni uses proveedores reales. A sigue aceptada, sin reauditoría.
Detén el backend; selecciona un prefijo ficticio completo A/B1/B2/B3, crea backup y
restaura en ruta temporal nueva. Cambia `DATABASE_PATH` a esa ruta, compila y migra.
B4 solo añade `goal` y `savings_entry`; no borres/recrees tablas ni originales. El marcador
`GoalsAndSavings1783209600000` requiere ambas tablas y B3/B2/B1 completos.

```bash
npm run goal:add -- --source-key prueba-b4 --name Fondo --currency USDT --target 100.000001 --target-on 2028-02-29
npm run goal:list
npm run goal:status -- --goal ID_META
npm run savings:reserve -- --source-key reserva-b4 --goal ID_META --account ID_USDT --amount 10.000001
npm run savings:release -- --source-key libera-b4 --goal ID_META --account ID_USDT --amount 0.000001
npm run savings:status -- --account ID_USDT
npm run savings:history -- --account ID_USDT --goal ID_META
```

Comprueba en esa base ficticia:

1. Meta UUID inmutable, nombre ≤80, clave ≤200, moneda única, objetivo positivo exacto
   TEXT, fecha opcional real (`2026-02-29` falla). Cero, negativo, precisión extra y flags
   desconocidos/duplicados/incompletos/posicionales fallan sin escrituras. Repetir misma
   clave/payload recortado devuelve mismo ID y `existente`; cambiarlo causa conflicto.
2. Reserva inmediata, sin `--on`, retroactividad, programación ni reporte histórico de reservas: solo saldo **hoy Caracas**,
   no ingresos futuros. Cuenta activa y misma moneda que meta. CLI deriva la escala de
   la meta conocida, nunca convierte/adivina. USDT conserva seis decimales grandes exactos.
3. Reserva ≤ disponible de **todas las metas de esa cuenta**: saldo real − total reservado.
   Dos reservas concurrentes sobre los mismos fondos no pueden ganar ambas. No se crean
   movimientos ni cambian `balance:list`, presupuestos o `/summary`. No es transferencia.
4. Liberar ≤ reservado del par meta/cuenta, incluso con cuenta inactiva o deficitaria.
   Replay funciona tras liberar/desactivar/perder respaldo: ningún duplicado. Historial
   append-only por API; sin editar/borrar metas/entradas. JSON usa cadenas menores exactas.
5. Sobreobjetivo permitido con fondos libres, progreso puede superar 100%; porcentaje
   con dos decimales truncados por cociente bigint. Restante nunca menor que cero.
   Se agregan cuentas de igual moneda, nunca monedas distintas.
6. Reserva casi todo; registra gasto/transferencia con comisión, edita gastos/anula ingreso
   o concilia a saldo menor. **Debe registrar y advertir**, preservando reservas, sin
   autoliberar. Disponible puede ser negativo; déficit = max(0, −disponible); nueva reserva
   bloqueada y liberación permitida. CLI financiero avisa de déficits actuales tras éxito.
   Metas asociadas muestran «reserva nominal con cuentas deficitarias», sin inventar
   asignación/prorrateo del faltante entre metas.
7. Telegram `/goals [ID]`, `/savings`, `/balances`: consultas deterministas acotadas con
   alternativa CLI, sin IA/allowance ni modificar el pendiente. `/balances FECHA` solo
   muestra reservas/disponibles si es hoy; históricos conservan saldo real sin mezclar.
   `/confirm` que registra bajo reservas añade advertencia actual, sin cambiar el reply
   durable de captura ni duplicar movimiento. Outbox conserva diagnóstico al reintentar
   envío. Confirmación fallida/sin pendiente no advierte. `/help` explica solo lectura.
8. Reinicia; repite claves; backup B4 → restaura ruta nueva → migra → compara metas,
   historial, IDs, saldos y disponibles al mismo día. Los prefijos completos A/B1/B2/B3
   se restauran y actualizan; marcadores/tablas parciales se rechazan.

Metas/reservas/liberaciones son solo CLI manual. Sigue sin editar aperturas/principales
transferidos, sin captura natural B, sin nuevos mutadores Telegram, Angular/C/OCR/IA
de transferencias. Contratos API y limitaciones detallados en README.

```bash
npm run typecheck
npm run build
npm test -- --runInBand test/savings.service.spec.ts test/savings-migration.spec.ts test/savings-telegram.spec.ts
npm test -- --runInBand test/savings-cli.spec.ts
npm run test:e2e -- --runInBand
```

No hacer commits/push ni rollout real. Las revisiones obligatorias de B1–B4 están
aceptadas sin hallazgos; la evidencia integrada vigente y sus comandos exactos están en
la sección 3 y en README. **B está completada técnicamente en local dentro del alcance
documentado**, no como flujos B completos en lenguaje natural ni habilitación de producción.
Siguen pendientes las pruebas con proveedores reales y la revisión de preparación para producción.

## 9. Probar la unidad 2 de deudas: conversación, captura y bot (en curso)

Con el backend detenido y una **base de pruebas separada** (`DATABASE_PATH` de pruebas):
aplica las migraciones pendientes (`npm run migration:run`) y arranca el backend. La
unidad 2 añade la migración `DebtCapture1788566400000` (una columna `debtPayload` en
`capture`); es aditiva y no reescribe borradores anteriores.

Con el bot y un modelo real, escribe en el chat:

| Mensaje | Resultado esperado |
|---|---|
| `le debo 8$ a Carmen de dos tortas` | Presenta el resumen de una deuda a pagar; **no** registra movimiento ni cuenta |
| `/confirm` | Registra la obligación y devuelve su id (`Deuda: <id>`) |
| `Carmen me debe 8$` | Presenta el resumen de una deuda a cobrar (dirección contraria) |
| `/confirm` | Registra la obligación a cobrar, sin movimiento |
| `cuáles son mis deudas` | Lista las deudas pendientes, separando lo que debo de lo que me deben; no toca el borrador pendiente |
| `le pagué 3 dólares a Carmen` | Presenta el resumen del pago, con el pendiente congelado del momento |
| `/confirm` | Registra **un gasto** por 3 USD ligado a la deuda y devuelve id de deuda, de pago y de movimiento |
| `Carmen me pagó` | Presenta el resumen de un pago **parcial**; si no dice el importe, pregunta cuánto se pagó |
| `/confirm` | Registra un **ingreso** por el importe indicado y deja la deuda pagada |
| `ya le pagué todo a Carmen` | Presenta el resumen de un pago **total** (lo autoriza el texto del usuario) |
| `/confirm` | Registra el ingreso por el pendiente completo de la deuda |
| `/debts` | Lista las deudas con id, contraparte, original, pagado, pendiente y estado; totales por dirección y moneda, sin compensar |
| `/debts <id>` | Muestra esa deuda |
| `/cancel` | Descarta el borrador pendiente sin registrar nada |

Después comprueba:

- Un mensaje de deuda que el modelo clasifique mal como gasto o ingreso **no** registra
  nada: el bot pregunta si es una deuda, un pago o una consulta.
- «Carmen me pagó» **no** paga todo: sin un importe explícito o sin que el usuario diga
  que pagó todo, el bot pregunta el importe (aunque el modelo diga que fue un pago total).
- «ya le pagué todo» sí paga el pendiente completo, y esa autorización se conserva al
  aclarar la cuenta (incluso tras reiniciar); si el usuario cambia de persona u otra
  deuda, se vuelve a pedir.
- Con dos deudas de la misma contraparte, el bot **pregunta con los ids** en vez de elegir
  una; al escribir el id, resuelve esa deuda. Un id escrito en el mensaje actual manda
  sobre el borrador anterior.
- Si entre el resumen y el `/confirm` cambia el pendiente (otro pago o una anulación), el
  `/confirm` se rechaza: no se paga un total nuevo en silencio.
- Si falta la contraparte, la dirección, la moneda o la cuenta, se pregunta y no se inventa
  nada.
- Una consulta mientras hay un borrador pendiente **no** modifica ese borrador.
- Reinicia el backend y confirma el borrador: la deuda se registra una sola vez.

```bash
npm run typecheck
npm run build
npm test -- --runInBand test/debt-capture.spec.ts test/debt-telegram.spec.ts test/debt-migration.spec.ts test/openrouter.interpreter.spec.ts
npm run test:e2e -- --runInBand
```

La CLI de deudas y el cierre de la unidad 3 **no** están: no hay comando de debts por
CLI y esta unidad **no** está aceptada técnicamente. Sigue sin haber pruebas con
proveedores reales ni revisión de preparación para producción.
