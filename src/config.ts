import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  PG_POOL_MAX: z.coerce.number().int().positive().default(20),
  PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  PG_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
  TRUST_PROXY: z.string().default('127.0.0.1'),
  ADMIN_TOKEN: z.string().min(8),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info')
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
  throw new Error(`Invalid environment:\n${issues}`)
}

export const config = parsed.data
export type Config = typeof config
