import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { expireReservations } from '../../src/services/inventory.ts'
import {
  createOrder,
  fetchOrder,
  pay,
  paidEvent,
  resetData,
  sendWebhook,
  settleDeliveries,
  startApp,
  waitForStatus,
  type TestContext
} from '../setup/app.ts'

let ctx: TestContext

beforeAll(async () => {
  ctx = await startApp()
})

afterAll(async () => {
  await ctx.app.close()
  await ctx.pool.end()
})

beforeEach(async () => {
  await resetData(ctx.pool)
})

type Counts = {
  orders: number
  events: number
  applied: number
  deliveries: number
  attempts: number
  issued: number
  reserved: number
  promoUses: number
}

type Snapshot = Counts & {
  status: string
  code: string | null
  failureCode: string | null
}

async function snapshot(orderId: string): Promise<Snapshot> {
  const order = (await fetchOrder(ctx, orderId)).json()

  const { rows } = await ctx.pool.query<Counts>(
    `select (select count(*)::int from orders where id = $1) as orders,
            (select count(*)::int from webhook_events where order_id = $1) as events,
            (select count(*)::int from webhook_events
              where order_id = $1 and applied_at is not null) as applied,
            (select count(*)::int from deliveries where order_id = $1) as deliveries,
            (select count(*)::int from delivery_attempts where order_id = $1) as attempts,
            (select count(*)::int from license_keys where order_id = $1) as issued,
            (select count(*)::int from license_keys where allocated_order_id = $1) as reserved,
            (select count(*)::int from promocode_uses where order_id = $1) as promoUses`,
    [orderId]
  )

  return {
    ...rows[0]!,
    status: order.status,
    code: order.code,
    failureCode: order.failureCode ?? null
  }
}

async function stableUnderRepeat(
  orderId: string,
  repeat: () => Promise<{ statusCode: number }>,
  expected: number,
  times = 5
): Promise<void> {
  const before = await snapshot(orderId)
  const codes: number[] = []

  for (let i = 0; i < times; i += 1) codes.push((await repeat()).statusCode)
  await settleDeliveries(ctx)

  expect(new Set(codes)).toEqual(new Set([expected]))
  expect(await snapshot(orderId)).toEqual(before)
}

test('И1: сколько бы раз ни повторили оформление с одним ключом, заказ один', async () => {
  const key = 'invariant-checkout'
  const first = (await createOrder(ctx, key)).json()

  const attempts = await Promise.all(Array.from({ length: 10 }, () => createOrder(ctx, key)))

  expect(new Set(attempts.map((r) => r.json().id))).toEqual(new Set([first.id]))

  const { rows } = await ctx.pool.query<{ count: number }>(
    'select count(*)::int as count from orders where idempotency_key = $1',
    [key]
  )

  expect(rows[0]?.count).toBe(1)
})

test('И1: разные ключи на один товар дают разные заказы', async () => {
  const one = (await createOrder(ctx, 'invariant-intent-1')).json()
  const two = (await createOrder(ctx, 'invariant-intent-2')).json()

  expect(one.id).not.toBe(two.id)
})

test('И2: повторная доставка одного события не меняет состояние', async () => {
  const order = (await createOrder(ctx, 'invariant-webhook')).json()
  const event = paidEvent(order.id, { amount: order.total })

  await sendWebhook(ctx, event)
  await waitForStatus(ctx, order.id, ['delivered'])

  await stableUnderRepeat(order.id, () => sendWebhook(ctx, event), 200)
})

test('И2: параллельные вебхуки применяются как один', async () => {
  const order = (await createOrder(ctx, 'invariant-parallel')).json()
  const event = paidEvent(order.id, { amount: order.total })

  await Promise.all(Array.from({ length: 8 }, () => sendWebhook(ctx, event)))
  await waitForStatus(ctx, order.id, ['delivered'])

  const after = await snapshot(order.id)

  expect(after.applied).toBe(1)
  expect(after.deliveries).toBe(1)
  expect(after.issued).toBe(1)
})

test('И3: повторная оплата не меняет ни статус, ни ключ, ни выдачу', async () => {
  const order = (await createOrder(ctx, 'invariant-repay')).json()

  await pay(ctx, order.id)
  await waitForStatus(ctx, order.id, ['delivered'])

  await stableUnderRepeat(order.id, () => pay(ctx, order.id), 202)
})

test('И3: повтор оплаты возвращает тот же идентификатор события', async () => {
  const order = (await createOrder(ctx, 'invariant-event-id')).json()
  const first = (await pay(ctx, order.id)).json()

  const repeats = await Promise.all(Array.from({ length: 5 }, () => pay(ctx, order.id)))

  expect(new Set(repeats.map((r) => r.json().eventId))).toEqual(new Set([first.eventId]))
})

test('И3: неудачная оплата тоже устойчива к повтору', async () => {
  const order = (await createOrder(ctx, 'invariant-refail')).json()

  await pay(ctx, order.id, 'fail')
  await waitForStatus(ctx, order.id, ['payment_failed'])

  await stableUnderRepeat(order.id, () => pay(ctx, order.id, 'fail'), 202)
})

