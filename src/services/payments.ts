import { randomBytes } from 'node:crypto'
import type pg from 'pg'
import type { components } from '../types/api.d.ts'

type PaymentWebhook = components['schemas']['PaymentWebhook']

export async function buildPaymentEvent(
  pool: pg.Pool,
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
    event_id: `evt_${randomBytes(9).toString('base64url')}`,
    order_id: orderId,
    status: outcome === 'success' ? 'paid' : 'failed',
    amount: order.amount - order.discount,
    currency: order.currency,
    created_at: new Date().toISOString()
  }
}
