import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createOrder, resetData, startApp, type TestContext } from '../setup/app.ts'

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
  await ctx.pool.query('delete from catalog_events')
})

const events = async (sku: string) => {
  const { rows } = await ctx.pool.query<{ kind: string }>(
    'select kind from catalog_events where sku = $1 order by id',
    [sku]
  )

  return rows.map((row) => row.kind)
}

test('changing a price emits exactly one price event', async () => {
  await ctx.pool.query('update products set price = price + 10 where sku = $1', ['KEY-GTA5'])

  expect(await events('KEY-GTA5')).toEqual(['price'])
})

test('writing the same price emits nothing', async () => {
  await ctx.pool.query('update products set price = price where sku = $1', ['KEY-GTA5'])

  expect(await events('KEY-GTA5')).toEqual([])
})

test('reserving a unit emits a stock event, releasing it emits another', async () => {
  const order = (await createOrder(ctx, 'events-reserve-1')).json()

  expect(await events(order.sku)).toEqual(['stock'])

  await ctx.pool.query(
    'update license_keys set allocated_order_id = null where allocated_order_id = $1',
    [order.id]
  )

  expect(await events(order.sku)).toEqual(['stock', 'stock'])
})

test('touching a key without changing availability emits nothing', async () => {
  await ctx.pool.query("update license_keys set code = code || '' where sku = $1", ['KEY-GTA5'])

  expect(await events('KEY-GTA5')).toEqual([])
})

test('a bulk restock emits one event per sku, not one per key', async () => {
  await ctx.pool.query(
    `insert into license_keys (sku, code)
     select 'KEY-GTA5', 'BULK-' || g from generate_series(1, 25) g`
  )

  expect(await events('KEY-GTA5')).toEqual(['stock'])
})

test('deleting free keys emits a stock event', async () => {
  await ctx.pool.query(
    `delete from license_keys where id in (
       select id from license_keys where sku = 'KEY-GTA5' limit 3
     )`
  )

  expect(await events('KEY-GTA5')).toEqual(['stock'])
})

test('the stream answers as text/event-stream without compression', async () => {
  const response = await ctx.app.inject({
    method: 'GET',
    url: '/api/events',
    headers: { 'accept-encoding': 'gzip' },
    payloadAsStream: true
  })

  expect(response.statusCode).toBe(200)
  expect(response.headers['content-type']).toContain('text/event-stream')
  expect(response.headers['content-encoding']).toBeUndefined()
  expect(response.headers['x-accel-buffering']).toBe('no')

  response.stream().destroy()
})

test('moving a free key to another sku emits events for both', async () => {
  await ctx.pool.query(
    `update license_keys set sku = 'KEY-GTA5'
     where id = (select min(id) from license_keys where sku = 'KEY-EFT')`
  )

  expect(await events('KEY-EFT')).toEqual(['stock'])
  expect(await events('KEY-GTA5')).toEqual(['stock'])
})

test('an aborted transaction leaves no events behind', async () => {
  const client = await ctx.pool.connect()

  try {
    await client.query('begin')
    await client.query("update products set price = price + 100 where sku = 'KEY-GTA5'")
    await client.query('rollback')
  } finally {
    client.release()
  }

  expect(await events('KEY-GTA5')).toEqual([])
})

test('shutting the streams down releases every listener and is idempotent', async () => {
  const { catalogChanges } = await import('../../src/services/catalog-events.ts')
  const { closeCatalogStreams } = await import('../../src/routes/events.ts')

  const before = catalogChanges.listenerCount('change')
  const streams = []

  for (let i = 0; i < 5; i += 1) {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/events',
      payloadAsStream: true
    })

    streams.push(response.stream())
  }

  expect(catalogChanges.listenerCount('change')).toBe(before + 5)

  closeCatalogStreams()
  closeCatalogStreams()

  expect(catalogChanges.listenerCount('change')).toBeLessThanOrEqual(before)

  streams.forEach((stream) => stream.destroy())
})

test('a price change reaches an open stream as an sse event', async () => {
  const response = await ctx.app.inject({
    method: 'GET',
    url: '/api/events',
    payloadAsStream: true
  })

  const stream = response.stream()

  const received = new Promise<string>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('no sse event within 5s')), 5000)

    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()

      if (buffer.includes('event: catalog')) {
        clearTimeout(timer)
        resolve(buffer)
      }
    })
  })

  await ctx.pool.query('update products set price = price + 3 where sku = $1', ['KEY-EFT'])

  const payload = await received

  expect(payload).toContain('event: catalog')
  expect(payload).toContain('"sku":"KEY-EFT"')

  stream.destroy()
})
test('an expiring reservation puts the unit back and announces it', async () => {
  await ctx.pool.query("delete from license_keys where code <> 'LFXC-TNCS-BPCD'")

  const order = (await createOrder(ctx, 'events-expire-1')).json()
  await ctx.pool.query('delete from catalog_events')

  await ctx.pool.query(
    "update orders set reservation_expires_at = now() - interval '1 second' where id = $1",
    [order.id]
  )

  const { expireReservations } = await import('../../src/services/inventory.ts')
  expect(await expireReservations(ctx.pool)).toBe(1)

  expect(await events(order.sku)).toEqual(['stock'])
})
