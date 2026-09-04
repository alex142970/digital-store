import type { FastifyInstance } from 'fastify'
import { ref } from '../openapi.ts'
import { deliverOrder } from '../services/delivery.ts'
import { UNFINISHED } from '../services/order-status.ts'
import { getOrder } from '../services/orders.ts'
import type { components } from '../types/api.d.ts'

type RestockRequest = components['schemas']['RestockRequest']
type Order = components['schemas']['Order']
type Promocode = components['schemas']['Promocode']

export default async function adminRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { state?: 'stuck' | 'all' } }>(
    '/api/admin/orders',
    {
      schema: {
        querystring: ref('AdminOrdersQuery'),
        response: {
          200: {
            type: 'object',
            required: ['orders'],
            properties: { orders: { type: 'array', items: ref('Order') } }
          },
          400: ref('Error')
        }
      }
    },
    async (request) => {
      const stuckOnly = (request.query.state ?? 'stuck') === 'stuck'

      const { rows } = await app.pool.query<{ id: string }>(
        `select o.id from orders o
         where not $1::boolean or o.status = any($2::text[])
         order by o.updated_at desc`,
        [stuckOnly, UNFINISHED]
      )

      const orders: Order[] = []

      for (const row of rows) {
        orders.push(await getOrder(app.pool, row.id))
      }

      return { orders }
    }
  )

  app.get(
    '/api/admin/promocodes',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            required: ['promocodes'],
            properties: { promocodes: { type: 'array', items: ref('Promocode') } }
          }
        }
      }
    },
    async () => {
      const { rows } = await app.pool.query<Promocode>(
        `select code, type, value, currency, max_uses as "maxUses", used_count as "usedCount",
                greatest(max_uses - used_count, 0) as remaining
         from promocodes
         order by code`
      )

      return { promocodes: rows }
    }
  )

  app.post<{ Params: { orderId: string } }>(
    '/api/admin/orders/:orderId/retry',
    {
      schema: {
        params: ref('OrderIdParams'),
        response: {
          200: ref('Order'),
          404: ref('Error'),
          409: ref('Error')
        }
      }
    },
    async (request, reply) => {
      const order = await getOrder(app.pool, request.params.orderId)
      const outcome = await deliverOrder(app.pool, order.id)

      if (outcome === 'not_found') {
        return reply.status(409).send({
          error: 'conflict',
          message: `Order in status ${order.status} cannot be delivered`
        })
      }

      if (outcome === 'in_progress') {
        return reply.status(409).send({
          error: 'conflict',
          message: 'Delivery is already running for this order'
        })
      }

      return getOrder(app.pool, order.id)
    }
  )

  app.post<{ Body: RestockRequest }>(
    '/api/admin/keys',
    {
      schema: {
        body: ref('RestockRequest'),
        response: {
          201: ref('RestockResult'),
          400: ref('Error'),
          404: ref('Error')
        }
      }
    },
    async (request, reply) => {
      const { sku, keys } = request.body

      const product = await app.pool.query('select 1 from products where sku = $1', [sku])

      if (product.rowCount === 0) {
        return reply.status(404).send({ error: 'product_not_found', message: `Unknown sku ${sku}` })
      }

      const inserted = await app.pool.query(
        `insert into license_keys (sku, code)
         select $1, unnest($2::text[])
         on conflict (code) do nothing`,
        [sku, keys]
      )

      const available = await app.pool.query<{ count: number }>(
        'select count(*)::int as count from license_keys where sku = $1 and order_id is null',
        [sku]
      )

      return reply.status(201).send({
        sku,
        added: inserted.rowCount ?? 0,
        available: available.rows[0]?.count ?? 0
      })
    }
  )
}
