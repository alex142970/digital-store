import pg from 'pg'

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:3000'
const DATABASE_URL = process.env.DATABASE_URL
const RAW_CONCURRENCY = Number(process.env.RACE_CONCURRENCY ?? 50)
const SKU = 'RACE-TEST-ITEM'
const PRICE = 1000
const REQUEST_TIMEOUT_MS = 15_000

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required, run through "npm run race" or export it manually')
  process.exit(1)
}

if (!Number.isInteger(RAW_CONCURRENCY) || RAW_CONCURRENCY < 2 || RAW_CONCURRENCY > 500) {
  console.error(
    `RACE_CONCURRENCY must be an integer between 2 and 500, got ${process.env.RACE_CONCURRENCY}`
  )
  process.exit(1)
}

const CONCURRENCY = RAW_CONCURRENCY

type ApiResponse = { status: number; body: Record<string, unknown> | null }
type CheckResult = { name: string; ok: boolean }
type Stats = { deliveries: number; used: number; status: string | null }

const pool = new pg.Pool({ connectionString: DATABASE_URL })
const results: CheckResult[] = []

const request = async (path: string, init?: RequestInit): Promise<ApiResponse> => {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  return { status: response.status, body }
}

const post = (path: string, payload: unknown) =>
  request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })

const get = (path: string) => request(path)

