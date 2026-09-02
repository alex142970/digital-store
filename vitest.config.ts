import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['tests/setup/global.ts'],
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
      ADMIN_TOKEN: 'test-admin-token',
      PROVIDER_A_ERROR_RATE: '0',
      PROVIDER_A_TIMEOUT_RATE: '0',
      PROVIDER_B_ERROR_RATE: '0',
      PROVIDER_B_TIMEOUT_RATE: '0',
      PROVIDER_TIMEOUT_MS: '1000',
      DELIVERY_SWEEP_INTERVAL_MS: '0'
    },
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: { provider: 'v8', include: ['src/**'] }
  }
})
