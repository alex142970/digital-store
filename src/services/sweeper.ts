import type { FastifyInstance } from 'fastify'
import { config } from '../config.ts'
import { withTransaction } from '../db/pool.ts'
import { deliverOrder } from './delivery.ts'
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
      `select id from orders
       where status = 'created'
         and created_at < now() - ($1::int * interval '1 millisecond')
       order by created_at
       limit 50
       for update skip locked`,
      [config.ORDER_EXPIRES_AFTER_MS]
    )

    let expired = 0

    for (const row of rows) {
      const updated = await client.query(
        `update orders set status = 'payment_failed', failure_reason = 'order expired before payment'
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
