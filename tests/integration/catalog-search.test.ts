import { afterAll, beforeAll, expect, test } from 'vitest'
import { bulkCatalog } from '../../src/db/bulk-catalog.ts'
import { searchCatalog } from '../../src/services/catalog.ts'
import { resetData, startApp, type TestContext } from '../setup/app.ts'

let ctx: TestContext

beforeAll(async () => {
  ctx = await startApp()
  await resetData(ctx.pool)

  const bulk = bulkCatalog(400)

  await ctx.pool.query(
    `insert into products (sku, name, type, price, currency)
     select * from unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[])
     on conflict (sku) do nothing`,
    [
      bulk.map((item) => item.sku),
      bulk.map((item) => item.name),
      bulk.map((item) => item.type),
      bulk.map((item) => item.price),
      bulk.map((item) => item.currency)
    ]
  )

  await ctx.pool.query(
    `insert into license_keys (sku, code)
     select p.sku, upper(substr(md5(p.sku || ':' || n::text), 1, 12))
     from products p cross join generate_series(1, 3) as n
     where p.sku like 'BULK-%' and abs(hashtext(p.sku)) % 7 <> 0
     on conflict (code) do nothing`
  )
})

afterAll(async () => {
  await ctx.pool.query("delete from license_keys where sku like 'BULK-%'")
  await ctx.pool.query("delete from products where sku like 'BULK-%'")
  await ctx.app.close()
  await ctx.pool.end()
})

const search = (query: Parameters<typeof searchCatalog>[1]) => searchCatalog(ctx.pool, query)

test('каталог наполнен тысячами позиций, счётчик считает все подходящие', async () => {
  const page = await search({ limit: 10 })

  expect(page.items).toHaveLength(10)
  expect(page.total).toBeGreaterThan(400)
})

test('поиск находит по подстроке названия', async () => {
  const page = await search({ q: 'tarkov', limit: 50 })

  expect(page.total).toBeGreaterThan(0)
  expect(page.items.every((item) => item.name.toLowerCase().includes('tarkov'))).toBe(true)
})

test('поиск нечувствителен к регистру', async () => {
  const lower = await search({ q: 'steam', limit: 1 })
  const upper = await search({ q: 'STEAM', limit: 1 })

  expect(upper.total).toBe(lower.total)
})

test('поиск находит по коду позиции, а не только по названию', async () => {
  const page = await search({ q: 'BULK-TOP', limit: 5 })

  expect(page.total).toBeGreaterThan(0)
  expect(page.items.every((item) => item.sku.startsWith('BULK-TOP'))).toBe(true)
})

test('фильтр по типу отсекает всё остальное', async () => {
  const page = await search({ type: 'subscription', limit: 50 })

  expect(page.total).toBeGreaterThan(0)
  expect(page.items.every((item) => item.type === 'subscription')).toBe(true)
})

test('диапазон цены соблюдается на обеих границах', async () => {
  const page = await search({ min: 500, max: 900, limit: 50 })

  expect(page.total).toBeGreaterThan(0)
  expect(page.items.every((item) => item.price >= 500 && item.price <= 900)).toBe(true)
})

test('фильтр наличия оставляет только позиции со свободными ключами', async () => {
  const all = await search({ limit: 1 })
  const inStock = await search({ stock: true, limit: 50 })

  expect(inStock.total).toBeLessThan(all.total)
  expect(inStock.items.every((item) => (item.available ?? 0) > 0)).toBe(true)
})

test('сортировка по цене возрастает и убывает', async () => {
  const asc = await search({ sort: 'price', limit: 20 })
  const desc = await search({ sort: 'priceDesc', limit: 20 })

  const prices = asc.items.map((item) => item.price)
  const reversed = desc.items.map((item) => item.price)

  expect(prices).toEqual([...prices].sort((a, b) => a - b))
  expect(reversed).toEqual([...reversed].sort((a, b) => b - a))
})

test('постраничная выдача не повторяет и не теряет позиции', async () => {
  const first = await search({ sort: 'price', limit: 20, offset: 0 })
  const second = await search({ sort: 'price', limit: 20, offset: 20 })

  const seen = new Set([...first.items, ...second.items].map((item) => item.sku))

  expect(seen.size).toBe(40)
  expect(first.total).toBe(second.total)
})

test('счётчик не зависит от страницы', async () => {
  const page = await search({ q: 'steam', limit: 5, offset: 0 })
  const deeper = await search({ q: 'steam', limit: 5, offset: 5 })

  expect(deeper.total).toBe(page.total)
})

test('фильтры складываются, а не заменяют друг друга', async () => {
  const page = await search({ q: 'steam', type: 'topup', stock: true, limit: 50 })

  expect(
    page.items.every(
      (item) =>
        item.type === 'topup' &&
        item.name.toLowerCase().includes('steam') &&
        (item.available ?? 0) > 0
    )
  ).toBe(true)
})

test('пустой результат — это ноль и пустой список, а не ошибка', async () => {
  const page = await search({ q: 'такоготочнонет', limit: 10 })

  expect(page).toEqual({ items: [], total: 0 })
})

test('размер страницы ограничен сверху', async () => {
  const page = await search({ limit: 500 })

  expect(page.items.length).toBeLessThanOrEqual(60)
})

test('поиск по подстроке опирается на триграммный индекс, а не на полный проход', async () => {
  const client = await ctx.pool.connect()

  try {
    await client.query('begin')
    await client.query('set local enable_seqscan = off')

    const { rows } = await client.query<{ 'QUERY PLAN': string }>(
      `explain select p.sku from products p
       where p.search_text like '%' || $1 || '%' escape '\\'`,
      ['tarkov']
    )

    const plan = rows.map((row) => row['QUERY PLAN']).join('\n')

    expect(plan).toContain('products_search_idx')
  } finally {
    await client.query('rollback').catch(() => {})
    client.release()
  }
})

test('фильтр наличия опирается на хранимый признак, а не на подсчёт ключей', async () => {
  const { rows } = await ctx.pool.query<{ 'QUERY PLAN': string }>(
    'explain select p.sku from products p where p.in_stock order by p.price limit 24'
  )

  const plan = rows.map((row) => row['QUERY PLAN']).join('\n')

  expect(plan).toContain('products_in_stock_idx')
  expect(plan).not.toContain('license_keys')
})

test('признак наличия сходится с фактическим числом свободных ключей', async () => {
  const { rows } = await ctx.pool.query<{ drift: number }>(
    `select count(*)::int as drift from products p
     where p.in_stock <> exists (
       select 1 from license_keys k
       where k.sku = p.sku and k.allocated_order_id is null and k.order_id is null
     )`
  )

  expect(rows[0]?.drift).toBe(0)
})
