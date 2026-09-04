import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import {
  createOrder,
  fetchOrder,
  paidEvent,
  pay,
  resetData,
  sendWebhook,
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

test('fifty concurrent webhooks deliver exactly one key', async () => {
  const order = (await createOrder(ctx, 'race-webhooks-1')).json()

  const responses = await Promise.all(
    Array.from({ length: 50 }, () => sendWebhook(ctx, paidEvent(order.id)))
  )

  expect(responses.every((r) => r.statusCode === 200)).toBe(true)

  await waitForStatus(ctx, order.id, ['delivered'])

  const { rows } = await ctx.pool.query(
    `select (select count(*) from deliveries)::int as deliveries,
            (select count(*) from license_keys where order_id is not null)::int as used,
            (select status from orders where id = $1) as status`,
    [order.id]
  )
  expect(rows[0]).toEqual({ deliveries: 1, used: 1, status: 'delivered' })
})

test('concurrent orders never share a key', async () => {
  const orders = await Promise.all(
    Array.from({ length: 10 }, (_, i) => createOrder(ctx, `race-orders-${i}-key`))
  )

  await Promise.all(orders.map((response) => pay(ctx, response.json().id)))

  const { rows } = await ctx.pool.query(
    `select count(*)::int as used, count(distinct order_id)::int as owners
     from license_keys where order_id is not null`
  )
  expect(rows[0].used).toBe(10)
  expect(rows[0].owners).toBe(10)
})

test('the last free key goes to exactly one of two competing orders', async () => {
  await ctx.pool.query("delete from license_keys where code <> 'LFXC-TNCS-BPCD'")

  const first = (await createOrder(ctx, 'last-key-first')).json()
  const second = (await createOrder(ctx, 'last-key-second')).json()

  const holder = await ctx.pool.connect()

  try {
    await holder.query('begin')
    await holder.query(
      `select id from license_keys where sku = 'KEY-CS2-PRIME' and order_id is null
       order by id for update limit 1`
    )

    const blocked = pay(ctx, first.id)
    await new Promise((resolve) => setTimeout(resolve, 200))
    await holder.query('rollback')
    await blocked
  } finally {
    holder.release()
  }

  await pay(ctx, second.id)

  const statuses = [
    (await fetchOrder(ctx, first.id)).json(),
    (await fetchOrder(ctx, second.id)).json()
  ]

  const delivered = statuses.filter((order) => order.status === 'delivered')
  const codes = new Set(statuses.map((order) => order.code).filter(Boolean))

  expect(delivered.length).toBeGreaterThanOrEqual(1)
  expect(codes.size).toBe(delivered.length)

  const { rows } = await ctx.pool.query(
    'select count(*)::int as used from license_keys where order_id is not null'
  )
  expect(rows[0].used).toBe(delivered.length)
})

test('concurrent creation with one idempotency key produces a single order', async () => {
  const responses = await Promise.all(
    Array.from({ length: 20 }, () => createOrder(ctx, 'race-idempotency-key'))
  )

  const created = responses.filter((r) => r.statusCode === 201)
  const reused = responses.filter((r) => r.statusCode === 200)
  const ids = new Set(responses.map((r) => r.json().id))

  expect(created).toHaveLength(1)
  expect(reused).toHaveLength(19)
  expect(ids.size).toBe(1)

  const { rows } = await ctx.pool.query('select count(*)::int as count from orders')
  expect(rows[0].count).toBe(1)
})
