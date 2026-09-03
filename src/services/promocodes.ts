import type pg from 'pg'

export type Promocode = {
  code: string
  type: 'percent' | 'amount'
  value: number
  currency: string | null
}

export type PromoError = 'promo_not_found' | 'promo_limit_reached' | 'promo_currency_mismatch'

export function discountFor(promo: Promocode, amount: number): number {
  const raw = promo.type === 'percent' ? Math.floor((amount * promo.value) / 100) : promo.value

  return Math.min(raw, amount)
}

export async function reservePromocode(
  client: pg.PoolClient,
  code: string,
  amount: number,
  currency: string
): Promise<{ discount: number } | { error: PromoError }> {
  const promo = await client.query<Promocode>(
    'select code, type, value, currency from promocodes where code = $1',
    [code]
  )

  const found = promo.rows[0]

  if (!found) return { error: 'promo_not_found' }
  if (found.type === 'amount' && found.currency !== currency) {
    return { error: 'promo_currency_mismatch' }
  }

  const reserved = await client.query(
    `update promocodes set used_count = used_count + 1
     where code = $1 and used_count < max_uses`,
    [code]
  )

  if (reserved.rowCount === 0) return { error: 'promo_limit_reached' }

  return { discount: discountFor(found, amount) }
}

export async function releasePromocode(client: pg.PoolClient, orderId: string): Promise<void> {
  const released = await client.query<{ code: string }>(
    'delete from promocode_uses where order_id = $1 returning code',
    [orderId]
  )

  const code = released.rows[0]?.code

  if (!code) return

  await client.query(
    'update promocodes set used_count = used_count - 1 where code = $1 and used_count > 0',
    [code]
  )
}
