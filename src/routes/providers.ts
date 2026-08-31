import type { FastifyInstance } from 'fastify'
import { ref } from '../openapi.ts'
import { notImplemented } from './not-implemented.ts'

export default async function providerRoutes(app: FastifyInstance) {
  app.post(
    '/internal/providers/:provider/issue',
    {
      config: { rateLimit: false },
      schema: {
        params: ref('ProviderParams'),
        body: ref('IssueRequest'),
        response: {
          200: ref('IssueResponse'),
          501: ref('Error')
        }
      }
    },
    notImplemented('issueFromProvider')
  )
}
