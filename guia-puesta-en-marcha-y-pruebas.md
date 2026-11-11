# Guía de puesta en marcha y pruebas — Etapa A

Para probarlo **no necesitas hosting, dominio ni webhook**: funciona localmente mediante *long polling* de Telegram. Tampoco hay interfaz web todavía.

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
```

El resultado esperado actualmente es **184 pruebas unitarias y 7 de flujo completo aprobadas**. Esto también permitirá comprobarlas en Node 24.

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
| `Gasté 2 USD en helado de la cuenta Efectivo` | Presenta un borrador; todavía no registra |
| `/confirm` | Registra exactamente un movimiento |
| `/recent` | Muestra el movimiento y su ID |
| `/summary` | Muestra gastos de 2 USD |
| `/usage` | Muestra las reservas de consumo de IA |

Después comprueba:
- Un mensaje incompleto pide aclaración.
- `/cancel` descarta el borrador.
- Reiniciar con `Ctrl+C` y `npm start` conserva los movimientos.
- Una transferencia se rechaza sin registrarla como gasto: corresponde a la Etapa B.

**Usa únicamente datos ficticios por ahora.** Para añadir cuentas, migrar o hacer backups, detén primero el backend. Estos pasos están contrastados con el `README.md`, `.env.example` y los comandos actuales del proyecto.
