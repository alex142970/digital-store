import type pg from 'pg'
import { withTransaction } from '../db/pool.ts'
import { DELIVERABLE } from './order-status.ts'
import { issueCode, type IssueOutcome } from './providers.ts'

export type DeliveryOutcome =
  | 'delivered'
  | 'already_delivered'
  | 'in_progress'
  | 'out_of_stock'
  | 'delivery_failed'
  | 'not_found'

const requestIdFor = (orderId: string) => `req_${orderId}`

async function recordAttempt(pool: pg.Pool, orderId: string, outcome: IssueOutcome) {
  const detail = outcome.kind === 'refused' || outcome.kind === 'unknown' ? outcome.detail : null

  await pool.query(
    `insert into delivery_attempts (order_id, provider, request_id, outcome, detail)
     values ($1, $2, $3, $4, $5)`,
    [orderId, outcome.provider, requestIdFor(orderId), outcome.kind, detail]
  )
}

async function completeDelivery(
  pool: pg.Pool,
  orderId: string,
  provider: string,
  code: string
): Promise<DeliveryOutcome> {
  return withTransaction(async (client) => {
    const key = await client.query<{ id: string }>(
      `select k.id from license_keys k
       join orders o on o.id = k.order_id
       where k.code = $1 and k.order_id = $2 and k.sku = o.sku`,
      [code, orderId]
    )

    const keyId = key.rows[0]?.id

    if (!keyId) {
      await client.query(
        `update orders set status = 'delivery_failed', failure_reason = 'issued code does not belong to this order'
         where id = $1 and status = 'delivering'`,
        [orderId]
      )
      return 'delivery_failed'
    }

    await client.query(
      `insert into deliveries (order_id, key_id, provider, request_id, code)
       values ($1, $2, $3, $4, $5)
       on conflict (order_id) do nothing`,
      [orderId, keyId, provider, requestIdFor(orderId), code]
    )

    await client.query(
      `update orders set status = 'delivered', failure_reason = null
       where id = $1 and status <> 'delivered'`,
      [orderId]
    )

    return 'delivered'
  }, pool)
}

export async function deliverOrder(pool: pg.Pool, orderId: string): Promise<DeliveryOutcome> {
  const claimed = await withTransaction(async (client) => {
    const order = await client.query<{ sku: string; status: string }>(
      'select sku, status from orders where id = $1 for update',
      [orderId]
    )

    const current = order.rows[0]

    if (!current) return null
    if (current.status === 'delivered') return 'already_delivered'
    if (current.status === 'delivering') return 'in_progress'
    if (!DELIVERABLE.includes(current.status as (typeof DELIVERABLE)[number])) return null

    await client.query(
      `update orders set status = 'delivering', failure_reason = null where id = $1`,
      [orderId]
    )

    return current.sku
  }, pool)

  if (claimed === null) return 'not_found'
  if (claimed === 'already_delivered') return 'already_delivered'
  if (claimed === 'in_progress') return 'in_progress'

  const reserved = await pool.query<{ code: string }>(
    'select code from license_keys where order_id = $1 and sku = $2',
    [orderId, claimed]
  )

  const alreadyReserved = reserved.rows[0]?.code

  if (alreadyReserved) {
    return completeDelivery(pool, orderId, 'pool', alreadyReserved)
  }

  const outcome = await issueCode(requestIdFor(orderId), claimed, orderId, (attempt) =>
    recordAttempt(pool, orderId, attempt).catch(() => {})
  )

  if (outcome.kind === 'issued') {
    return completeDelivery(pool, orderId, outcome.provider, outcome.code)
  }

  const failure =
    outcome.kind === 'out_of_stock'
      ? { status: 'out_of_stock', reason: 'key pool is empty' }
      : { status: 'delivery_failed', reason: `provider ${outcome.provider} ${outcome.kind}` }

  await pool.query(
    `update orders set status = $2, failure_reason = $3
     where id = $1 and status = 'delivering'`,
    [orderId, failure.status, failure.reason]
  )

  return failure.status as DeliveryOutcome
}
