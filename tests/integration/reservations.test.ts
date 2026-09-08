import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import {
  createOrder,
  fetchOrder,
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

const onlyOneKey = () => ctx.pool.query("delete from license_keys where code <> 'LFXC-TNCS-BPCD'")

test('creating an order reserves exactly one key and sets a deadline', async () => {
  const order = (await createOrder(ctx, 'reserve-1')).json()

  const { rows } = await ctx.pool.query<{ reserved: number; deadline: Date | null }>(
    `select (select count(*)::int from license_keys where allocated_order_id = $1) as reserved,
            (select reservation_expires_at from orders where id = $1) as deadline`,
    [order.id]
  )

  expect(rows[0]?.reserved).toBe(1)
  expect(rows[0]?.deadline).not.toBeNull()
})

test('fifty parallel checkouts of the last unit produce one order and forty nine refusals', async () => {
  await onlyOneKey()

  const attempts = await Promise.all(
    Array.from({ length: 50 }, (_, i) => createOrder(ctx, `race-unit-${i}`))
  )

  const created = attempts.filter((r) => r.statusCode === 201)
  const refused = attempts.filter((r) => r.statusCode === 409)

  expect(created).toHaveLength(1)
  expect(refused).toHaveLength(49)
  expect(new Set(refused.map((r) => r.json().error))).toEqual(new Set(['out_of_stock']))

  const winner = created[0]?.json()
  await pay(ctx, winner.id)
  await waitForStatus(ctx, winner.id, ['delivered'])

  const { rows } = await ctx.pool.query<{ orders: number; used: number; deliveries: number }>(
    `select (select count(*)::int from orders) as orders,
            (select count(*)::int from license_keys where order_id is not null) as used,
            (select count(*)::int from deliveries) as deliveries`
  )

  expect(rows[0]).toEqual({ orders: 1, used: 1, deliveries: 1 })
})

test('a refused checkout leaves no order and no reservation behind', async () => {
  await onlyOneKey()

  const attempts = await Promise.all(
    Array.from({ length: 20 }, (_, i) => createOrder(ctx, `race-paid-${i}`))
  )

  const winner = attempts.find((r) => r.statusCode === 201)?.json()

  const { rows } = await ctx.pool.query<{ orders: number; reservations: number }>(
    `select (select count(*)::int from orders) as orders,
            (select count(*)::int from license_keys where allocated_order_id is not null) as reservations`
  )

  expect(rows[0]).toEqual({ orders: 1, reservations: 1 })

  await pay(ctx, winner.id)
  await waitForStatus(ctx, winner.id, ['delivered'])

  const stranded = await ctx.pool.query<{ stranded: number }>(
    `select count(*)::int as stranded from orders o
     left join deliveries d on d.order_id = o.id
     where o.status in ('paid', 'delivering', 'out_of_stock', 'delivery_failed', 'delivered')
       and d.order_id is null`
  )

  expect(stranded.rows[0]?.stranded).toBe(0)
})
test('two concurrent allocations of the same unit: exactly one wins', async () => {
  await onlyOneKey()

  await ctx.pool.query(
    `insert into orders (id, sku, amount, idempotency_key) values
       ('ord_alloc_a', 'KEY-CS2-PRIME', 1290, 'alloc-a'),
       ('ord_alloc_b', 'KEY-CS2-PRIME', 1290, 'alloc-b')`
  )

  const { allocate } = await import('../../src/services/inventory.ts')

  const attempt = async (orderId: string) => {
    const client = await ctx.pool.connect()

    try {
      await client.query('begin')
      const won = await allocate(client, 'KEY-CS2-PRIME', orderId)
      await client.query(won ? 'commit' : 'rollback')
      return won
    } finally {
      client.release()
    }
  }

  const results = await Promise.all([attempt('ord_alloc_a'), attempt('ord_alloc_b')])

  expect(results.filter(Boolean)).toHaveLength(1)

  const { rows } = await ctx.pool.query<{ owners: number }>(
    'select count(*)::int as owners from license_keys where allocated_order_id is not null'
  )
  expect(rows[0]?.owners).toBe(1)
})

test('the unique index forbids two keys reserved by one order', async () => {
  const order = (await createOrder(ctx, 'one-key-per-order')).json()

  await expect(
    ctx.pool.query(
      `update license_keys set allocated_order_id = $1
       where sku = 'KEY-CS2-PRIME' and allocated_order_id is null and order_id is null
         and id = (select min(id) from license_keys
                   where sku = 'KEY-CS2-PRIME' and allocated_order_id is null)`,
      [order.id]
    )
  ).rejects.toThrow(/license_keys_allocation_idx/)
})
test('an expired reservation returns the unit and fails the order', async () => {
  await onlyOneKey()

  const order = (await createOrder(ctx, 'expire-1')).json()

  await ctx.pool.query(
    "update orders set reservation_expires_at = now() - interval '1 second' where id = $1",
    [order.id]
  )

  const { expireReservations } = await import('../../src/services/inventory.ts')
  expect(await expireReservations(ctx.pool)).toBe(1)

  const expired = (await fetchOrder(ctx, order.id)).json()
  expect(expired.status).toBe('payment_failed')

  const { rows } = await ctx.pool.query<{ free: number }>(
    'select count(*)::int as free from license_keys where allocated_order_id is null and order_id is null'
  )
  expect(rows[0]?.free).toBe(1)

  const next = await createOrder(ctx, 'expire-next')
  expect(next.statusCode).toBe(201)
})

test('an expired reservation is never paid: the unit goes back and the order fails', async () => {
  await onlyOneKey()

  const order = (await createOrder(ctx, 'expire-race-1')).json()

  await ctx.pool.query(
    "update orders set reservation_expires_at = now() - interval '1 second' where id = $1",
    [order.id]
  )

  await pay(ctx, order.id)

  const settled = (await fetchOrder(ctx, order.id)).json()
  expect(settled.status).toBe('payment_failed')
  expect(settled.code).toBeNull()

  const { rows } = await ctx.pool.query<{ free: number }>(
    `select count(*)::int as free from license_keys
     where allocated_order_id is null and order_id is null`
  )
  expect(rows[0]?.free).toBe(1)
})

test('payment racing an expiring reservation settles into exactly one consistent outcome', async () => {
  await onlyOneKey()

  const order = (await createOrder(ctx, 'expire-race-2')).json()

  await ctx.pool.query(
    "update orders set reservation_expires_at = now() + interval '40 milliseconds' where id = $1",
    [order.id]
  )

  const { expireReservations } = await import('../../src/services/inventory.ts')

  await new Promise((resolve) => setTimeout(resolve, 40))
  await Promise.all([pay(ctx, order.id), expireReservations(ctx.pool)])

  const settled = await waitForStatus(ctx, order.id, ['delivered', 'payment_failed'])

  const { rows } = await ctx.pool.query<{ owned: number; issued: number; free: number }>(
    `select (select count(*)::int from license_keys where allocated_order_id = $1) as owned,
            (select count(*)::int from license_keys where order_id = $1) as issued,
            (select count(*)::int from license_keys
             where allocated_order_id is null and order_id is null) as free`,
    [order.id]
  )

  if (settled.status === 'delivered') {
    expect(rows[0]).toEqual({ owned: 1, issued: 1, free: 0 })
    expect(settled.code).toBeTruthy()
  } else {
    expect(rows[0]).toEqual({ owned: 0, issued: 0, free: 1 })
    expect(settled.code).toBeNull()
  }
})
test('a rejected amount returns the reserved unit to the pool', async () => {
  await onlyOneKey()

  const order = (await createOrder(ctx, 'wrong-amount-1')).json()

  await ctx.app.inject({
    method: 'POST',
    url: '/webhook/payment',
    payload: {
      event_id: 'evt_wrong_amount',
      order_id: order.id,
      status: 'paid',
      amount: order.total + 100,
      currency: order.currency,
      created_at: new Date().toISOString()
    }
  })

  expect((await fetchOrder(ctx, order.id)).json().status).toBe('payment_failed')

  const { rows } = await ctx.pool.query<{ free: number }>(
    `select count(*)::int as free from license_keys
     where allocated_order_id is null and order_id is null`
  )
  expect(rows[0]?.free).toBe(1)
})

test('allocate refuses to take a unit already reserved by another order', async () => {
  await onlyOneKey()

  const owner = (await createOrder(ctx, 'allocate-guard-owner')).json()

  await ctx.pool.query(
    `insert into orders (id, sku, amount, idempotency_key)
     values ('ord_guard', 'KEY-CS2-PRIME', 1290, 'allocate-guard-other')`
  )

  const { allocate } = await import('../../src/services/inventory.ts')
  const client = await ctx.pool.connect()

  try {
    await client.query('begin')
    expect(await allocate(client, 'KEY-CS2-PRIME', 'ord_guard')).toBe(false)
    await client.query('rollback')
  } finally {
    client.release()
  }

  const { rows } = await ctx.pool.query<{ owner: string }>(
    'select allocated_order_id as owner from license_keys where allocated_order_id is not null'
  )
  expect(rows[0]?.owner).toBe(owner.id)
})

test('a failed payment returns the reserved unit to the pool', async () => {
  await onlyOneKey()

  const order = (await createOrder(ctx, 'failed-pay-1')).json()
  await pay(ctx, order.id, 'fail')

  expect((await fetchOrder(ctx, order.id)).json().status).toBe('payment_failed')

  const { rows } = await ctx.pool.query<{ free: number }>(
    'select count(*)::int as free from license_keys where allocated_order_id is null and order_id is null'
  )
  expect(rows[0]?.free).toBe(1)

  expect((await createOrder(ctx, 'failed-pay-next')).statusCode).toBe(201)
})
