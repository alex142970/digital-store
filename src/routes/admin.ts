import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { config } from '../config.ts'
import { ref } from '../openapi.ts'
import { notImplemented } from './not-implemented.ts'

const tokenMatches = (candidate: string) => {
  const expected = Buffer.from(config.ADMIN_TOKEN)
  const actual = Buffer.from(candidate)

  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    const header = request.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''

    if (!tokenMatches(token)) {
      return reply.status(401).send({ error: 'unauthorized', message: 'Admin token required' })
    }
  })

  app.get(
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
          401: ref('Error'),
          501: ref('Error')
        }
      }
    },
    notImplemented('listStuckOrders')
  )

  app.post(
    '/api/admin/orders/:orderId/retry',
    {
      schema: {
        params: ref('OrderIdParams'),
        response: { 200: ref('Order'), 401: ref('Error'), 404: ref('Error'), 501: ref('Error') }
      }
    },
    notImplemented('retryDelivery')
  )

  app.post(
    '/api/admin/keys',
    {
      schema: {
        body: ref('RestockRequest'),
        response: {
          201: ref('RestockResult'),
          401: ref('Error'),
          501: ref('Error')
        }
      }
    },
    notImplemented('restockKeys')
  )
}
