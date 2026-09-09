import type { FastifyInstance } from 'fastify'
import { ref } from '../openapi.ts'
import { cancelOrder, createOrder, getOrder, OrderError } from '../services/orders.ts'
import { buildPaymentEvent } from '../services/payments.ts'
import { applyPending, receivePayment } from '../services/webhooks.ts'
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
      const order = await getOrder(app.pool, request.params.orderId)

      if (order.status !== 'created') {
        throw new OrderError(409, 'order_not_payable', `Order is already ${order.status}`)
      }

      const event = await buildPaymentEvent(app.pool, order.id, request.body.outcome)
      await receivePayment(app.pool, event, { awaitDelivery: true })

      return reply.status(202).send({ eventId: event.event_id })
    }
  )
}
