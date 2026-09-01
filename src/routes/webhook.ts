import type { FastifyInstance } from 'fastify'
import { ref } from '../openapi.ts'
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
    async (request) => receivePayment(app.pool, request.body)
  )
}
