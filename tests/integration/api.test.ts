import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createOrder, pay, resetData, startApp, type TestContext } from '../setup/app.ts'

const catalog = JSON.parse(
  await readFile(new URL('../../data/catalog.json', import.meta.url), 'utf8')
) as { products: { sku: string; price: number }[] }

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
  expect(products).toHaveLength(catalog.products.length)
  expect(products.map((p: { sku: string }) => p.sku)).toEqual(
    [...catalog.products]
      .sort((a, b) => a.price - b.price || a.sku.localeCompare(b.sku))
      .map((p) => p.sku)
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

test('repeating the same payment is accepted and changes nothing', async () => {
  const order = (await createOrder(ctx, 'double-pay-1')).json()
  const first = await pay(ctx, order.id)

  const second = await pay(ctx, order.id)

  expect(second.statusCode).toBe(202)
  expect(second.json().eventId).toBe(first.json().eventId)
})

test('changing the outcome after payment is a conflict', async () => {
  const order = (await createOrder(ctx, 'double-pay-2')).json()
  await pay(ctx, order.id)

  const other = await pay(ctx, order.id, 'fail')

  expect(other.statusCode).toBe(409)
  expect(other.json().error).toBe('order_not_payable')
})

test('unknown route returns not_found in the contract shape', async () => {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/nope' })

  expect(response.statusCode).toBe(404)
  expect(response.json()).toEqual({ error: 'not_found', message: expect.any(String) })
})

test('admin endpoints are open and need no credentials', async () => {
  const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/admin/orders' })

  expect(anonymous.statusCode).toBe(200)
  expect(anonymous.json()).toHaveProperty('orders')
})
