import {
  DEFAULT_DATABASE_PATH,
  DEFAULT_DAILY_BUDGET_MICRO_USD,
  DEFAULT_MAX_REQUESTS_PER_DAY,
  DEFAULT_OPENROUTER_BASE_URL,
  DEFAULT_TELEGRAM_MAX_RESPONSE_BYTES,
  DEFAULT_TELEGRAM_POLL_TIMEOUT_SECONDS,
  DEFAULT_TELEGRAM_TIMEOUT_MS,
  resolveAiLimits,
  resolveDatabasePath,
  resolveOpenRouterSettings,
  resolveTelegramSettings,
} from '../src/config/configuration';

describe('Configuracion', () => {
  it('usa la ruta por defecto cuando DATABASE_PATH no esta definida', () => {
    expect(resolveDatabasePath({})).toBe(DEFAULT_DATABASE_PATH);
  });

  it('acepta una ruta valida y recorta espacios', () => {
    expect(resolveDatabasePath({ DATABASE_PATH: 'data/locha.sqlite' })).toBe('data/locha.sqlite');
    expect(resolveDatabasePath({ DATABASE_PATH: '  data/locha.sqlite  ' })).toBe('data/locha.sqlite');
  });

  it('rechaza DATABASE_PATH vacio o en blanco', () => {
    expect(() => resolveDatabasePath({ DATABASE_PATH: '' })).toThrow(/DATABASE_PATH/);
    expect(() => resolveDatabasePath({ DATABASE_PATH: '   ' })).toThrow(/DATABASE_PATH/);
    expect(() => resolveDatabasePath({ DATABASE_PATH: '\t\n' })).toThrow(/DATABASE_PATH/);
  });

  describe('OpenRouter', () => {
    it('deja la captura sin credencial ni modelo si no estan configurados', () => {
      const settings = resolveOpenRouterSettings({});

      expect(settings.apiKey).toBe('');
      expect(settings.model).toBe('');
      expect(settings.baseUrl).toBe(DEFAULT_OPENROUTER_BASE_URL);
    });

    it('recorta la credencial y el modelo', () => {
      const settings = resolveOpenRouterSettings({
        OPENROUTER_API_KEY: '  clave  ',
        OPENROUTER_MODEL: '  modelo  ',
      });

      expect(settings.apiKey).toBe('clave');
      expect(settings.model).toBe('modelo');
    });

    it('rechaza un limite que no es un entero', () => {
      expect(() => resolveOpenRouterSettings({ OPENROUTER_TIMEOUT_MS: '10s' })).toThrow(
        /OPENROUTER_TIMEOUT_MS/,
      );
      expect(() => resolveOpenRouterSettings({ OPENROUTER_MAX_INPUT_CHARS: '-1' })).toThrow(
        /OPENROUTER_MAX_INPUT_CHARS/,
      );
    });
  });

  describe('Telegram', () => {
    const completo = {
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_ALLOWED_USER_ID: '111',
      TELEGRAM_ALLOWED_CHAT_ID: '222',
    };

    it('desactiva el bot si no hay ninguna variable', () => {
      const settings = resolveTelegramSettings({});

      expect(settings.enabled).toBe(false);
      expect(settings.partial).toBe(false);
      expect(settings.botToken).toBe('');
      expect(settings.allowedUserId).toBeNull();
      expect(settings.allowedChatId).toBeNull();
      expect(settings.timeoutMs).toBe(DEFAULT_TELEGRAM_TIMEOUT_MS);
      expect(settings.maxResponseBytes).toBe(DEFAULT_TELEGRAM_MAX_RESPONSE_BYTES);
      expect(settings.pollTimeoutSeconds).toBe(DEFAULT_TELEGRAM_POLL_TIMEOUT_SECONDS);
    });

    it('falla cerrado con una configuracion parcial', () => {
      const settings = resolveTelegramSettings({
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_ALLOWED_USER_ID: '111',
      });

      expect(settings.enabled).toBe(false);
      expect(settings.partial).toBe(true);
    });

    it('activa el bot con las tres variables configuradas', () => {
      const settings = resolveTelegramSettings(completo);

      expect(settings.enabled).toBe(true);
      expect(settings.partial).toBe(false);
      expect(settings.botToken).toBe('token');
      expect(settings.allowedUserId).toBe(111);
      expect(settings.allowedChatId).toBe(222);
    });

    it('rechaza un identificador que no es numerico', () => {
      expect(() =>
        resolveTelegramSettings({ ...completo, TELEGRAM_ALLOWED_USER_ID: 'usuario' }),
      ).toThrow(/TELEGRAM_ALLOWED_USER_ID/);
    });

    it('rechaza un limite que no es un entero', () => {
      expect(() => resolveTelegramSettings({ ...completo, TELEGRAM_TIMEOUT_MS: '10s' })).toThrow(
        /TELEGRAM_TIMEOUT_MS/,
      );
    });
  });

  describe('Limites de inferencia', () => {    it('usa los limites por defecto', () => {
      const limits = resolveAiLimits({});

      expect(limits.maxRequestsPerDay).toBe(DEFAULT_MAX_REQUESTS_PER_DAY);
      expect(limits.dailyBudgetMicroUsd).toBe(DEFAULT_DAILY_BUDGET_MICRO_USD);
    });

    it('acepta enteros como texto', () => {
      const limits = resolveAiLimits({
        OPENROUTER_MAX_REQUESTS_PER_DAY: ' 42 ',
        OPENROUTER_DAILY_BUDGET_MICRO_USD: '1500',
      });

      expect(limits.maxRequestsPerDay).toBe(42);
      expect(limits.dailyBudgetMicroUsd).toBe(1500);
    });

    it('rechaza un presupuesto que no es un entero', () => {
      expect(() => resolveAiLimits({ OPENROUTER_DAILY_BUDGET_MICRO_USD: '1.5' })).toThrow(
        /OPENROUTER_DAILY_BUDGET_MICRO_USD/,
      );
      expect(() =>
        resolveAiLimits({ OPENROUTER_MAX_COST_MICRO_USD_PER_CALL: 'mucho' }),
      ).toThrow(/OPENROUTER_MAX_COST_MICRO_USD_PER_CALL/);
    });
  });
});
