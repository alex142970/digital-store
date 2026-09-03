import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { fetchOrder, pay, resetData, startApp, type TestContext } from '../setup/app.ts'

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

const order = (idempotencyKey: string, promoCode?: string, sku = 'KEY-CS2-PRIME') =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/orders',
    payload: promoCode ? { sku, idempotencyKey, promoCode } : { sku, idempotencyKey }
  })

test('percent promo code is applied by the server', async () => {
  const response = await order('promo-percent-1', 'WELCOME10')

  expect(response.statusCode).toBe(201)
  expect(response.json()).toMatchObject({
    amount: 1290,
    discount: 129,
    total: 1161,
    promoCode: 'WELCOME10'
  })
})

test('fixed amount promo code never makes the total negative', async () => {
  const response = await order('promo-amount-1', 'GG500', 'SUB-SPOTIFY-1M')

  expect(response.statusCode).toBe(201)
  expect(response.json()).toMatchObject({ amount: 299, discount: 299, total: 0 })
})

test('fixed amount promo code is subtracted from a larger order', async () => {
  const response = await order('promo-amount-2', 'GG500')

  expect(response.statusCode).toBe(201)
  expect(response.json()).toMatchObject({ amount: 1290, discount: 500, total: 790 })
})

test('unknown promo code is rejected', async () => {
  const response = await order('promo-unknown-1', 'NOPE')

  expect(response.statusCode).toBe(404)
  expect(response.json().error).toBe('promo_not_found')
})

test('promo code limit is respected under parallel requests', async () => {
  const responses = await Promise.all(
    Array.from({ length: 25 }, (_, i) => order(`promo-limit-${i}-key`, 'LIMIT3'))
  )

  const created = responses.filter((r) => r.statusCode === 201)
  const rejected = responses.filter((r) => r.statusCode === 409)

  expect(created).toHaveLength(3)
  expect(rejected).toHaveLength(22)
  expect(rejected.every((r) => r.json().error === 'promo_limit_reached')).toBe(true)

  const { rows } = await ctx.pool.query(
    `select (select used_count from promocodes where code = 'LIMIT3') as used,
            (select count(*)::int from promocode_uses where code = 'LIMIT3') as uses`
  )
  expect(rows[0]).toEqual({ used: 3, uses: 3 })
})

test('single use promo code is usable exactly once', async () => {
  const first = await order('promo-once-1', 'ONCEONLY')
  const second = await order('promo-once-2', 'ONCEONLY')

  expect(first.statusCode).toBe(201)
  expect(second.statusCode).toBe(409)
  expect(second.json().error).toBe('promo_limit_reached')
})

test('promo use is returned when the payment fails', async () => {
  const created = (await order('promo-refund-1', 'ONCEONLY')).json()

  await pay(ctx, created.id, 'fail')

  const failed = (await fetchOrder(ctx, created.id)).json()
  expect(failed.status).toBe('payment_failed')

  const { rows } = await ctx.pool.query(
    `select (select used_count from promocodes where code = 'ONCEONLY') as used,
            (select count(*)::int from promocode_uses where code = 'ONCEONLY') as uses`
  )
  expect(rows[0]).toEqual({ used: 0, uses: 0 })

  const retry = await order('promo-refund-2', 'ONCEONLY')
  expect(retry.statusCode).toBe(201)
})

test('promo use is returned when the payment amount does not match', async () => {
  const created = (await order('promo-refund-mismatch-1', 'ONCEONLY')).json()

  await ctx.app.inject({
    method: 'POST',
    url: '/webhook/payment',
    payload: {
      event_id: 'evt_refund_mismatch',
      order_id: created.id,
      status: 'paid',
      amount: 1,
      currency: 'RUB',
      created_at: new Date().toISOString()
    }
  })

  const { rows } = await ctx.pool.query("select used_count from promocodes where code = 'ONCEONLY'")
  expect(rows[0].used_count).toBe(0)
})

test('fixed amount promo without a currency is rejected', async () => {
  await ctx.pool.query(
    `insert into promocodes (code, type, value, currency, max_uses)
     values ('NOCUR', 'amount', 100, null, 10)`
  )

  const response = await order('promo-nocur-1', 'NOCUR')

  expect(response.statusCode).toBe(409)
  expect(response.json().error).toBe('promo_currency_mismatch')

  const { rows } = await ctx.pool.query("select used_count from promocodes where code = 'NOCUR'")
  expect(rows[0].used_count).toBe(0)
})

test('paying a discounted order with the pre-discount amount is rejected', async () => {
  const created = (await order('promo-wrong-amount-1', 'WELCOME10')).json()

  await ctx.app.inject({
    method: 'POST',
    url: '/webhook/payment',
    payload: {
      event_id: 'evt_wrong_discount',
      order_id: created.id,
      status: 'paid',
      amount: 1290,
      currency: 'RUB',
      created_at: new Date().toISOString()
    }
  })

  const rejected = (await fetchOrder(ctx, created.id)).json()
  expect(rejected.status).toBe('payment_failed')
  expect(rejected.code).toBeNull()
})

test('rejected promo code does not consume a use', async () => {
  await Promise.all(Array.from({ length: 10 }, (_, i) => order(`promo-waste-${i}-key`, 'ONCEONLY')))

  const { rows } = await ctx.pool.query("select used_count from promocodes where code = 'ONCEONLY'")
  expect(rows[0].used_count).toBe(1)
})