test('И6: чтение статуса в любом количестве ничего не меняет', async () => {
  const order = (await createOrder(ctx, 'invariant-read')).json()

  await pay(ctx, order.id)
  await waitForStatus(ctx, order.id, ['delivered'])

  await stableUnderRepeat(order.id, () => fetchOrder(ctx, order.id), 200, 10)
})

test('И2: оплата и отмена наперегонки дают ровно один исход', async () => {
  const order = (await createOrder(ctx, 'invariant-race-cancel')).json()

  const [paid, cancelled] = await Promise.all([
    pay(ctx, order.id),
    ctx.app.inject({ method: 'POST', url: `/api/orders/${order.id}/cancel` })
  ])

  await settleDeliveries(ctx)

  const winners = [paid.statusCode, cancelled.statusCode].filter((code) => code < 300)

  expect(winners).toHaveLength(1)

  const after = await snapshot(order.id)

  expect(after.issued).toBe(after.status === 'delivered' ? 1 : 0)
  expect(after.deliveries).toBe(after.status === 'delivered' ? 1 : 0)
})

test('И3: десять одновременных оплат из created дают ровно одну выдачу', async () => {
  const order = (await createOrder(ctx, 'invariant-parallel-pay')).json()

  const attempts = await Promise.all(Array.from({ length: 10 }, () => pay(ctx, order.id)))

  await waitForStatus(ctx, order.id, ['delivered'])
  await settleDeliveries(ctx)

  expect(new Set(attempts.map((r) => r.statusCode))).toEqual(new Set([202]))

  const after = await snapshot(order.id)

  expect(after).toMatchObject({ events: 1, applied: 1, deliveries: 1, issued: 1, attempts: 1 })
})

test('И3: гонка противоположных исходов не съедает успешную оплату', async () => {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await resetData(ctx.pool)

    const order = (await createOrder(ctx, `invariant-outcome-race-${attempt}`)).json()

    const [ok, no] = await Promise.all([pay(ctx, order.id), pay(ctx, order.id, 'fail')])

    await settleDeliveries(ctx)

    const after = await snapshot(order.id)

    expect([ok.statusCode, no.statusCode].filter((code) => code === 202)).toHaveLength(1)
    expect(after.events).toBe(1)

    if (ok.statusCode === 202) {
      expect(after.status).toBe('delivered')
      expect(after.code).not.toBeNull()
    } else {
      expect(after.status).toBe('payment_failed')
      expect(after.issued).toBe(0)
    }
  }
})

test('И3: принятый, но не применённый платёж доигрывается повтором', async () => {
  const order = (await createOrder(ctx, 'invariant-stuck-payment')).json()

  await ctx.pool.query(
    `insert into webhook_events (event_id, order_id, status, occurred_at, payload)
     values ($1, $2, 'paid', now(), $3)`,
    [
      `pay_${order.id}_success`,
      order.id,
      JSON.stringify({
        event_id: `pay_${order.id}_success`,
        order_id: order.id,
        status: 'paid',
        amount: order.total,
        currency: order.currency,
        created_at: new Date().toISOString()
      })
    ]
  )

  const response = await pay(ctx, order.id)

  expect(response.statusCode).toBe(202)

  const after = await waitForStatus(ctx, order.id, ['delivered'])

  expect(after.code).not.toBeNull()
  expect((await snapshot(order.id)).applied).toBe(1)
})

test('И2: подделать внутренний платёж через публичный вебхук нельзя', async () => {
  const order = (await createOrder(ctx, 'invariant-forged-event')).json()

  const forged = await sendWebhook(ctx, {
    event_id: `pay_${order.id}_success`,
    order_id: order.id,
    status: 'failed',
    amount: order.total,
    currency: order.currency,
    created_at: new Date().toISOString()
  })

  expect(forged.statusCode).toBe(400)

  await pay(ctx, order.id)
  const after = await waitForStatus(ctx, order.id, ['delivered'])

  expect(after.code).not.toBeNull()
})

test('И3: принятый платёж переживает истечение брони, свипер его не отменяет', async () => {
  const order = (await createOrder(ctx, 'invariant-stuck-vs-sweeper')).json()

  await ctx.pool.query(
    `insert into webhook_events (event_id, order_id, status, occurred_at, payload)
     values ($1, $2, 'paid', now(), $3)`,
    [
      `pay_${order.id}_success`,
      order.id,
      JSON.stringify({
        event_id: `pay_${order.id}_success`,
        order_id: order.id,
        status: 'paid',
        amount: order.total,
        currency: order.currency,
        created_at: new Date().toISOString()
      })
    ]
  )

  await ctx.pool.query(
    "update orders set reservation_expires_at = now() - interval '1 minute' where id = $1",
    [order.id]
  )

  expect(await expireReservations(ctx.pool)).toBe(0)

  const after = (await fetchOrder(ctx, order.id)).json()

  expect(after.status).toBe('created')

  const { rows } = await ctx.pool.query<{ reserved: number }>(
    'select count(*)::int as reserved from license_keys where allocated_order_id = $1',
    [order.id]
  )

  expect(rows[0]?.reserved).toBe(1)
})
