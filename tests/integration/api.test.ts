import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createOrder, pay, resetData, startApp, type TestContext } from '../setup/app.ts'

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

test('catalog returns seeded products ordered by price', async () => {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/products' })
  const { products } = response.json()

  expect(response.statusCode).toBe(200)
  expect(products).toHaveLength(12)
  expect(products.map((p: { price: number }) => p.price)).toEqual(
    [...products.map((p: { price: number }) => p.price)].sort((a, b) => a - b)
  )
})

test('unknown order returns not_found', async () => {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/orders/ord_missing' })

  expect(response.statusCode).toBe(404)
  expect(response.json()).toEqual({ error: 'not_found', message: expect.any(String) })
})

test('unknown product returns product_not_found', async () => {
  const response = await createOrder(ctx, 'unknown-product-1', 'NO-SUCH-SKU')

  expect(response.statusCode).toBe(404)
  expect(response.json().error).toBe('product_not_found')
})

test('invalid body returns validation_error', async () => {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/orders',
    payload: { sku: 'KEY-CS2-PRIME' }
  })

  expect(response.statusCode).toBe(400)
  expect(response.json().error).toBe('validation_error')
})

test('paying an already paid order returns conflict', async () => {
  const order = (await createOrder(ctx, 'double-pay-1')).json()
  await pay(ctx, order.id)

  const second = await pay(ctx, order.id)

  expect(second.statusCode).toBe(409)
  expect(second.json().error).toBe('order_not_payable')
})

test('unknown route returns not_found in the contract shape', async () => {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/nope' })

  expect(response.statusCode).toBe(404)
  expect(response.json()).toEqual({ error: 'not_found', message: expect.any(String) })
})

test('admin endpoints require a valid bearer token', async () => {
  const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/admin/orders' })
  const wrong = await ctx.app.inject({
    method: 'GET',
    url: '/api/admin/orders',
    headers: { authorization: 'Bearer wrong-token' }
  })
  const valid = await ctx.app.inject({
    method: 'GET',
    url: '/api/admin/orders',
    headers: { authorization: 'Bearer test-admin-token' }
  })

  expect(anonymous.statusCode).toBe(401)
  expect(wrong.statusCode).toBe(401)
  expect(valid.statusCode).toBe(501)
})

test('percent encoded admin path stays protected', async () => {
  const response = await ctx.app.inject({ method: 'GET', url: '/%61pi/admin/orders' })

  expect(response.statusCode).toBe(401)
})
