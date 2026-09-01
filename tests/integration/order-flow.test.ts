import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import {
  createOrder,
  fetchOrder,
  paidEvent,
  pay,
  resetData,
  sendWebhook,
  startApp,
  type TestContext
} from '../setup/app.ts'

let ctx: TestContext

beforeAll(async () => {
  ctx = await startApp()
})

afterAll(async () => {
  await ctx.app.close()
  await ctx.pool.end()
})

beforeEach(async () => {
  await resetData(ctx.pool)
})

test('order price comes from the database, not from the request', async () => {
  const cheap = await createOrder(ctx, 'price-check-1', 'STEAM-TOPUP-500')
  expect(cheap.json()).toMatchObject({ sku: 'STEAM-TOPUP-500', amount: 500, total: 500 })

  await ctx.pool.query("update products set price = 777 where sku = 'KEY-CS2-PRIME'")

  const updated = await createOrder(ctx, 'price-check-2')
  expect(updated.json()).toMatchObject({ amount: 777, total: 777 })
})

test('paid order receives a key and consumes exactly one', async () => {
  const order = (await createOrder(ctx, 'happy-path-1')).json()

  expect((await pay(ctx, order.id)).statusCode).toBe(202)

  const delivered = (await fetchOrder(ctx, order.id)).json()
  expect(delivered.status).toBe('delivered')
  expect(delivered.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/)

  const { rows } = await ctx.pool.query(
    `select (select count(*) from deliveries)::int as deliveries,
            (select count(*) from license_keys where order_id is not null)::int as used`
  )
  expect(rows[0]).toEqual({ deliveries: 1, used: 1 })
})

test('failed payment consumes no key at all', async () => {
  const order = (await createOrder(ctx, 'failed-payment-1')).json()

  await pay(ctx, order.id, 'fail')

  const failed = (await fetchOrder(ctx, order.id)).json()
  expect(failed.status).toBe('payment_failed')
  expect(failed.code).toBeNull()

  const { rows } = await ctx.pool.query(
    'select count(*)::int as used from license_keys where order_id is not null'
  )
  expect(rows[0].used).toBe(0)
})

test('repeated idempotency key returns the same order and creates nothing', async () => {
  const first = await createOrder(ctx, 'idempotency-1')
  const second = await createOrder(ctx, 'idempotency-1')

  expect(first.statusCode).toBe(201)
  expect(second.statusCode).toBe(200)
  expect(second.json().id).toBe(first.json().id)

  const { rows } = await ctx.pool.query('select count(*)::int as count from orders')
  expect(rows[0].count).toBe(1)
})

test('repeated webhook is stored once and applied once', async () => {
  const order = (await createOrder(ctx, 'webhook-replay-1')).json()
  const event = paidEvent(order.id)

  await sendWebhook(ctx, event)
  const afterFirst = (await fetchOrder(ctx, order.id)).json()

  await sendWebhook(ctx, event)
  const afterSecond = (await fetchOrder(ctx, order.id)).json()

  expect(afterSecond.code).toBe(afterFirst.code)

  const { rows } = await ctx.pool.query(
    `select (select count(*) from webhook_events)::int as events,
            (select count(*) from webhook_events where applied_at is not null)::int as applied,
            (select count(*) from deliveries)::int as deliveries`
  )
  expect(rows[0]).toEqual({ events: 1, applied: 1, deliveries: 1 })
})

test('webhook with a wrong amount does not deliver a key', async () => {
  const order = (await createOrder(ctx, 'amount-mismatch-1')).json()

  const response = await sendWebhook(ctx, paidEvent(order.id, { amount: 1 }))
  expect(response.statusCode).toBe(200)

  const rejected = (await fetchOrder(ctx, order.id)).json()
  expect(rejected.status).toBe('payment_failed')
  expect(rejected.code).toBeNull()
})

test('webhook with a wrong currency does not deliver a key', async () => {
  const order = (await createOrder(ctx, 'currency-mismatch-1')).json()

  await sendWebhook(ctx, paidEvent(order.id, { currency: 'USD' }))

  const rejected = (await fetchOrder(ctx, order.id)).json()
  expect(rejected.code).toBeNull()
})

test('stale paid event does not revive a failed order', async () => {
  const order = (await createOrder(ctx, 'out-of-order-1')).json()

  await sendWebhook(
    ctx,
    paidEvent(order.id, { status: 'failed', created_at: '2026-01-02T12:00:00.000Z' })
  )
  expect((await fetchOrder(ctx, order.id)).json().status).toBe('payment_failed')

  await sendWebhook(ctx, paidEvent(order.id, { created_at: '2026-01-01T12:00:00.000Z' }))

  const stillFailed = (await fetchOrder(ctx, order.id)).json()
  expect(stillFailed.status).toBe('payment_failed')
  expect(stillFailed.code).toBeNull()
})

test('empty pool leaves the order recoverable and delivery resumes after restock', async () => {
  await ctx.pool.query('delete from license_keys')

  const order = (await createOrder(ctx, 'restock-1')).json()
  await pay(ctx, order.id)

  const stuck = (await fetchOrder(ctx, order.id)).json()
  expect(stuck.status).toBe('out_of_stock')
  expect(stuck.failureReason).toBeTruthy()

  await ctx.pool.query(
    "insert into license_keys (sku, code) values ('KEY-CS2-PRIME', 'RSTK-0001-0001')"
  )

  await sendWebhook(ctx, paidEvent(order.id))

  const recovered = (await fetchOrder(ctx, order.id)).json()
  expect(recovered.status).toBe('delivered')
  expect(recovered.code).toBe('RSTK-0001-0001')
})

test('unpaid order never receives a key through the delivery service', async () => {
  const { deliverOrder } = await import('../../src/services/delivery.ts')
  const order = (await createOrder(ctx, 'unpaid-delivery-1')).json()

  const outcome = await deliverOrder(ctx.pool, order.id)

  expect(outcome).toBe('not_found')

  const untouched = (await fetchOrder(ctx, order.id)).json()
  expect(untouched.status).toBe('created')
  expect(untouched.code).toBeNull()
})
