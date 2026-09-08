import type pg from 'pg'
import { withTransaction } from '../db/pool.ts'
import type { components } from '../types/api.d.ts'
import { deliverOrder } from './delivery.ts'
import { allocate, release } from './inventory.ts'
import { RESUMABLE } from './order-status.ts'
import { releasePromocode } from './promocodes.ts'

export type PaymentWebhook = components['schemas']['PaymentWebhook']
export type WebhookResult = components['schemas']['WebhookAccepted']

type PendingEvent = {
  event_id: string
  status: 'paid' | 'failed'
  amount: number
  currency: string
  occurred_at: Date
}

export async function receivePayment(
  pool: pg.Pool,
  event: PaymentWebhook,
  options: { awaitDelivery?: boolean } = {}
): Promise<WebhookResult> {
  await pool.query(
    `insert into webhook_events (event_id, order_id, status, occurred_at, payload)
     values ($1, $2, $3, $4, $5)
     on conflict (event_id) do nothing`,
    [event.event_id, event.order_id, event.status, event.created_at, event]
  )

  return applyPending(pool, event.order_id, options)
}

export async function applyPending(
  pool: pg.Pool,
  orderId: string,
  options: { awaitDelivery?: boolean } = {}
): Promise<WebhookResult> {
  const shouldDeliver = await withTransaction(async (client) => {
    const order = await client.query<{
      status: string
      sku: string
      amount: number
      discount: number
      reservation_expired: boolean
      allocated: boolean
    }>(
      `select o.status, o.sku, o.amount, o.discount,
              (o.reservation_expires_at is not null and o.reservation_expires_at < now()) as reservation_expired,
              exists (select 1 from license_keys k where k.allocated_order_id = o.id) as allocated
       from orders o where o.id = $1 for update`,
      [orderId]
    )

    const current = order.rows[0]

    if (!current) return false

    const currency = await client.query<{ currency: string }>(
      'select p.currency from orders o join products p on p.sku = o.sku where o.id = $1',
      [orderId]
    )

    const expectedTotal = current.amount - current.discount
    const expectedCurrency = currency.rows[0]?.currency

    const pending = await client.query<PendingEvent>(
      `select event_id, status, (payload->>'amount')::int as amount,
              payload->>'currency' as currency, occurred_at
       from webhook_events
       where order_id = $1 and applied_at is null
       order by occurred_at, event_id`,
      [orderId]
    )

    const lastApplied = await client.query<{ occurred_at: Date }>(
      `select max(occurred_at) as occurred_at from webhook_events
       where order_id = $1 and applied_at is not null`,
      [orderId]
    )

    const appliedUntil = lastApplied.rows[0]?.occurred_at ?? null
    let status = current.status
    let deliver = RESUMABLE.includes(status as (typeof RESUMABLE)[number])

    for (const event of pending.rows) {
      const stale = appliedUntil !== null && event.occurred_at < appliedUntil

      if (!stale && event.status === 'paid') {
        const amountMatches = event.amount === expectedTotal && event.currency === expectedCurrency

        if (!amountMatches) {
          const rejected = await client.query(
            `update orders set status = 'payment_failed',
                    failure_reason = 'payment amount does not match the order'
             where id = $1 and status = 'created'`,
            [orderId]
          )

          if ((rejected.rowCount ?? 0) > 0) {
            await release(client, orderId)
            await releasePromocode(client, orderId)
            status = 'payment_failed'
          }
        } else if (status === 'created' && current.reservation_expired) {
          const lapsed = await client.query(
            `update orders set status = 'payment_failed',
                    failure_code = 'reservation_expired',
                    failure_reason = 'reservation expired before payment'
             where id = $1 and status = 'created'`,
            [orderId]
          )

          if ((lapsed.rowCount ?? 0) > 0) {
            await release(client, orderId)
            await releasePromocode(client, orderId)
            status = 'payment_failed'
          }
        } else if (status === 'created') {
          if (!current.allocated) {
            await allocate(client, current.sku, orderId)
          }

          const accepted = await client.query(
            `update orders set status = 'paid' where id = $1 and status = 'created'`,
            [orderId]
          )

          if ((accepted.rowCount ?? 0) > 0) {
            status = 'paid'
            deliver = true
          }
        }
      }

      if (!stale && event.status === 'failed' && status === 'created') {
        const failed = await client.query(
          `update orders set status = 'payment_failed' where id = $1 and status = 'created'`,
          [orderId]
        )

        if ((failed.rowCount ?? 0) > 0) {
          await release(client, orderId)
          await releasePromocode(client, orderId)
          status = 'payment_failed'
        }
      }

      await client.query('update webhook_events set applied_at = now() where event_id = $1', [
        event.event_id
      ])
    }

    return deliver
  }, pool)

  if (shouldDeliver) {
    if (options.awaitDelivery) await deliverOrder(pool, orderId)
    else void deliverOrder(pool, orderId).catch(() => {})

    return { accepted: true, deferred: false }
  }

  const known = await pool.query('select 1 from orders where id = $1', [orderId])

  return { accepted: true, deferred: known.rowCount === 0 }
}
