import type { FastifyInstance } from 'fastify'
import { ref } from '../openapi.ts'
import { cancelOrder, createOrder, getOrder, OrderError } from '../services/orders.ts'
import { acceptPayment } from '../services/payments.ts'
import { applyPending } from '../services/webhooks.ts'
import type { components } from '../types/api.d.ts'

type CreateOrderRequest = components['schemas']['CreateOrderRequest']
type PayRequest = components['schemas']['PayRequest']

export default async function orderRoutes(app: FastifyInstance) {
  app.post<{ Body: CreateOrderRequest }>(
    '/api/orders',
    {
      schema: {
        body: ref('CreateOrderRequest'),
        response: {
          200: ref('Order'),
          201: ref('Order'),
          400: ref('Error'),
          404: ref('Error'),
          409: ref('CheckoutConflict')
        }
      }
    },
    async (request, reply) => {
      const { order, created } = await createOrder(app.pool, {
        sku: request.body.sku,
        idempotencyKey: request.body.idempotencyKey,
        promoCode: request.body.promoCode
      })

      if (created) {
        await applyPending(app.pool, order.id, { awaitDelivery: true })
        return reply.status(201).send(await getOrder(app.pool, order.id))
      }

      return reply.status(200).send(order)
    }
  )

  app.get<{ Params: { orderId: string } }>(
    '/api/orders/:orderId',
    {
      config: { rateLimit: { max: 6000, timeWindow: '1 minute' } },
      schema: {
        params: ref('OrderIdParams'),
        response: { 200: ref('Order'), 404: ref('Error') }
      }
    },
    async (request) => getOrder(app.pool, request.params.orderId)
  )

  app.post<{ Params: { orderId: string } }>(
    '/api/orders/:orderId/cancel',
    {
      schema: {
        params: ref('OrderIdParams'),
        response: {
          200: ref('Order'),
          400: ref('Error'),
          404: ref('Error'),
          409: ref('Error')
        }
      }
    },
    async (request) => cancelOrder(app.pool, request.params.orderId)
  )

  app.post<{ Params: { orderId: string }; Body: PayRequest }>(
    '/api/orders/:orderId/pay',
    {
      schema: {
        params: ref('OrderIdParams'),
        body: ref('PayRequest'),
        response: {
          202: ref('PaymentAccepted'),
          400: ref('Error'),
          404: ref('Error'),
          409: ref('Error')
        }
      }
    },
    async (request, reply) => {
      const intent = await acceptPayment(app.pool, request.params.orderId, request.body.outcome)

      if ('blocked' in intent) {
        if (intent.blocked === 'not_found') {
          throw new OrderError(404, 'not_found', `Order ${request.params.orderId} not found`)
        }

        if (intent.blocked === 'payment_in_progress') {
          throw new OrderError(409, 'payment_in_progress', 'Another payment is already accepted')
        }

        throw new OrderError(409, 'order_not_payable', `Order is already ${intent.blocked}`)
      }

      await applyPending(app.pool, request.params.orderId, { awaitDelivery: true })

      return reply.status(202).send({ eventId: intent.event.event_id })
    }
  )
}
