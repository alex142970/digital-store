import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import {
  createOrder,
  fetchOrder,
  pay,
  resetData,
  startApp,
  type TestContext
} from '../setup/app.ts'

let ctx: TestContext

const auth = { authorization: 'Bearer test-admin-token' }

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

test('stuck list shows paid but undelivered orders only', async () => {
  await ctx.pool.query('delete from license_keys')

  const stuck = (await createOrder(ctx, 'admin-stuck-1')).json()
  await pay(ctx, stuck.id)

  const untouched = (await createOrder(ctx, 'admin-untouched-1')).json()

  const response = await ctx.app.inject({
    method: 'GET',
    url: '/api/admin/orders',
    headers: auth
  })

  const ids = response.json().orders.map((order: { id: string }) => order.id)

  expect(response.statusCode).toBe(200)
  expect(ids).toContain(stuck.id)
  expect(ids).not.toContain(untouched.id)
})

test('restock adds keys and reports availability', async () => {
  await ctx.pool.query('delete from license_keys')

  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/keys',
    headers: auth,
    payload: { sku: 'KEY-CS2-PRIME', keys: ['ADMN-0001-0001', 'ADMN-0002-0002'] }
  })

  expect(response.statusCode).toBe(201)
  expect(response.json()).toMatchObject({ sku: 'KEY-CS2-PRIME', added: 2, available: 2 })
})

test('restock then retry delivers exactly one key and repeated retry is a no-op', async () => {
  await ctx.pool.query('delete from license_keys')

  const order = (await createOrder(ctx, 'admin-recovery-1')).json()
  await pay(ctx, order.id)
  expect((await fetchOrder(ctx, order.id)).json().status).toBe('out_of_stock')

  await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/keys',
    headers: auth,
    payload: { sku: 'KEY-CS2-PRIME', keys: ['ADMN-RTRY-0001'] }
  })

  const first = await ctx.app.inject({
    method: 'POST',
    url: `/api/admin/orders/${order.id}/retry`,
    headers: auth
  })

  expect(first.statusCode).toBe(200)
  expect(first.json()).toMatchObject({ status: 'delivered', code: 'ADMN-RTRY-0001' })

  const second = await ctx.app.inject({
    method: 'POST',
    url: `/api/admin/orders/${order.id}/retry`,
    headers: auth
  })

  expect(second.json()).toMatchObject({ status: 'delivered', code: 'ADMN-RTRY-0001' })

  const { rows } = await ctx.pool.query(
    `select (select count(*)::int from deliveries where order_id = $1) as deliveries,
            (select count(*)::int from license_keys where order_id is not null) as used`,
    [order.id]
  )
  expect(rows[0]).toEqual({ deliveries: 1, used: 1 })
})

test('admin endpoints reject requests without a token', async () => {
  const list = await ctx.app.inject({ method: 'GET', url: '/api/admin/orders' })
  const restock = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/keys',
    payload: { sku: 'KEY-CS2-PRIME', keys: ['X'] }
  })

  expect(list.statusCode).toBe(401)
  expect(restock.statusCode).toBe(401)
})
