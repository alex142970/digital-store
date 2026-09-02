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
  const { rows } = await ctx.pool.query<{
    outcome: string
    provider: string
    detail: string | null
  }>('select provider, outcome, detail from delivery_attempts where order_id = $1 order by id', [
    orderId
  ])
  return rows
}

test('timeout is not treated as a refusal: retry returns the same code, fallback is not used', async () => {
  setProviderBehaviour('a', { timeoutRate: 1, errorRate: 0 })

  const order = (await createOrder(ctx, 'timeout-recovery-1')).json()
  await pay(ctx, order.id)

  const delivered = (await fetchOrder(ctx, order.id)).json()
  expect(delivered.status).toBe('delivered')
  expect(delivered.code).toBeTruthy()

  const log = await attempts(order.id)
  expect(log[0]).toMatchObject({ provider: 'a', outcome: 'unknown', detail: 'timeout' })
  expect(log.at(-1)).toMatchObject({ provider: 'a', outcome: 'issued' })
  expect(log.some((attempt) => attempt.provider === 'b')).toBe(false)

  const { rows } = await ctx.pool.query(
    'select count(*)::int as used from license_keys where order_id = $1',
    [order.id]
  )
  expect(rows[0].used).toBe(1)
})

test('provider returns the same code for a repeated request_id and a new one for another', async () => {
  const first_order = (await createOrder(ctx, 'contract-order-1')).json()
  const second_order = (await createOrder(ctx, 'contract-order-2')).json()
  const payload = {
    request_id: `req_${first_order.id}`,
    sku: 'KEY-CS2-PRIME',
    order_id: first_order.id
  }

  const first = await ctx.app.inject({
    method: 'POST',
    url: '/internal/providers/a/issue',
    payload
  })
  const repeat = await ctx.app.inject({
    method: 'POST',
    url: '/internal/providers/a/issue',
    payload
  })
  const other = await ctx.app.inject({
    method: 'POST',
    url: '/internal/providers/a/issue',
    payload: {
      ...payload,
      request_id: `req_${second_order.id}`,
      order_id: second_order.id
    }
  })

  expect(repeat.json().code).toBe(first.json().code)
  expect(other.json().code).not.toBe(first.json().code)
})

test('delivery always asks the provider with a request id derived from the order', async () => {
  const order = (await createOrder(ctx, 'request-id-stable-1')).json()
  await pay(ctx, order.id)

  const { rows } = await ctx.pool.query<{ request_id: string }>(
    'select distinct request_id from delivery_attempts where order_id = $1',
    [order.id]
  )

  expect(rows).toHaveLength(1)
  expect(rows[0]?.request_id).toBe(`req_${order.id}`)

  const delivery = await ctx.pool.query<{ request_id: string }>(
    'select request_id from deliveries where order_id = $1',
    [order.id]
  )
  expect(delivery.rows[0]?.request_id).toBe(`req_${order.id}`)
})

test('order is observable in delivering while the provider is slow', async () => {
  setProviderBehaviour('a', { timeoutRate: 1, errorRate: 0 })

  const order = (await createOrder(ctx, 'delivering-visible-1')).json()
  const payment = pay(ctx, order.id)

  await new Promise((resolve) => setTimeout(resolve, 300))
  const midFlight = (await fetchOrder(ctx, order.id)).json()

  await payment

  expect(midFlight.status).toBe('delivering')
  expect(midFlight.code).toBeNull()
})

test('explicit refusal from the primary provider falls back to the backup one', async () => {
  setProviderBehaviour('a', { errorRate: 1, timeoutRate: 0 })
  setProviderBehaviour('b', { errorRate: 0, timeoutRate: 0 })

  const order = (await createOrder(ctx, 'fallback-to-b-1')).json()
  await pay(ctx, order.id)

  const delivered = (await fetchOrder(ctx, order.id)).json()
  expect(delivered.status).toBe('delivered')

  const log = await attempts(order.id)
  expect(log[0]).toMatchObject({ provider: 'a', outcome: 'refused' })
  expect(log.at(-1)).toMatchObject({ provider: 'b', outcome: 'issued' })

  const { rows } = await ctx.pool.query('select provider from deliveries where order_id = $1', [
    order.id
  ])
  expect(rows[0].provider).toBe('b')
})

test('both providers failing leaves the order in delivery_failed', async () => {
  setProviderBehaviour('a', { errorRate: 1, timeoutRate: 0 })
  setProviderBehaviour('b', { errorRate: 1, timeoutRate: 0 })

  const order = (await createOrder(ctx, 'both-fail-1')).json()
  await pay(ctx, order.id)

  const failed = (await fetchOrder(ctx, order.id)).json()
  expect(failed.status).toBe('delivery_failed')
  expect(failed.code).toBeNull()
  expect(failed.failureReason).toContain('provider')

  const { rows } = await ctx.pool.query(
    'select count(*)::int as used from license_keys where order_id is not null'
  )
  expect(rows[0].used).toBe(0)
})

test('delivery recovers after providers come back', async () => {
  setProviderBehaviour('a', { errorRate: 1, timeoutRate: 0 })
  setProviderBehaviour('b', { errorRate: 1, timeoutRate: 0 })

  const order = (await createOrder(ctx, 'provider-recovery-1')).json()
  await pay(ctx, order.id)
  expect((await fetchOrder(ctx, order.id)).json().status).toBe('delivery_failed')

  resetProviderBehaviour()
  setProviderBehaviour('a', { errorRate: 0, timeoutRate: 0 })

  const retry = await ctx.app.inject({
    method: 'POST',
    url: `/api/admin/orders/${order.id}/retry`,
    headers: { authorization: 'Bearer test-admin-token' }
  })

  expect(retry.statusCode).toBe(200)
  expect(retry.json().status).toBe('delivered')
})
