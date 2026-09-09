import type { FastifyInstance } from 'fastify'
import { ref } from '../openapi.ts'
import { OrderError } from '../services/orders.ts'
import { INTERNAL_EVENT_PREFIX } from '../services/payments.ts'
import { receivePayment } from '../services/webhooks.ts'
import type { components } from '../types/api.d.ts'

type PaymentWebhook = components['schemas']['PaymentWebhook']

export default async function webhookRoutes(app: FastifyInstance) {
  app.post<{ Body: PaymentWebhook }>(
    '/webhook/payment',
    {
      config: { rateLimit: false },
      schema: {
        body: ref('PaymentWebhook'),
        response: {
          200: ref('WebhookAccepted'),
          400: ref('Error'),
          500: ref('Error')
        }
      }
    },
    async (request) => {
      if (request.body.event_id.startsWith(INTERNAL_EVENT_PREFIX)) {
        throw new OrderError(400, 'validation_error', 'event_id prefix is reserved')
      }

      return receivePayment(app.pool, request.body)
    }
  )
}
