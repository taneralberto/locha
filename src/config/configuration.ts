export const DEFAULT_DATABASE_PATH = 'data/locha.sqlite';
export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_OPENROUTER_TIMEOUT_MS = 20_000;
export const DEFAULT_OPENROUTER_MAX_INPUT_CHARS = 2_000;
export const DEFAULT_OPENROUTER_MAX_RESPONSE_BYTES = 16_384;
export const DEFAULT_MAX_REQUESTS_PER_DAY = 100;
export const DEFAULT_MAX_INPUT_TOKENS_PER_CALL = 2_000;
export const DEFAULT_MAX_OUTPUT_TOKENS_PER_CALL = 500;
export const DEFAULT_MAX_COST_MICRO_USD_PER_CALL = 5_000;
export const DEFAULT_DAILY_BUDGET_MICRO_USD = 200_000;
export const DEFAULT_TELEGRAM_TIMEOUT_MS = 40_000;
export const DEFAULT_TELEGRAM_MAX_RESPONSE_BYTES = 65_536;
export const DEFAULT_TELEGRAM_POLL_TIMEOUT_SECONDS = 25;

export interface OpenRouterSettings {
  baseUrl: string;
  /** Modelo configurado por el operador. No se presupone que soporte salidas estructuradas. */
  model: string;
  apiKey: string;
  /** Tiempo maximo de espera de la llamada HTTP, en milisegundos. */
  timeoutMs: number;
  /** Longitud maxima del texto enviado al proveedor. */
  maxInputChars: number;
  /** Longitud maxima de la respuesta del proveedor que se lee, en bytes. */
  maxResponseBytes: number;
}

export interface AiLimits {
  /** Llamadas maximas por dia. */
  maxRequestsPerDay: number;
  /** Tokens de entrada reservados por llamada. */
  maxInputTokensPerCall: number;
  /** Tokens de salida reservados por llamada (y `max_tokens` enviado al proveedor). */
  maxOutputTokensPerCall: number;
  /** Costo maximo reservado por llamada, en microUSD (1 USD = 1_000_000 microUSD). */
  maxCostMicroUsdPerCall: number;
  /** Presupuesto diario total, en microUSD. */
  dailyBudgetMicroUsd: number;
}

export interface AiConfig {
  openrouter: OpenRouterSettings;
  limits: AiLimits;
}

/**
 * Ajustes del bot de Telegram. El bot solo se activa con las **tres** variables
 * configuradas (token, usuario autorizado y chat autorizado): una configuracion
 * parcial deja el bot desactivado, nunca a medias.
 */
export interface TelegramSettings {
  /** `true` solo con token, usuario y chat configurados. */
  enabled: boolean;
  /** `true` si hay configuracion parcial: el bot queda desactivado por prudencia. */
  partial: boolean;
  botToken: string;
  /** Id numerico del usuario autorizado. */
  allowedUserId: number | null;
  /** Id numerico del chat privado autorizado. */
  allowedChatId: number | null;
  /** Plazo maximo de cada llamada a la API de Telegram, en milisegundos. */
  timeoutMs: number;
  /** Tope de bytes de la respuesta de la API que se lee. */
  maxResponseBytes: number;
  /** Espera maxima del long polling en el lado de Telegram, en segundos. */
  pollTimeoutSeconds: number;
}

export interface AppConfig {
  database: {
    path: string;
  };
  ai: AiConfig;
  telegram: TelegramSettings;
}

/**
 * Resuelve la ruta del archivo SQLite. Una variable definida pero vacia es un error de
 * configuracion: se rechaza en lugar de crear o abrir una base inesperada en silencio.
 */
export function resolveDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DATABASE_PATH;
  if (configured === undefined) {
    return DEFAULT_DATABASE_PATH;
  }
  const trimmed = configured.trim();
  if (trimmed.length === 0) {
    throw new Error('DATABASE_PATH no puede estar vacio. Configura la ruta del archivo SQLite.');
  }
  return trimmed;
}

/**
 * Ajustes de transporte de OpenRouter. La credencial y el modelo pueden faltar: la
 * aplicacion arranca igual y la captura falla de forma clara cuando se usa.
 */
