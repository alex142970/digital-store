import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import {
  createOrder,
  fetchOrder,
  pay,
  resetData,
  startApp,
  type TestContext
} from '../setup/app.ts'
import {
  resetProviderBehaviour,
  setProviderBehaviour
} from '../../src/services/provider-behaviour.ts'
import { deliverOrder } from '../../src/services/delivery.ts'

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
afterEach(() => {
  resetProviderBehaviour()
})

const attempts = async (orderId: string) => {
  const { rows } = await ctx.pool.query<{ provider: string; outcome: string }>(
    'select provider, outcome from delivery_attempts where order_id = $1 order by id',
    [orderId]
  )
  return rows
}

test('a second delivery of the same order reports in_progress while the first is still running', async () => {
  setProviderBehaviour('a', { timeoutRate: 1, errorRate: 0 })
  const order = (await createOrder(ctx, 'inflight-guard-1')).json()
  const payment = pay(ctx, order.id)
  await new Promise((r) => setTimeout(r, 150))

  const second = await deliverOrder(ctx.pool, order.id)
  await payment

  expect(second).toBe('in_progress')
  const { rows } = await ctx.pool.query(
    'select count(*)::int as used from license_keys where order_id = $1',
    [order.id]
  )
  expect(rows[0].used).toBe(1)
})

test('retry of a delivered order does not re-run delivery', async () => {
  const order = (await createOrder(ctx, 'retry-noop-guard-1')).json()
  await pay(ctx, order.id)
  const delivered = (await fetchOrder(ctx, order.id)).json()
  expect(delivered.status).toBe('delivered')

  const before = await attempts(order.id)

  const retry = await ctx.app.inject({
    method: 'POST',
    url: `/api/admin/orders/${order.id}/retry`
  })

  expect(retry.json()).toMatchObject({ status: 'delivered', code: delivered.code })
  expect(await attempts(order.id)).toEqual(before)
  expect(await deliverOrder(ctx.pool, order.id)).toBe('already_delivered')
})

test('re-delivery after a lost result reuses the provider issue instead of burning a second key', async () => {
  const order = (await createOrder(ctx, 'crash-recovery-1')).json()
  await pay(ctx, order.id)
  const first = (await fetchOrder(ctx, order.id)).json()
  expect(first.status).toBe('delivered')

  // the process died right after the provider issued the code: order looks unfinished again
  await ctx.pool.query("update orders set status = 'paid' where id = $1", [order.id])

  expect(await deliverOrder(ctx.pool, order.id)).toBe('delivered')

  const again = (await fetchOrder(ctx, order.id)).json()
  expect(again.code).toBe(first.code)

  const { rows } = await ctx.pool.query(
    `select (select count(*)::int from deliveries where order_id = $1) as deliveries,
            (select count(*)::int from license_keys where order_id is not null) as used`,
    [order.id]
  )
  expect(rows[0]).toEqual({ deliveries: 1, used: 1 })
})

test('stuck list shows an order parked in delivering', async () => {
  const order = (await createOrder(ctx, 'stuck-delivering-1')).json()
  await pay(ctx, order.id)
  await ctx.pool.query("update orders set status = 'delivering' where id = $1", [order.id])

  const response = await ctx.app.inject({ method: 'GET', url: '/api/admin/orders' })
  const ids = response.json().orders.map((o: { id: string }) => o.id)
  expect(ids).toContain(order.id)
})

test('a successful retry clears the failure reason', async () => {
  setProviderBehaviour('a', { errorRate: 1, timeoutRate: 0 })
  setProviderBehaviour('b', { errorRate: 1, timeoutRate: 0 })

  const order = (await createOrder(ctx, 'reason-clear-1')).json()
  await pay(ctx, order.id)
  const failed = (await fetchOrder(ctx, order.id)).json()
  expect(failed.status).toBe('delivery_failed')
  expect(failed.failureReason).toBeTruthy()

  resetProviderBehaviour()

  const retry = await ctx.app.inject({
    method: 'POST',
    url: `/api/admin/orders/${order.id}/retry`
  })
  expect(retry.json()).toMatchObject({ status: 'delivered' })
  expect(retry.json().failureReason).toBeNull()
})

test('an empty key pool is reported by the primary provider without asking the backup', async () => {
  await ctx.pool.query('delete from license_keys')

  const order = (await createOrder(ctx, 'oos-no-fallback-1')).json()
  await pay(ctx, order.id)

  expect((await fetchOrder(ctx, order.id)).json().status).toBe('out_of_stock')
  expect(await attempts(order.id)).toEqual([{ provider: 'a', outcome: 'out_of_stock' }])
})

test('a key locked by someone else is skipped instead of waited on', async () => {
  await ctx.pool.query("delete from license_keys where code <> 'LFXC-TNCS-BPCD'")
  const order = (await createOrder(ctx, 'skip-locked-1')).json()

  const holder = await ctx.pool.connect()
  try {
    await holder.query('begin')
    await holder.query(
      `select id from license_keys where sku = 'KEY-CS2-PRIME' and order_id is null
       order by id for update limit 1`
    )

    const started = Date.now()
    await pay(ctx, order.id)
    const elapsed = Date.now() - started

    expect((await fetchOrder(ctx, order.id)).json().status).toBe('out_of_stock')
    expect(elapsed).toBeLessThan(1000)
  } finally {
    await holder.query('rollback')
    holder.release()
  }
})
