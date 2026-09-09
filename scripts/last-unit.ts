import pg from 'pg'

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:3000'
const DATABASE_URL = process.env.DATABASE_URL
const BUYERS = Number(process.env.BUYERS ?? 20)
const SKU = 'DEMO-LAST-UNIT'

if (!DATABASE_URL) {
  console.error('Нужна переменная DATABASE_URL. Запускайте через npm run race:last-unit')
  process.exit(1)
}

if (!Number.isInteger(BUYERS) || BUYERS < 2 || BUYERS > 200) {
  console.error(`BUYERS должно быть целым от 2 до 200, получено ${process.env.BUYERS}`)
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: DATABASE_URL })

const post = async (path: string, payload: unknown) => {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000)
  })

  return { status: response.status, body: await response.json().catch(() => null) }
}

const get = async (path: string) => {
  const response = await fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(15_000) })
  return response.json().catch(() => null)
}

async function prepare() {
  await cleanup()

  await pool.query(
    `insert into products (sku, name, type, price, currency)
     values ($1, 'Последняя единица на складе', 'key', 1000, 'RUB')`,
    [SKU]
  )

  await pool.query('insert into license_keys (sku, code) values ($1, $2)', [
    SKU,
    `DEMO-${Date.now().toString(36).toUpperCase()}`
  ])
}

async function cleanup() {
  await pool.query(
    'delete from deliveries where order_id in (select id from orders where sku = $1)',
    [SKU]
  )
  await pool.query(
    'delete from delivery_attempts where order_id in (select id from orders where sku = $1)',
    [SKU]
  )
  await pool.query(
    'delete from webhook_events where order_id in (select id from orders where sku = $1)',
    [SKU]
  )
  await pool.query('delete from license_keys where sku = $1', [SKU])
  await pool.query('delete from orders where sku = $1', [SKU])
  await pool.query('delete from products where sku = $1', [SKU])
}

const line = (label: string, value: unknown) => console.log(`  ${label.padEnd(46)} ${value}`)

async function run() {
  console.log(`\nОдин ключ на складе, ${BUYERS} покупателей жмут «Купить» одновременно.`)
  console.log(`Сервер: ${BASE_URL}\n`)

  await prepare()

  const attempts = await Promise.all(
    Array.from({ length: BUYERS }, (_, index) =>
      post('/api/orders', { sku: SKU, idempotencyKey: `last-unit-${Date.now()}-${index}` })
    )
  )

  const created = attempts.filter((r) => r.status === 201)
  const refused = attempts.filter((r) => r.status === 409)
  const other = attempts.filter((r) => r.status !== 201 && r.status !== 409)

  console.log('Оформление:')
  line('заказ создан', created.length)
  line('получили отказ «товар раскупили»', refused.length)
  if (other.length > 0) line('прочие ответы', other.map((r) => r.status).join(', '))

  const winner = created[0]?.body as { id: string } | undefined

  if (!winner) {
    console.log('\nНи один заказ не создан — сценарий не удался.')
    return false
  }

  await post(`/api/orders/${winner.id}/pay`, { outcome: 'success' })

  let order = (await get(`/api/orders/${winner.id}`)) as { status: string; code: string | null }

  for (let attempt = 0; attempt < 40 && order.status !== 'delivered'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    order = (await get(`/api/orders/${winner.id}`)) as { status: string; code: string | null }
  }

  const { rows } = await pool.query<{ stranded: number; issued: number }>(
    `select (select count(*)::int from orders
             where sku = $1 and status in ('paid', 'delivering', 'out_of_stock', 'delivery_failed'))
              as stranded,
            (select count(*)::int from license_keys where sku = $1 and order_id is not null)
              as issued`,
    [SKU]
  )

  console.log('\nВыдача победителю:')
  line('статус заказа', order.status)
  line('ключ выдан', order.code ?? 'нет')
  line('ключей израсходовано', rows[0]?.issued)
  line('оплачено, но без товара', rows[0]?.stranded)

  const alternatives = (refused[0]?.body as { alternatives?: unknown[] } | null)?.alternatives ?? []
  console.log('\nЧто увидел проигравший:')
  line('код ошибки', (refused[0]?.body as { error?: string } | null)?.error ?? '—')
  line('предложено замен', alternatives.length)

  const ok =
    created.length === 1 &&
    refused.length === BUYERS - 1 &&
    order.status === 'delivered' &&
    Boolean(order.code) &&
    rows[0]?.issued === 1 &&
    rows[0]?.stranded === 0

  console.log(
    ok
      ? '\nИтог: единицу получил ровно один покупатель, остальные получили понятный отказ.'
      : '\nИтог: ожидания не сошлись, смотрите цифры выше.'
  )

  return ok
}

try {
  process.exitCode = (await run()) ? 0 : 1
} finally {
  await cleanup()
  await pool.end()
}
