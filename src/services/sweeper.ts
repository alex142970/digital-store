import type { FastifyInstance } from 'fastify'
import { config } from '../config.ts'
import { withTransaction } from '../db/pool.ts'
import { deliverOrder } from './delivery.ts'
import { applyPending } from './webhooks.ts'
import { expireReservations, release } from './inventory.ts'
import { UNFINISHED } from './order-status.ts'
import { releasePromocode } from './promocodes.ts'

async function claimStuckOrders(app: FastifyInstance): Promise<string[]> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; status: string }>(
      `select id, status from orders
       where status = any($1::text[])
         and updated_at < now() - ($2::int * interval '1 millisecond')
       order by updated_at
       limit 20
       for update skip locked`,
      [UNFINISHED, config.DELIVERY_STUCK_AFTER_MS]
    )

    for (const row of rows) {
      if (row.status === 'delivering') {
        await client.query(
          `update orders set status = 'delivery_failed', failure_reason = 'delivery was abandoned'
           where id = $1 and status = 'delivering'`,
          [row.id]
        )
      }
    }

    return rows.map((row) => row.id)
  }, app.pool)
}

async function expireAbandonedOrders(app: FastifyInstance): Promise<number> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `select id from orders o
       where o.status = 'created'
         and o.created_at < now() - ($1::int * interval '1 millisecond')
         and not exists (
           select 1 from webhook_events w
           where w.order_id = o.id and w.status = 'paid' and w.applied_at is null
         )
       order by o.created_at
       limit 50
       for update skip locked`,
      [config.ORDER_EXPIRES_AFTER_MS]
    )

    let expired = 0

    for (const row of rows) {
      const updated = await client.query(
        `update orders
         set status = 'payment_failed',
             failure_code = 'reservation_expired',
             failure_reason = 'order expired before payment'
         where id = $1 and status = 'created'`,
        [row.id]
      )

      if ((updated.rowCount ?? 0) > 0) {
        await release(client, row.id)
        await releasePromocode(client, row.id)
        expired += 1
      }
    }

    return expired
  }, app.pool)
}

async function drainAcceptedPayments(app: FastifyInstance): Promise<string[]> {
  const { rows } = await app.pool.query<{ order_id: string }>(
    `select distinct order_id from webhook_events
     where applied_at is null
     order by order_id
     limit 20`
  )

  for (const row of rows) {
    try {
      await applyPending(app.pool, row.order_id)
    } catch (error) {
      app.log.error({ err: error, orderId: row.order_id }, 'could not apply accepted payment')
    }
  }

  return rows.map((row) => row.order_id)
}

export function startReservationSweeper(app: FastifyInstance): () => void {
  if (config.RESERVATION_SWEEP_INTERVAL_MS === 0) return () => {}

  let running = false

  const tick = async () => {
    if (running) return
    running = true

    try {
      const released = await expireReservations(app.pool)

      if (released > 0) {
        app.log.info({ count: released }, 'sweeper released expired reservations')
      }
    } catch (error) {
      app.log.error({ err: error }, 'reservation sweep failed')
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void tick(), config.RESERVATION_SWEEP_INTERVAL_MS)
  timer.unref()

  return () => clearInterval(timer)
}

export function startDeliverySweeper(app: FastifyInstance): () => void {
  if (config.DELIVERY_SWEEP_INTERVAL_MS === 0) return () => {}

  let running = false

  const tick = async () => {
    if (running) return
    running = true

    try {
      const drained = await drainAcceptedPayments(app)

      if (drained.length > 0) {
        app.log.info({ count: drained.length }, 'sweeper applied accepted payments')
      }

      const expired = await expireAbandonedOrders(app)

      if (expired > 0) {
        app.log.info({ count: expired }, 'sweeper expired abandoned orders')
      }

      await app.pool.query(
        `delete from catalog_events
         where occurred_at < now() - ($1::int * interval '1 millisecond')`,
        [config.CATALOG_EVENT_RETENTION_MS]
      )

      const ids = await claimStuckOrders(app)

      for (const id of ids) {
        try {
          await deliverOrder(app.pool, id)
        } catch (error) {
          app.log.error({ err: error, orderId: id }, 'sweeper failed to deliver order')
        }
      }

      if (ids.length > 0) {
        app.log.info({ count: ids.length }, 'sweeper processed stuck orders')
      }
    } catch (error) {
      app.log.error({ err: error }, 'sweeper tick failed')
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void tick(), config.DELIVERY_SWEEP_INTERVAL_MS)
  timer.unref()

  return () => clearInterval(timer)
}