export function resolveOpenRouterSettings(env: NodeJS.ProcessEnv = process.env): OpenRouterSettings {
  return {
    baseUrl: readText(env, 'OPENROUTER_BASE_URL', DEFAULT_OPENROUTER_BASE_URL),
    model: readText(env, 'OPENROUTER_MODEL', ''),
    apiKey: readText(env, 'OPENROUTER_API_KEY', ''),
    timeoutMs: readInteger(env, 'OPENROUTER_TIMEOUT_MS', DEFAULT_OPENROUTER_TIMEOUT_MS),
    maxInputChars: readInteger(env, 'OPENROUTER_MAX_INPUT_CHARS', DEFAULT_OPENROUTER_MAX_INPUT_CHARS),
    maxResponseBytes: readInteger(
      env,
      'OPENROUTER_MAX_RESPONSE_BYTES',
      DEFAULT_OPENROUTER_MAX_RESPONSE_BYTES,
    ),
  };
}

/**
 * Limites de consumo de la inferencia. Se guardan como enteros para poder compararlos
 * sin punto flotante: el presupuesto se expresa en microUSD.
 */
export function resolveAiLimits(env: NodeJS.ProcessEnv = process.env): AiLimits {
  return {
    maxRequestsPerDay: readInteger(env, 'OPENROUTER_MAX_REQUESTS_PER_DAY', DEFAULT_MAX_REQUESTS_PER_DAY),
    maxInputTokensPerCall: readInteger(
      env,
      'OPENROUTER_MAX_INPUT_TOKENS_PER_CALL',
      DEFAULT_MAX_INPUT_TOKENS_PER_CALL,
    ),
    maxOutputTokensPerCall: readInteger(
      env,
      'OPENROUTER_MAX_OUTPUT_TOKENS_PER_CALL',
      DEFAULT_MAX_OUTPUT_TOKENS_PER_CALL,
    ),
    maxCostMicroUsdPerCall: readInteger(
      env,
      'OPENROUTER_MAX_COST_MICRO_USD_PER_CALL',
      DEFAULT_MAX_COST_MICRO_USD_PER_CALL,
    ),
    dailyBudgetMicroUsd: readInteger(
      env,
      'OPENROUTER_DAILY_BUDGET_MICRO_USD',
      DEFAULT_DAILY_BUDGET_MICRO_USD,
    ),
  };
}

/**
 * Ajustes del bot de Telegram. El bot se activa solo con las **tres** variables
 * configuradas; con una configuracion parcial queda desactivado (falla cerrado).
 */
export function resolveTelegramSettings(env: NodeJS.ProcessEnv = process.env): TelegramSettings {
  const botToken = readText(env, 'TELEGRAM_BOT_TOKEN', '');
  const allowedUserId = readTelegramId(env, 'TELEGRAM_ALLOWED_USER_ID');
  const allowedChatId = readTelegramId(env, 'TELEGRAM_ALLOWED_CHAT_ID');
  const configured = [
    botToken,
    allowedUserId === null ? '' : String(allowedUserId),
    allowedChatId === null ? '' : String(allowedChatId),
  ].filter((value) => value.length > 0).length;
  return {
    enabled: configured === 3,
    partial: configured > 0 && configured < 3,
    botToken,
    allowedUserId,
    allowedChatId,
    timeoutMs: readInteger(env, 'TELEGRAM_TIMEOUT_MS', DEFAULT_TELEGRAM_TIMEOUT_MS),
    maxResponseBytes: readInteger(
      env,
      'TELEGRAM_MAX_RESPONSE_BYTES',
      DEFAULT_TELEGRAM_MAX_RESPONSE_BYTES,
    ),
    pollTimeoutSeconds: readInteger(
      env,
      'TELEGRAM_POLL_TIMEOUT_SECONDS',
      DEFAULT_TELEGRAM_POLL_TIMEOUT_SECONDS,
    ),
  };
}

/**
 * Id numerico de Telegram. Un valor definido pero no numerico es un error de
 * configuracion: se rechaza en lugar de dejar el bot a medias.
 */
function readTelegramId(env: NodeJS.ProcessEnv, name: string): number | null {
  const configured = env[name];
  if (configured === undefined) {
    return null;
  }
  const trimmed = configured.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`${name} debe ser un identificador numerico de Telegram.`);
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} no es un identificador valido.`);
  }
  return value;
}

function readText(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const configured = env[name];
  return configured === undefined ? fallback : configured.trim();
}

/** Un valor definido pero no entero es un error de configuracion: no se redondea en silencio. */
function readInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const configured = env[name];
  if (configured === undefined) {
    return fallback;
  }
  const trimmed = configured.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${name} debe ser un entero no negativo.`);
  }
  return Number.parseInt(trimmed, 10);
}

export default (): AppConfig => ({
  database: {
    path: resolveDatabasePath(),
  },
  ai: {
    openrouter: resolveOpenRouterSettings(),
    limits: resolveAiLimits(),
  },
  telegram: resolveTelegramSettings(),
});
