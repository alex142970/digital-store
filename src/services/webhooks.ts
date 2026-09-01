import type pg from 'pg'
import { withTransaction } from '../db/pool.ts'
import type { components } from '../types/api.d.ts'
import { deliverOrder } from './delivery.ts'

export type PaymentWebhook = components['schemas']['PaymentWebhook']
export type WebhookResult = components['schemas']['WebhookAccepted']

type PendingEvent = {
  event_id: string
  status: 'paid' | 'failed'
  amount: number
  currency: string
  occurred_at: Date
}

const RESUMABLE = ['paid', 'out_of_stock', 'delivery_failed']

export async function receivePayment(pool: pg.Pool, event: PaymentWebhook): Promise<WebhookResult> {
  await pool.query(
    `insert into webhook_events (event_id, order_id, status, occurred_at, payload)
     values ($1, $2, $3, $4, $5)
     on conflict (event_id) do nothing`,
    [event.event_id, event.order_id, event.status, event.created_at, event]
  )

  return applyPending(pool, event.order_id)
}

export async function applyPending(pool: pg.Pool, orderId: string): Promise<WebhookResult> {
  const shouldDeliver = await withTransaction(async (client) => {
    const order = await client.query<{ status: string; amount: number; discount: number }>(
      'select status, amount, discount from orders where id = $1 for update',
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
    let deliver = RESUMABLE.includes(status)

    for (const event of pending.rows) {
      const stale = appliedUntil !== null && event.occurred_at < appliedUntil

      if (!stale && event.status === 'paid') {
        const amountMatches = event.amount === expectedTotal && event.currency === expectedCurrency

        if (!amountMatches) {
          await client.query(
            `update orders set status = 'payment_failed',
                    failure_reason = 'payment amount does not match the order'
             where id = $1 and status = 'created'`,
            [orderId]
          )
          status = 'payment_failed'
        } else if (status === 'created' || status === 'payment_failed') {
          await client.query(`update orders set status = 'paid' where id = $1`, [orderId])
          status = 'paid'
          deliver = true
        }
      }

      if (!stale && event.status === 'failed' && status === 'created') {
        await client.query(`update orders set status = 'payment_failed' where id = $1`, [orderId])
        status = 'payment_failed'
      }

      await client.query('update webhook_events set applied_at = now() where event_id = $1', [
        event.event_id
      ])
    }

    return deliver
  }, pool)

  if (shouldDeliver) {
    await deliverOrder(pool, orderId)
    return { accepted: true, deferred: false }
  }

  const known = await pool.query('select 1 from orders where id = $1', [orderId])

  return { accepted: true, deferred: known.rowCount === 0 }
}
