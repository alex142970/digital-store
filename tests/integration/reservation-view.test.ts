import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { config } from '../../src/config.ts'
import { expireReservations } from '../../src/services/inventory.ts'
import {
  cancel,
  createOrder,
  fetchOrder,
  paidEvent,
  pay,
  resetData,
  startApp,
  waitForStatus,
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

const setPrice = async (sku: string, price: number) => {
  const response = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/admin/products/${sku}`,
    payload: { price }
  })

  if (response.statusCode !== 200) throw new Error(`price update failed: ${response.body}`)
}

const freeKeys = async (sku = 'KEY-CS2-PRIME') => {
  const { rows } = await ctx.pool.query<{ free: number }>(
    `select count(*)::int as free from license_keys
     where sku = $1 and allocated_order_id is null and order_id is null`,
    [sku]
  )

  return rows[0]?.free ?? 0
}

test('a new order carries the remaining reservation time counted by the server', async () => {
  const order = (await createOrder(ctx, 'countdown-1')).json()

  expect(order.expiresInMs).toBeGreaterThan(0)
  expect(order.expiresInMs).toBeLessThanOrEqual(config.RESERVATION_TTL_MS)
  expect(order.reservationExpiresAt).not.toBeNull()

  await new Promise((resolve) => setTimeout(resolve, 1100))

  const later = (await fetchOrder(ctx, order.id)).json()

  expect(later.expiresInMs).toBeLessThan(order.expiresInMs)
})

test('the remainder is computed in SQL, not taken from the configured ttl', async () => {
  const order = (await createOrder(ctx, 'countdown-server')).json()

  await ctx.pool.query(
    "update orders set reservation_expires_at = now() + interval '42 seconds' where id = $1",
    [order.id]
  )

  const refreshed = (await fetchOrder(ctx, order.id)).json()

  expect(refreshed.expiresInMs).toBeGreaterThan(40_000)
  expect(refreshed.expiresInMs).toBeLessThanOrEqual(42_000)
})

test('a paid order stops counting: the timer no longer affects anything', async () => {
  const order = (await createOrder(ctx, 'countdown-paid')).json()

  await pay(ctx, order.id)
  const delivered = await waitForStatus(ctx, order.id, ['delivered'])

  expect(delivered.expiresInMs).toBeNull()
  expect(delivered.reservationExpiresAt).toBeNull()
})

test('an expired reservation reports zero instead of a negative remainder', async () => {
  const order = (await createOrder(ctx, 'countdown-zero')).json()

  await ctx.pool.query('delete from license_keys where allocated_order_id = $1', [order.id])
  await ctx.pool.query(
    "update orders set reservation_expires_at = now() - interval '5 seconds' where id = $1",
    [order.id]
  )

  const lapsed = (await fetchOrder(ctx, order.id)).json()

  expect(lapsed.expiresInMs).toBe(0)
})

test('a price change is visible on the order before payment, not after', async () => {
  const order = (await createOrder(ctx, 'price-change-1')).json()

  expect(order.priceChanged).toBe(false)
  expect(order.currentPrice).toBe(order.amount)

  await setPrice(order.sku, order.amount + 700)

  const raised = (await fetchOrder(ctx, order.id)).json()

  expect(raised.priceChanged).toBe(true)
  expect(raised.currentPrice).toBe(order.amount + 700)
  expect(raised.amount).toBe(order.amount)
  expect(raised.total).toBe(order.total)
})

test('the reserved price is what gets charged after the catalog moves', async () => {
  const order = (await createOrder(ctx, 'price-change-2')).json()

  await setPrice(order.sku, order.amount + 700)
  await pay(ctx, order.id)

  const delivered = await waitForStatus(ctx, order.id, ['delivered'])

  expect(delivered.total).toBe(order.total)
  expect(delivered.amount).toBe(order.amount)
  expect(delivered.currentPrice).toBe(order.amount + 700)
})

test('cancelling a reservation returns the unit and fails the order', async () => {
  const before = await freeKeys()
  const order = (await createOrder(ctx, 'cancel-1')).json()

  expect(await freeKeys()).toBe(before - 1)

  const response = await cancel(ctx, order.id)
  const cancelled = response.json()

  expect(response.statusCode).toBe(200)
  expect(cancelled.status).toBe('payment_failed')
  expect(cancelled.failureCode).toBe('cancelled_by_customer')
  expect(cancelled.expiresInMs).toBeNull()
  expect(await freeKeys()).toBe(before)
})

test('cancelling releases the promo code as well', async () => {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/orders',
    payload: { sku: 'KEY-CS2-PRIME', idempotencyKey: 'cancel-promo', promoCode: 'WELCOME10' }
  })

  const order = created.json()

  expect(order.discount).toBeGreaterThan(0)

  await cancel(ctx, order.id)

  const { rows } = await ctx.pool.query<{ used: number }>(
    "select used_count as used from promocodes where code = 'WELCOME10'"
  )

  expect(rows[0]?.used).toBe(0)
})

test('a paid order cannot be cancelled', async () => {
  const order = (await createOrder(ctx, 'cancel-paid')).json()

  await pay(ctx, order.id)
  await waitForStatus(ctx, order.id, ['delivered'])

  const response = await cancel(ctx, order.id)

  expect(response.statusCode).toBe(409)
  expect(response.json().error).toBe('order_not_cancellable')
})

test('a cancelled order cannot be paid afterwards', async () => {
  const order = (await createOrder(ctx, 'cancel-then-pay')).json()

  await cancel(ctx, order.id)

  const response = await pay(ctx, order.id)

  expect(response.statusCode).toBe(409)
  expect((await fetchOrder(ctx, order.id)).json().code).toBeNull()
})

test('cancelling twice does not release a second unit', async () => {
  const before = await freeKeys()
  const order = (await createOrder(ctx, 'cancel-twice')).json()

  const [first, second] = await Promise.all([cancel(ctx, order.id), cancel(ctx, order.id)])
  const codes = [first.statusCode, second.statusCode].sort()

  expect(codes).toEqual([200, 409])
  expect(await freeKeys()).toBe(before)
})

test('a cancelled unit is immediately buyable by someone else', async () => {
  await ctx.pool.query("delete from license_keys where code <> 'LFXC-TNCS-BPCD'")

  const mine = (await createOrder(ctx, 'cancel-handover-1')).json()
  const refused = await createOrder(ctx, 'cancel-handover-2')

  expect(refused.statusCode).toBe(409)

  await cancel(ctx, mine.id)

  const retry = await createOrder(ctx, 'cancel-handover-3')

  expect(retry.statusCode).toBe(201)
})

test('cancelling an unknown order is a plain 404', async () => {
  const response = await cancel(ctx, 'ord_missing')

  expect(response.statusCode).toBe(404)
  expect(response.json().error).toBe('not_found')
})

test('an order with a payment already accepted cannot be cancelled', async () => {
  const order = (await createOrder(ctx, 'cancel-vs-payment')).json()

  await ctx.pool.query(
    `insert into webhook_events (event_id, order_id, status, occurred_at, payload)
     values ($1, $2, 'paid', now(), $3)`,
    [`evt_${order.id}`, order.id, JSON.stringify(paidEvent(order.id, { amount: order.total }))]
  )

  const response = await cancel(ctx, order.id)

  expect(response.statusCode).toBe(409)
  expect(response.json().error).toBe('payment_in_progress')

  const { rows } = await ctx.pool.query<{ reserved: number }>(
    'select count(*)::int as reserved from license_keys where allocated_order_id = $1',
    [order.id]
  )

  expect(rows[0]?.reserved).toBe(1)
})

test('an issued key is never released by a cancellation', async () => {
  const order = (await createOrder(ctx, 'cancel-vs-issued')).json()

  await ctx.pool.query(
    `update license_keys set order_id = allocated_order_id, issued_at = now()
     where allocated_order_id = $1`,
    [order.id]
  )

  const response = await cancel(ctx, order.id)

  expect(response.statusCode).toBe(409)
  expect(response.json().error).toBe('order_not_cancellable')

  const { rows } = await ctx.pool.query<{ issued: number }>(
    'select count(*)::int as issued from license_keys where order_id = $1',
    [order.id]
  )

  expect(rows[0]?.issued).toBe(1)
})

test('a delivered order survives its own deadline: the sweeper keeps its hands off', async () => {
  const order = (await createOrder(ctx, 'deadline-after-pay')).json()

  await pay(ctx, order.id)
  await waitForStatus(ctx, order.id, ['delivered'])

  await ctx.pool.query(
    "update orders set reservation_expires_at = now() - interval '1 minute' where id = $1",
    [order.id]
  )

  await new Promise((resolve) => setTimeout(resolve, 1500))
  await expireReservations(ctx.pool)

  const after = (await fetchOrder(ctx, order.id)).json()

  expect(after.status).toBe('delivered')
  expect(after.code).not.toBeNull()
  expect(after.expiresInMs).toBeNull()

  const { rows } = await ctx.pool.query<{ bound: number }>(
    'select count(*)::int as bound from license_keys where order_id = $1',
    [order.id]
  )

  expect(rows[0]?.bound).toBe(1)
})
