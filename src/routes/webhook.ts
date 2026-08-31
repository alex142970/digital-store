import type { FastifyInstance } from 'fastify'
import { ref } from '../openapi.ts'
import { notImplemented } from './not-implemented.ts'

export default async function webhookRoutes(app: FastifyInstance) {
  app.post(
    '/webhook/payment',
    {
      config: { rateLimit: false },
      schema: {
        body: ref('PaymentWebhook'),
        response: {
          200: ref('WebhookAccepted'),
          400: ref('Error'),
          501: ref('Error')
        }
      }
    },
    notImplemented('receivePaymentWebhook')
  )
}
