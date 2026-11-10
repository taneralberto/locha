/**
 * Suite de extremo a extremo: flujo completo con un Telegram simulado y un
 * interpretador simulado. No hace ninguna llamada externa ni usa credenciales.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/e2e/**/*.e2e.spec.ts'],
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  testTimeout: 60000,
};
