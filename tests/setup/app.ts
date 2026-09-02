import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { buildApp } from '../../src/app.ts'
import { createPool } from '../../src/db/pool.ts'
import { migrate } from '../../src/db/migrate.ts'
import { seed } from '../../src/db/seed.ts'

export type TestContext = {
  app: FastifyInstance
  pool: pg.Pool
}

export async function startApp(): Promise<TestContext> {
  const pool = createPool({ connectionString: process.env.TEST_DATABASE_URL })
  await migrate(pool)
  const app = await buildApp({ pool, logger: false })

  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()

  if (address && typeof address === 'object') {
    process.env.PROVIDER_BASE_URL = `http://127.0.0.1:${address.port}`
  }

  return { app, pool }
}

export async function resetData(pool: pg.Pool): Promise<void> {
  await pool.query(
    'truncate delivery_attempts, deliveries, promocode_uses, webhook_events, license_keys, orders'
  )
  await pool.query('truncate provider_issues')
  await seed(pool)
}

export const createOrder = (ctx: TestContext, idempotencyKey: string, sku = 'KEY-CS2-PRIME') =>
  ctx.app.inject({ method: 'POST', url: '/api/orders', payload: { sku, idempotencyKey } })

export const pay = (ctx: TestContext, orderId: string, outcome: 'success' | 'fail' = 'success') =>
  ctx.app.inject({ method: 'POST', url: `/api/orders/${orderId}/pay`, payload: { outcome } })

export const fetchOrder = (ctx: TestContext, orderId: string) =>
  ctx.app.inject({ method: 'GET', url: `/api/orders/${orderId}` })

export const sendWebhook = (ctx: TestContext, event: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/webhook/payment', payload: event })

export const paidEvent = (orderId: string, overrides: Record<string, unknown> = {}) => ({
  event_id: `evt_${Math.random().toString(36).slice(2, 12)}`,
  order_id: orderId,
  status: 'paid',
  amount: 1290,
  currency: 'RUB',
  created_at: new Date().toISOString(),
  ...overrides
})
