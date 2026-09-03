import { randomBytes } from 'node:crypto'
import type pg from 'pg'
import { withTransaction } from '../db/pool.ts'
import { reservePromocode } from './promocodes.ts'
import type { components } from '../types/api.d.ts'

export type Order = components['schemas']['Order']
export type OrderStatus = components['schemas']['OrderStatus']

export class OrderError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

type OrderRow = {
  id: string
  sku: string
  amount: number
  discount: number
  promo_code: string | null
  status: OrderStatus
  currency: string
  code: string | null
  failure_reason: string | null
  created_at: Date
  updated_at: Date
}

const SELECT_ORDER = `
  select o.id, o.sku, o.amount, o.discount, o.promo_code, o.status,
         p.currency, d.code, o.failure_reason, o.created_at, o.updated_at
  from orders o
  join products p on p.sku = o.sku
  left join deliveries d on d.order_id = o.id
`

const toOrder = (row: OrderRow): Order => ({
  id: row.id,
  sku: row.sku,
  amount: row.amount,
  discount: row.discount,
  total: row.amount - row.discount,
  currency: row.currency,
  promoCode: row.promo_code,
  status: row.status,
  code: row.code,
  failureReason: row.failure_reason,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString()
})

const newOrderId = () => `ord_${randomBytes(9).toString('base64url')}`

export async function createOrder(
  pool: pg.Pool,
  input: { sku: string; idempotencyKey: string; promoCode?: string }
): Promise<{ order: Order; created: boolean }> {
  const product = await pool.query<{ price: number; currency: string }>(
    'select price, currency from products where sku = $1',
    [input.sku]
  )

  const found = product.rows[0]

  if (!found) {
    throw new OrderError(404, 'product_not_found', `Product ${input.sku} not found`)
  }

  const id = newOrderId()

  const createdId = await withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `insert into orders (id, sku, amount, idempotency_key)
       values ($1, $2, $3, $4)
       on conflict (idempotency_key) where idempotency_key is not null do nothing
       returning id`,
      [id, input.sku, found.price, input.idempotencyKey]
    )

    const orderId = inserted.rows[0]?.id

    if (!orderId) return null

    if (input.promoCode) {
      const reserved = await reservePromocode(client, input.promoCode, found.price, found.currency)

      if ('error' in reserved) {
        const status = reserved.error === 'promo_not_found' ? 404 : 409
        throw new OrderError(status, reserved.error, `Promo code ${input.promoCode} is not usable`)
      }

      await client.query('update orders set discount = $2, promo_code = $3 where id = $1', [
        orderId,
        reserved.discount,
        input.promoCode
      ])

      await client.query('insert into promocode_uses (order_id, code) values ($1, $2)', [
        orderId,
        input.promoCode
      ])
    }

    return orderId
  }, pool)

  const { rows } = createdId
    ? await pool.query<OrderRow>(`${SELECT_ORDER} where o.id = $1`, [createdId])
    : await pool.query<OrderRow>(`${SELECT_ORDER} where o.idempotency_key = $1`, [
        input.idempotencyKey
      ])

  const row = rows[0]

  if (!row) {
    throw new OrderError(500, 'internal_error', 'Order disappeared right after insert')
  }

  if (!createdId && (row.sku !== input.sku || (row.promo_code ?? undefined) !== input.promoCode)) {
    throw new OrderError(
      409,
      'conflict',
      'Idempotency key was already used with different parameters'
    )
  }

  return { order: toOrder(row), created: Boolean(createdId) }
}

export async function getOrder(pool: pg.Pool, id: string): Promise<Order> {
  const { rows } = await pool.query<OrderRow>(`${SELECT_ORDER} where o.id = $1`, [id])

  if (!rows[0]) {
    throw new OrderError(404, 'not_found', `Order ${id} not found`)
  }

  return toOrder(rows[0])
}
