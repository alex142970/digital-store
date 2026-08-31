import type { FastifyInstance } from 'fastify'
import { ref } from '../openapi.ts'
import { notImplemented } from './not-implemented.ts'

export default async function orderRoutes(app: FastifyInstance) {
  app.post(
    '/api/orders',
    {
      schema: {
        body: ref('CreateOrderRequest'),
        response: {
          200: ref('Order'),
          201: ref('Order'),
          400: ref('Error'),
          404: ref('Error'),
          501: ref('Error')
        }
      }
    },
    notImplemented('createOrder')
  )

  app.get(
    '/api/orders/:orderId',
    {
      config: { rateLimit: { max: 6000, timeWindow: '1 minute' } },
      schema: {
        params: ref('OrderIdParams'),
        response: { 200: ref('Order'), 404: ref('Error'), 501: ref('Error') }
      }
    },
    notImplemented('getOrder')
  )

  app.post(
    '/api/orders/:orderId/pay',
    {
      schema: {
        params: ref('OrderIdParams'),
        body: ref('PayRequest'),
        response: {
          202: ref('PaymentAccepted'),
          400: ref('Error'),
          404: ref('Error'),
          501: ref('Error')
        }
      }
    },
    notImplemented('payOrder')
  )
}
