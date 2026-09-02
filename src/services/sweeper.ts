import type { FastifyInstance } from 'fastify'
import { config } from '../config.ts'
import { withTransaction } from '../db/pool.ts'
import { deliverOrder } from './delivery.ts'

const RESUMABLE = ['paid', 'delivering', 'out_of_stock', 'delivery_failed']

async function claimStuckOrders(app: FastifyInstance): Promise<string[]> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; status: string }>(
      `select id, status from orders
       where status = any($1::text[])
         and updated_at < now() - ($2::int * interval '1 millisecond')
       order by updated_at
       limit 20
       for update skip locked`,
      [RESUMABLE, config.DELIVERY_STUCK_AFTER_MS]
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

export function startDeliverySweeper(app: FastifyInstance): () => void {
  if (config.DELIVERY_SWEEP_INTERVAL_MS === 0) return () => {}

  let running = false

  const tick = async () => {
    if (running) return
    running = true

    try {
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
