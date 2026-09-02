process.env.DELIVERY_SWEEP_INTERVAL_MS = '50'

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
