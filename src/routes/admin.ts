import type { FastifyInstance } from 'fastify'
import { ref } from '../openapi.ts'
import { deliverOrder } from '../services/delivery.ts'
import { UNFINISHED } from '../services/order-status.ts'
import { withTransaction } from '../db/pool.ts'
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

  app.patch<{ Params: { sku: string }; Body: { price?: number; oldPrice?: number | null } }>(
    '/api/admin/products/:sku',
    {
      schema: {
        params: ref('SkuParams'),
        body: ref('ProductPatch'),
        response: {
          200: ref('Product'),
          400: ref('Error'),
          404: ref('Error')
        }
      }
    },
    async (request, reply) => {
      const { sku } = request.params
      const { price, oldPrice } = request.body

      const current = await app.pool.query<{ price: number; old_price: number | null }>(
        'select price, old_price from products where sku = $1',
        [sku]
      )

      const found = current.rows[0]

      if (!found) {
        return reply.status(404).send({ error: 'product_not_found', message: `Unknown sku ${sku}` })
      }

      const nextPrice = price ?? found.price
      const nextOld = oldPrice !== undefined ? oldPrice : found.old_price

      if (nextOld !== null && nextOld <= nextPrice && oldPrice !== undefined) {
        return reply.status(400).send({
          error: 'validation_error',
          message: 'Зачёркнутая цена должна быть больше текущей'
        })
      }

      const updated = await app.pool.query(
        `update products
         set price = coalesce($2, price),
             old_price = case
               when $3::boolean then $4
               when $2::int is not null and old_price is not null and old_price <= $2::int then null
               else old_price
             end
         where sku = $1`,
        [sku, price ?? null, oldPrice !== undefined, oldPrice ?? null]
      )

      if (updated.rowCount === 0) {
        return reply.status(404).send({ error: 'product_not_found', message: `Unknown sku ${sku}` })
      }

      const { rows } = await app.pool.query(
        `select p.sku, p.name, p.type, p.price, p.currency, p.image, p.old_price as "oldPrice",
                (select count(*)::int from license_keys k
                 where k.sku = p.sku and k.allocated_order_id is null and k.order_id is null) as available
         from products p where p.sku = $1`,
        [sku]
      )

      return reply.send(rows[0])
    }
  )

  app.delete<{ Body: { sku: string; count: number } }>(
    '/api/admin/keys',
    {
      schema: {
        body: ref('KeyRemoval'),
        response: {
          200: ref('KeyRemovalResult'),
          400: ref('Error'),
          404: ref('Error')
        }
      }
    },
    async (request, reply) => {
      const { sku, count } = request.body

      const product = await app.pool.query('select 1 from products where sku = $1', [sku])

      if (product.rowCount === 0) {
        return reply.status(404).send({ error: 'product_not_found', message: `Unknown sku ${sku}` })
      }

      const result = await withTransaction(async (client) => {
        const removed = await client.query(
          `delete from license_keys where id in (
             select id from license_keys
             where sku = $1 and allocated_order_id is null and order_id is null
             order by id
             limit $2
             for update skip locked
           )`,
          [sku, count]
        )

        const available = await client.query<{ count: number }>(
          `select count(*)::int as count from license_keys
           where sku = $1 and allocated_order_id is null and order_id is null`,
          [sku]
        )

        return {
          removed: removed.rowCount ?? 0,
          available: available.rows[0]?.count ?? 0
        }
      }, app.pool)

      return reply.send({ sku, requested: count, ...result })
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
        `select count(*)::int as count from license_keys
         where sku = $1 and allocated_order_id is null and order_id is null`,
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
