import type pg from 'pg'
import { config } from '../config.ts'
import { withTransaction } from '../db/pool.ts'
import { releasePromocode } from './promocodes.ts'

export const AVAILABLE_KEY = 'allocated_order_id is null and order_id is null'

async function expireOne(client: pg.PoolClient, orderId: string): Promise<boolean> {
  const expired = await client.query(
    `update orders
     set status = 'payment_failed',
         failure_code = 'reservation_expired',
         failure_reason = 'reservation expired before payment'
     where id = $1 and status = 'created' and reservation_expires_at < now()`,
    [orderId]
  )

  if ((expired.rowCount ?? 0) === 0) return false

  await client.query(
    'update license_keys set allocated_order_id = null where allocated_order_id = $1 and order_id is null',
    [orderId]
  )

  await releasePromocode(client, orderId)

  return true
}

async function expireFor(
  client: pg.PoolClient,
  sku: string | null,
  limit: number
): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `select o.id from orders o
     join license_keys k on k.allocated_order_id = o.id and k.order_id is null
     where o.status = 'created'
       and o.reservation_expires_at < now()
       and ($1::text is null or k.sku = $1)
       and not exists (
         select 1 from webhook_events w
         where w.order_id = o.id and w.status = 'paid' and w.applied_at is null
       )
     order by o.reservation_expires_at
     limit $2
     for update of o skip locked`,
    [sku, limit]
  )

  let released = 0

  for (const row of rows) {
    if (await expireOne(client, row.id)) released += 1
  }

  return released
}

export async function allocate(
  client: pg.PoolClient,
  sku: string,
  orderId: string
): Promise<boolean> {
  const picked = await client.query<{ id: string }>(
    `select id from license_keys
     where sku = $1 and ${AVAILABLE_KEY}
     order by id
     for update skip locked
     limit 1`,
    [sku]
  )

  const keyId = picked.rows[0]?.id

  if (!keyId) return false

  const taken = await client.query(
    `update license_keys set allocated_order_id = $2
     where id = $1 and ${AVAILABLE_KEY}`,
    [keyId, orderId]
  )

  if ((taken.rowCount ?? 0) === 0) return false

  await client.query(
    `update orders set reservation_expires_at = now() + ($2::int * interval '1 millisecond')
     where id = $1`,
    [orderId, config.RESERVATION_TTL_MS]
  )

  return true
}

export async function release(client: pg.PoolClient, orderId: string): Promise<number> {
  const released = await client.query(
    'update license_keys set allocated_order_id = null where allocated_order_id = $1 and order_id is null',
    [orderId]
  )

  return released.rowCount ?? 0
}

export async function expireReservations(
  pool: pg.Pool,
  limit = 50,
  sku: string | null = null
): Promise<number> {
  return withTransaction(async (client) => expireFor(client, sku, limit), pool)
}

export async function availableFor(pool: pg.Pool, sku: string): Promise<number> {
  const { rows } = await pool.query<{ available: number }>(
    `select count(*)::int as available from license_keys where sku = $1 and ${AVAILABLE_KEY}`,
    [sku]
  )

  return rows[0]?.available ?? 0
}

export type Alternative = {
  sku: string
  name: string
  price: number
  currency: string
  available: number
}

export async function alternativesFor(
  client: pg.PoolClient,
  sku: string,
  limit = 3
): Promise<Alternative[]> {
  const { rows } = await client.query<Alternative>(
    `select p.sku, p.name, p.price, p.currency,
            (select count(*)::int from license_keys k
             where k.sku = p.sku and ${AVAILABLE_KEY}) as available
     from products p
     where p.type = (select type from products where sku = $1)
       and p.sku <> $1
       and exists (select 1 from license_keys k where k.sku = p.sku and ${AVAILABLE_KEY})
     order by abs(p.price - (select price from products where sku = $1)), p.sku
     limit $2`,
    [sku, limit]
  )

  return rows
}
