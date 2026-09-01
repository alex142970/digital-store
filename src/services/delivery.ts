import type pg from 'pg'
import { withTransaction } from '../db/pool.ts'

export type DeliveryOutcome = 'delivered' | 'already_delivered' | 'out_of_stock' | 'not_found'

const DELIVERABLE = ['paid', 'delivering', 'out_of_stock', 'delivery_failed']

export async function deliverOrder(pool: pg.Pool, orderId: string): Promise<DeliveryOutcome> {
  return withTransaction(async (client) => {
    const order = await client.query<{ sku: string; status: string }>(
      'select sku, status from orders where id = $1 for update',
      [orderId]
    )

    const current = order.rows[0]

    if (!current) return 'not_found'
    if (current.status === 'delivered') return 'already_delivered'
    if (!DELIVERABLE.includes(current.status)) return 'not_found'

    await client.query(
      `update orders set status = 'delivering', failure_reason = null where id = $1`,
      [orderId]
    )

    const key = await client.query<{ id: string; code: string }>(
      `select id, code from license_keys
       where sku = $1 and order_id is null
       order by id
       for update skip locked
       limit 1`,
      [current.sku]
    )

    const picked = key.rows[0]

    if (!picked) {
      await client.query(
        `update orders set status = 'out_of_stock', failure_reason = 'key pool is empty'
         where id = $1`,
        [orderId]
      )
      return 'out_of_stock'
    }

    await client.query('update license_keys set order_id = $1, issued_at = now() where id = $2', [
      orderId,
      picked.id
    ])

    await client.query(
      `insert into deliveries (order_id, key_id, provider, request_id, code)
       values ($1, $2, $3, $4, $5)
       on conflict (order_id) do nothing`,
      [orderId, picked.id, 'pool', `req_${orderId}`, picked.code]
    )

    await client.query(
      `update orders set status = 'delivered', failure_reason = null where id = $1`,
      [orderId]
    )

    return 'delivered'
  }, pool)
}
