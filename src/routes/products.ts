import type { FastifyInstance } from 'fastify'
import { ref } from '../openapi.ts'
import type { components } from '../types/api.d.ts'

type Product = components['schemas']['Product']

export default async function productRoutes(app: FastifyInstance) {
  app.get(
    '/api/products',
    {
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
        'select sku, name, type, price, currency, image from products order by price'
      )
      return { products: rows }
    }
  )
}