test('repeated idempotency key does not consume the promo code twice', async () => {
  await order('promo-idem-key-1', 'LIMIT3')
  await order('promo-idem-key-1', 'LIMIT3')

  const { rows } = await ctx.pool.query("select used_count from promocodes where code = 'LIMIT3'")
  expect(rows[0].used_count).toBe(1)
})

test('parallel double click with a promo code consumes exactly one use', async () => {
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => order('promo-parallel-idem-key', 'LIMIT3'))
  )

  const created = responses.filter((r) => r.statusCode === 201)
  const reused = responses.filter((r) => r.statusCode === 200)
  const ids = new Set(responses.map((r) => r.json().id).filter(Boolean))

  expect(created).toHaveLength(1)
  expect(reused).toHaveLength(9)
  expect(ids.size).toBe(1)

  const { rows } = await ctx.pool.query(
    `select (select used_count from promocodes where code = 'LIMIT3') as used,
            (select count(*)::int from promocode_uses where code = 'LIMIT3') as uses,
            (select count(*)::int from orders) as orders`
  )
  expect(rows[0]).toEqual({ used: 1, uses: 1, orders: 1 })
})

test('parallel double click with a single use promo returns the same order to everyone', async () => {
  const responses = await Promise.all(
    Array.from({ length: 20 }, () => order('promo-once-parallel-key', 'ONCEONLY'))
  )

  const created = responses.filter((r) => r.statusCode === 201)
  const reused = responses.filter((r) => r.statusCode === 200)

  expect(created).toHaveLength(1)
  expect(reused).toHaveLength(19)
  expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(0)

  const { rows } = await ctx.pool.query(
    `select (select used_count from promocodes where code = 'ONCEONLY') as used,
            (select count(*)::int from orders) as orders`
  )
  expect(rows[0]).toEqual({ used: 1, orders: 1 })
})

test('idempotency key reused with different parameters is rejected', async () => {
  await order('promo-params-key', 'WELCOME10')

  const differentSku = await order('promo-params-key', 'WELCOME10', 'SUB-SPOTIFY-1M')
  const differentPromo = await order('promo-params-key', 'LIMIT3')

  expect(differentSku.statusCode).toBe(409)
  expect(differentSku.json().error).toBe('conflict')
  expect(differentPromo.statusCode).toBe(409)
})

test('discounted order is paid and delivered by the discounted total', async () => {
  const created = (await order('promo-delivery-1', 'WELCOME10')).json()

  await pay(ctx, created.id)

  const delivered = (await fetchOrder(ctx, created.id)).json()
  expect(delivered.status).toBe('delivered')
  expect(delivered.total).toBe(1161)
  expect(delivered.code).toBeTruthy()
})

test('promo code in another currency is rejected and not consumed', async () => {
  await ctx.pool.query(
    `insert into promocodes (code, type, value, currency, max_uses)
     values ('USD5', 'amount', 5, 'USD', 10)`
  )

  const response = await order('promo-currency-1', 'USD5')

  expect(response.statusCode).toBe(409)
  expect(response.json().error).toBe('promo_currency_mismatch')

  const { rows } = await ctx.pool.query(
    `select (select used_count from promocodes where code = 'USD5') as used,
            (select count(*)::int from promocode_uses) as uses,
            (select count(*)::int from orders) as orders`
  )
  expect(rows[0]).toEqual({ used: 0, uses: 0, orders: 0 })
})

test('percent discount is rounded down to a whole currency unit', async () => {
  const response = await order('promo-rounding-1', 'LIMIT3')

  expect(response.statusCode).toBe(201)
  expect(response.json()).toMatchObject({ amount: 1290, discount: 322, total: 968 })
})

test('exhausted promo code is rejected with 409 and leaves no order behind', async () => {
  const first = await order('promo-exhausted-first', 'ONCEONLY')
  const later = await Promise.all(
    Array.from({ length: 5 }, (_, i) => order(`promo-exhausted-later-${i}`, 'ONCEONLY'))
  )

  expect(first.statusCode).toBe(201)
  expect(later.map((r) => r.statusCode)).toEqual([409, 409, 409, 409, 409])
  expect(later.every((r) => r.json().error === 'promo_limit_reached')).toBe(true)

  const { rows } = await ctx.pool.query(
    `select (select used_count from promocodes where code = 'ONCEONLY') as used,
            (select count(*)::int from promocode_uses where code = 'ONCEONLY') as uses,
            (select count(*)::int from orders) as orders`
  )
  expect(rows[0]).toEqual({ used: 1, uses: 1, orders: 1 })
})

test('client cannot smuggle the discount base into the order body', async () => {
  for (const extra of [{ amount: 1 }, { discount: 1290 }, { total: 0 }]) {
    const field = Object.keys(extra)[0]
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: {
        sku: 'KEY-CS2-PRIME',
        idempotencyKey: `promo-smuggle-${field}`,
        promoCode: 'WELCOME10',
        ...extra
      }
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('validation_error')
  }

  const { rows } = await ctx.pool.query('select count(*)::int as orders from orders')
  expect(rows[0].orders).toBe(0)
})
