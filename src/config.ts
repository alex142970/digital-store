import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  PG_POOL_MAX: z.coerce.number().int().positive().default(20),
  CATALOG_BULK_SIZE: z.coerce.number().int().nonnegative().default(0),
  PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  PG_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
  TRUST_PROXY: z.string().default('127.0.0.1'),
  PROVIDER_A_ERROR_RATE: z.coerce.number().min(0).max(1).default(0.3),
  PROVIDER_A_TIMEOUT_RATE: z.coerce.number().min(0).max(1).default(0.2),
  PROVIDER_B_ERROR_RATE: z.coerce.number().min(0).max(1).default(0.1),
  PROVIDER_B_TIMEOUT_RATE: z.coerce.number().min(0).max(1).default(0.1),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  PROVIDER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  DELIVERY_SWEEP_INTERVAL_MS: z.coerce.number().int().nonnegative().default(15_000),
  DELIVERY_STUCK_AFTER_MS: z.coerce.number().int().positive().default(60_000),
  ORDER_EXPIRES_AFTER_MS: z.coerce.number().int().positive().default(1_800_000),
  RESERVATION_TTL_MS: z.coerce.number().int().positive().default(300_000),
  RESERVATION_SWEEP_INTERVAL_MS: z.coerce.number().int().nonnegative().default(2_000),
  SSE_HEARTBEAT_MS: z.coerce.number().int().positive().default(15_000),
  SSE_RETRY_MS: z.coerce.number().int().positive().default(3_000),
  SSE_MAX_BUFFER_BYTES: z.coerce.number().int().positive().default(262_144),
  CATALOG_EVENT_RETENTION_MS: z.coerce.number().int().positive().default(3_600_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info')
})

const parsed = schema
  .refine((c) => c.RESERVATION_TTL_MS < c.ORDER_EXPIRES_AFTER_MS, {
    message: 'RESERVATION_TTL_MS must be shorter than ORDER_EXPIRES_AFTER_MS',
    path: ['RESERVATION_TTL_MS']
  })
  .safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
  throw new Error(`Invalid environment:\n${issues}`)
}

export const config = parsed.data
export type Config = typeof config
