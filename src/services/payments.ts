import type pg from 'pg'
import { withTransaction } from '../db/pool.ts'
import type { components } from '../types/api.d.ts'

type PaymentWebhook = components['schemas']['PaymentWebhook']

export const INTERNAL_EVENT_PREFIX = 'pay_'

export const paymentEventId = (orderId: string, outcome: 'success' | 'fail') =>
  `${INTERNAL_EVENT_PREFIX}${orderId}_${outcome}`

export async function buildPaymentEvent(
  pool: pg.Pool | pg.PoolClient,
  orderId: string,
  outcome: 'success' | 'fail'
): Promise<PaymentWebhook> {
  const { rows } = await pool.query<{ amount: number; discount: number; currency: string }>(
    `select o.amount, o.discount, p.currency
     from orders o join products p on p.sku = o.sku
     where o.id = $1`,
    [orderId]
  )

  const order = rows[0]

  if (!order) {
    throw new Error(`Order ${orderId} not found`)
  }

  return {
    event_id: paymentEventId(orderId, outcome),
    order_id: orderId,
    status: outcome === 'success' ? 'paid' : 'failed',
    amount: order.amount - order.discount,
    currency: order.currency,
    created_at: new Date().toISOString()
  }
}

export type PaymentIntent = { event: PaymentWebhook; repeated: boolean } | { blocked: string }

export async function acceptPayment(
  pool: pg.Pool,
  orderId: string,
  outcome: 'success' | 'fail'
): Promise<PaymentIntent> {
  const eventId = paymentEventId(orderId, outcome)
  const expected = outcome === 'success' ? 'paid' : 'failed'

  return withTransaction(async (client) => {
    const { rows } = await client.query<{ status: string }>(
      'select status from orders where id = $1 for update',
      [orderId]
    )

    const current = rows[0]

    if (!current) return { blocked: 'not_found' }

    const events = await client.query<{
      event_id: string
      status: string
      payload: PaymentWebhook
    }>('select event_id, status, payload from webhook_events where order_id = $1', [orderId])

    const mine = events.rows.find((row) => row.event_id === eventId && row.status === expected)

    if (mine) return { event: mine.payload, repeated: true }

    if (current.status !== 'created') return { blocked: current.status }

    if ((events.rowCount ?? 0) > 0) return { blocked: 'payment_in_progress' }

    const event = await buildPaymentEvent(client, orderId, outcome)

    await client.query(
      `insert into webhook_events (event_id, order_id, status, occurred_at, payload)
       values ($1, $2, $3, $4, $5)
       on conflict (event_id) do nothing`,
      [event.event_id, event.order_id, event.status, event.created_at, event]
    )

    return { event, repeated: false }
  }, pool)
}
