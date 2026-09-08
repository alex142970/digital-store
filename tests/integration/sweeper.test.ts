process.env.DELIVERY_SWEEP_INTERVAL_MS = '50'
process.env.ORDER_EXPIRES_AFTER_MS = '150'
process.env.RESERVATION_TTL_MS = '100'
process.env.RESERVATION_SWEEP_INTERVAL_MS = '50'

import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'

type Ctx = Awaited<ReturnType<(typeof import('../setup/app.ts'))['startApp']>>

let ctx: Ctx
let stop: () => void
let helpers: typeof import('../setup/app.ts')

beforeAll(async () => {
  helpers = await import('../setup/app.ts')
  ctx = await helpers.startApp()
  const { startDeliverySweeper } = await import('../../src/services/sweeper.ts')
  stop = startDeliverySweeper(ctx.app)
})

afterAll(async () => {
  stop?.()
  await ctx.app.close()
  await ctx.pool.end()
})

beforeEach(async () => {
  await helpers.resetData(ctx.pool)
})

const waitFor = async (check: () => Promise<boolean>, budgetMs = 5000) => {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

test('the sweeper unsticks an order abandoned in delivering and delivers it', async () => {
  const order = (await helpers.createOrder(ctx, 'sweeper-stuck-0001')).json()
  await helpers.pay(ctx, order.id)

  // pretend the process died after the provider issued but before the order was closed
  await ctx.pool.query('delete from deliveries where order_id = $1', [order.id])
  // the orders_updated_at trigger rewrites updated_at, so it has to be muted to age the row
  await ctx.pool.query('alter table orders disable trigger orders_updated_at')
  await ctx.pool.query(
    `update orders set status = 'delivering', updated_at = now() - interval '5 minutes'
     where id = $1`,
    [order.id]
  )
  await ctx.pool.query('alter table orders enable trigger orders_updated_at')

  const recovered = await waitFor(async () => {
    const { rows } = await ctx.pool.query('select status from orders where id = $1', [order.id])
    return rows[0].status === 'delivered'
  })

  expect(recovered).toBe(true)

  const { rows } = await ctx.pool.query(
    'select count(*)::int as used from license_keys where order_id = $1',
    [order.id]
  )
  expect(rows[0].used).toBe(1)
}, 20000)

test('abandoned unpaid order expires and gives its promo use back', async () => {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/orders',
    payload: { sku: 'KEY-CS2-PRIME', idempotencyKey: 'abandoned-promo-1', promoCode: 'ONCEONLY' }
  })

  expect(created.statusCode).toBe(201)
  const order = created.json()
  expect(order.discount).toBeGreaterThan(0)

  const taken = await ctx.pool.query('select used_count from promocodes where code = $1', [
    'ONCEONLY'
  ])
  expect(taken.rows[0].used_count).toBe(1)

  await waitFor(async () => {
    const { rows } = await ctx.pool.query('select status from orders where id = $1', [order.id])
    return rows[0]?.status === 'payment_failed'
  })

  const released = await ctx.pool.query('select used_count from promocodes where code = $1', [
    'ONCEONLY'
  ])
  expect(released.rows[0].used_count).toBe(0)

  const reused = await ctx.app.inject({
    method: 'POST',
    url: '/api/orders',
    payload: { sku: 'KEY-CS2-PRIME', idempotencyKey: 'abandoned-promo-2', promoCode: 'ONCEONLY' }
  })

  expect(reused.statusCode).toBe(201)
  expect(reused.json().discount).toBeGreaterThan(0)
})

test('expired order can no longer be paid', async () => {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/orders',
    payload: { sku: 'KEY-GTA5', idempotencyKey: 'abandoned-pay-1' }
  })

  const order = created.json()

  await waitFor(async () => {
    const { rows } = await ctx.pool.query('select status from orders where id = $1', [order.id])
    return rows[0]?.status === 'payment_failed'
  })

  const late = await ctx.app.inject({
    method: 'POST',
    url: `/api/orders/${order.id}/pay`,
    payload: { outcome: 'success' }
  })

  expect(late.statusCode).toBe(409)
})

test('the abandoned-order sweeper returns the reserved unit to the pool', async () => {
  await ctx.pool.query("delete from license_keys where code <> 'LFXC-TNCS-BPCD'")

  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/orders',
    payload: { sku: 'KEY-CS2-PRIME', idempotencyKey: 'abandoned-unit-1' }
  })

  expect(created.statusCode).toBe(201)
  const order = created.json()

  await waitFor(async () => {
    const { rows } = await ctx.pool.query('select status from orders where id = $1', [order.id])
    return rows[0]?.status === 'payment_failed'
  })

  const { rows } = await ctx.pool.query<{ free: number }>(
    `select count(*)::int as free from license_keys
     where allocated_order_id is null and order_id is null`
  )
  expect(rows[0]?.free).toBe(1)

  const next = await ctx.app.inject({
    method: 'POST',
    url: '/api/orders',
    payload: { sku: 'KEY-CS2-PRIME', idempotencyKey: 'abandoned-unit-next' }
  })
  expect(next.statusCode).toBe(201)
})
