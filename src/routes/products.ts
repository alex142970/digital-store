import type { FastifyInstance } from 'fastify'
import { ref } from '../openapi.ts'
import { searchCatalog, type CatalogQuery } from '../services/catalog.ts'
import type { components } from '../types/api.d.ts'

type Product = components['schemas']['Product']

export default async function productRoutes(app: FastifyInstance) {
  app.get(
    '/api/products',
    {
      config: { rateLimit: { max: 6000, timeWindow: '1 minute' } },
      schema: {
        response: {
          200: {
            type: 'object',
            required: ['products'],
            properties: {
              products: { type: 'array', items: ref('Product') }
            }
          }
        }
      }
    },
    async () => {
      const { rows } = await app.pool.query<Product>(
        `select p.sku, p.name, p.type, p.price, p.currency, p.image, p.old_price as "oldPrice",
                (select count(*)::int from license_keys k
                 where k.sku = p.sku and k.allocated_order_id is null and k.order_id is null) as available
         from products p where p.featured order by p.price, p.sku`
      )
      return { products: rows }
    }
  )

  app.get<{ Querystring: CatalogQuery }>(
    '/api/catalog',
    {
      config: { rateLimit: { max: 6000, timeWindow: '1 minute' } },
      schema: {
        querystring: ref('CatalogQuery'),
        response: { 200: ref('CatalogPage'), 400: ref('Error') }
      }
    },
    async (request) => searchCatalog(app.pool, request.query)
  )
}
