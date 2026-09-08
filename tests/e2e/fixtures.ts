import pg from 'pg'

export const STUCK_SKU = 'E2E-ADMIN-STUCK'

let pool: pg.Pool | null = null

function db(): pg.Pool {
  const connectionString = process.env.E2E_DATABASE_URL

  if (!connectionString) {
    throw new Error('E2E_DATABASE_URL is not set, run through "npm run test:e2e"')
  }

  pool ??= new pg.Pool({ connectionString, max: 2 })
  return pool
}

export async function resetStuckProduct(): Promise<void> {
  const client = db()

  await client.query(
    `insert into products (sku, name, type, price, currency)
     values ($1, 'E2E товар без ключей', 'key', 1000, 'RUB')
     on conflict (sku) do nothing`,
    [STUCK_SKU]
  )

  await client.query(
    'delete from deliveries where order_id in (select id from orders where sku = $1)',
    [STUCK_SKU]
  )
  await client.query(
    'delete from delivery_attempts where order_id in (select id from orders where sku = $1)',
    [STUCK_SKU]
  )
  await client.query(
    'delete from webhook_events where order_id in (select id from orders where sku = $1)',
    [STUCK_SKU]
  )
  await client.query('delete from license_keys where sku = $1', [STUCK_SKU])
  await client.query('delete from orders where sku = $1', [STUCK_SKU])
}

export async function seedStuckKey(): Promise<void> {
  await db().query('insert into license_keys (sku, code) values ($1, $2)', [
    STUCK_SKU,
    `STOCKLESS-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  ])
}

export async function dropReservedKey(orderId: string): Promise<void> {
  await db().query('delete from license_keys where allocated_order_id = $1', [orderId])
}

export async function keysUsedFor(code: string): Promise<number> {
  const { rows } = await db().query<{ count: number }>(
    'select count(*)::int as count from license_keys where code = $1 and order_id is not null',
    [code]
  )

  return rows[0]?.count ?? 0
}

export async function removeStuckProduct(): Promise<void> {
  await resetStuckProduct()
  await db().query('delete from products where sku = $1', [STUCK_SKU])
}

export async function closeFixtures(): Promise<void> {
  await pool?.end()
  pool = null
}