const check = (name: string, expected: unknown, actual: unknown, extra?: unknown) => {
  const ok = JSON.stringify(expected) === JSON.stringify(actual)
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`)
  if (!ok) {
    console.log(`     expected ${JSON.stringify(expected)}`)
    console.log(`     actual   ${JSON.stringify(actual)}`)
    if (extra !== undefined) console.log(`     details  ${JSON.stringify(extra)}`)
  }
}

const countStatuses = (responses: ApiResponse[]) =>
  responses.reduce<Record<number, number>>((acc, response) => {
    acc[response.status] = (acc[response.status] ?? 0) + 1
    return acc
  }, {})

const countOrderStates = (states: ApiResponse[]) =>
  states.reduce<Record<string, number>>((acc, state) => {
    const status = String(state.body?.status ?? `http_${state.status}`)
    acc[status] = (acc[status] ?? 0) + 1
    return acc
  }, {})

const stats = async (orderId: string): Promise<Stats> => {
  const { rows } = await pool.query<Stats>(
    `select (select count(*)::int from deliveries d join orders o on o.id = d.order_id where o.sku = $1) as deliveries,
            (select count(*)::int from license_keys where sku = $1 and order_id is not null) as used,
            (select status from orders where id = $2) as status`,
    [SKU, orderId]
  )
  const row = rows[0]
  if (!row) throw new Error('stats query returned no rows')
  return row
}

const cleanup = async () => {
  await pool.query(
    'delete from promocode_uses where order_id in (select id from orders where sku = $1)',
    [SKU]
  )
  await pool.query("delete from promocodes where code = 'RACELIMIT3'")
  await pool.query("delete from provider_issues where request_id like 'req_ord_%'")
  await pool.query(
    'delete from deliveries where order_id in (select id from orders where sku = $1)',
    [SKU]
  )
  await pool.query('delete from webhook_events where order_id like $1', ['ord_race_%'])
  await pool.query(
    'delete from webhook_events where order_id in (select id from orders where sku = $1)',
    [SKU]
  )
  await pool.query('delete from license_keys where sku = $1', [SKU])
  await pool.query('delete from orders where sku = $1', [SKU])
}

const resetFixture = async (keyCount: number) => {
  await cleanup()
  await pool.query(
    `insert into products (sku, name, type, price, currency)
     values ($1, 'Race test item', 'key', $2, 'RUB')
     on conflict (sku) do update set price = excluded.price`,
    [SKU, PRICE]
  )
  if (keyCount > 0) {
    const codes = Array.from(
      { length: keyCount },
      (_, i) => `RACE-${String(i).padStart(4, '0')}-TEST`
    )
    await pool.query(
      'insert into license_keys (sku, code) select $1, unnest($2::text[]) on conflict (code) do nothing',
      [SKU, codes]
    )
  }
}

const newOrder = async (key: string): Promise<string> => {
  const { status, body } = await post('/api/orders', { sku: SKU, idempotencyKey: key })
  const id = body?.id
  if (status !== 201 || typeof id !== 'string') {
    throw new Error(`failed to create order: http ${status} ${JSON.stringify(body)}`)
  }
  return id
}

const paidEvent = (orderId: string, index: number) => ({
  event_id: `evt_race_${orderId}_${index}`,
  order_id: orderId,
  status: 'paid',
  amount: PRICE,
  currency: 'RUB',
  created_at: new Date().toISOString()
})

const run = async () => {
  const health = await get('/api/health')
  if (health.status !== 200) {
    throw new Error(`server at ${BASE_URL} is not healthy: http ${health.status}`)
  }

  console.log(`target:      ${BASE_URL}`)
  console.log(`concurrency: ${CONCURRENCY}`)
  console.log(`fixture:     product ${SKU}, created and removed by this script\n`)

  await resetFixture(CONCURRENCY)
  const doubleClick = await Promise.all(
    Array.from({ length: CONCURRENCY }, () =>
      post('/api/orders', { sku: SKU, idempotencyKey: 'race-double-click' })
    )
  )
  check(
    '[ТЗ 5] двойной клик «Купить»: один заказ на все параллельные запросы',
    { created: 1, reused: CONCURRENCY - 1, uniqueOrders: 1 },
    {
      created: doubleClick.filter((r) => r.status === 201).length,
      reused: doubleClick.filter((r) => r.status === 200).length,
      uniqueOrders: new Set(doubleClick.map((r) => r.body?.id)).size
    },
    countStatuses(doubleClick)
  )

  await resetFixture(CONCURRENCY)
  const parallelOrder = await newOrder('race-parallel-webhooks')
  const webhooks = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      post('/webhook/payment', paidEvent(parallelOrder, i))
    )
  )
  const parallelStats = await stats(parallelOrder)
  check(
    '[ТЗ 1] параллельные вебхуки «оплачено»: одна выдача, один ключ, все ответы 200',
    { deliveries: 1, used: 1, status: 'delivered', failedResponses: 0 },
    {
      deliveries: parallelStats.deliveries,
      used: parallelStats.used,
      status: parallelStats.status,
      failedResponses: webhooks.filter((r) => r.status !== 200).length
    },
    countStatuses(webhooks)
  )

  await resetFixture(CONCURRENCY)
  const replayOrder = await newOrder('race-replay')
  const replayEvent = paidEvent(replayOrder, 0)
  const replays = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => post('/webhook/payment', replayEvent))
  )
  const replayRows = await pool.query<{ events: number; applied: number }>(
    `select count(*)::int as events, count(applied_at)::int as applied
     from webhook_events where order_id = $1`,
    [replayOrder]
  )
  const replayStats = await stats(replayOrder)
  check(
    '[ТЗ 2] один event_id доставлен многократно: событие сохранено и применено один раз',
    { events: 1, applied: 1, deliveries: 1, used: 1, failedResponses: 0 },
    {
      events: replayRows.rows[0]?.events,
      applied: replayRows.rows[0]?.applied,
      deliveries: replayStats.deliveries,
      used: replayStats.used,
      failedResponses: replays.filter((r) => r.status !== 200).length
    },
    countStatuses(replays)
  )

  const ghostId = `ord_race_ghost_${Date.now()}`
  const ghost = await post('/webhook/payment', {
    event_id: `evt_race_ghost_${Date.now()}`,
    order_id: ghostId,
    status: 'paid',
    amount: PRICE,
    currency: 'RUB',
    created_at: new Date().toISOString()
  })
  const ghostRows = await pool.query<{ stored: number }>(
    'select count(*)::int as stored from webhook_events where order_id = $1',
    [ghostId]
  )
  check(
    '[ТЗ 3] вебхук по несуществующему заказу: принят и сохранён, не потерян',
    { status: 200, deferred: true, stored: 1 },
    { status: ghost.status, deferred: ghost.body?.deferred, stored: ghostRows.rows[0]?.stored }
  )

  await resetFixture(1)
  const contenders: string[] = []
  for (let i = 0; i < CONCURRENCY; i += 1) {
    contenders.push(await newOrder(`race-last-key-${i}`))
  }
  const contenderWebhooks = await Promise.all(
    contenders.map((id) => post('/webhook/payment', paidEvent(id, 0)))
  )
  const states = await Promise.all(contenders.map((id) => get(`/api/orders/${id}`)))
  check(
    '[ТЗ 1] все заказы борются за последний ключ: выдан ровно один',
    { delivered: 1, undelivered: CONCURRENCY - 1, distinctCodes: 1, failedResponses: 0 },
    {
      delivered: states.filter((r) => r.body?.status === 'delivered').length,
      undelivered: states.filter((r) => r.body?.status !== 'delivered').length,
      distinctCodes: new Set(states.map((r) => r.body?.code).filter(Boolean)).size,
      failedResponses: contenderWebhooks.filter((r) => r.status !== 200).length
    },
    countOrderStates(states)
  )

  await pool.query(
    "insert into license_keys (sku, code) values ($1, 'RACE-RESTOCK-0001') on conflict (code) do nothing",
    [SKU]
  )
  const stuck = contenders.filter((_, index) => states[index]?.body?.status === 'out_of_stock')
  const retries = await Promise.all(
    stuck.map((id, index) => post('/webhook/payment', paidEvent(id, index + 1000)))
  )
  const afterRestock = await Promise.all(stuck.map((id) => get(`/api/orders/${id}`)))
  const restockUsed = await pool.query<{ used: number }>(
    'select count(*)::int as used from license_keys where sku = $1 and order_id is not null',
    [SKU]
  )
  check(
    '[ТЗ 4] пополнение пула под нагрузкой: ровно один застрявший заказ получает ключ',
    { delivered: 1, used: 2, failedResponses: 0 },
    {
      delivered: afterRestock.filter((r) => r.body?.status === 'delivered').length,
      used: restockUsed.rows[0]?.used,
      failedResponses: retries.filter((r) => r.status !== 200).length
    },
    countOrderStates(afterRestock)
  )
  await resetFixture(CONCURRENCY)
  await pool.query(
    `insert into promocodes (code, type, value, max_uses)
     values ('RACELIMIT3', 'percent', 25, 3)
     on conflict (code) do update set used_count = 0, max_uses = 3`
  )
  const promoAttempts = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      post('/api/orders', {
        sku: SKU,
        idempotencyKey: `race-promo-${i}`,
        promoCode: 'RACELIMIT3'
      })
    )
  )
  const promoUsed = await pool.query<{ used: number; uses: number }>(
    `select (select used_count from promocodes where code = 'RACELIMIT3') as used,
            (select count(*)::int from promocode_uses where code = 'RACELIMIT3') as uses`
  )
  check(
    '[ТЗ 5] промокод с лимитом 3 под параллельными запросами: применён ровно 3 раза',
    { created: 3, rejected: CONCURRENCY - 3, used: 3, uses: 3 },
    {
      created: promoAttempts.filter((r) => r.status === 201).length,
      rejected: promoAttempts.filter((r) => r.status === 409).length,
      used: promoUsed.rows[0]?.used,
      uses: promoUsed.rows[0]?.uses
    },
    countStatuses(promoAttempts)
  )
}

try {
  await run()
} finally {
  await cleanup()
  await pool.query('delete from products where sku = $1', [SKU])
  await pool.end()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} сценариев прошли`)
process.exitCode = failed.length > 0 ? 1 : 0
