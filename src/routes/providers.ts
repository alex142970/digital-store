import type { FastifyInstance } from 'fastify'
import { config } from '../config.ts'
import { ref } from '../openapi.ts'
import { withTransaction } from '../db/pool.ts'
import { providerBehaviour } from '../services/provider-behaviour.ts'
import type { components } from '../types/api.d.ts'

type IssueRequest = components['schemas']['IssueRequest']

const hang = () => new Promise((resolve) => setTimeout(resolve, config.PROVIDER_TIMEOUT_MS * 3))

export default async function providerRoutes(app: FastifyInstance) {
  app.post<{ Params: { provider: 'a' | 'b' }; Body: IssueRequest }>(
    '/internal/providers/:provider/issue',
    {
      config: { rateLimit: false },
      schema: {
        params: ref('ProviderParams'),
        body: ref('IssueRequest'),
        response: {
          200: ref('IssueResponse'),
          409: ref('IssueError'),
          503: ref('IssueError')
        }
      }
    },
    async (request, reply) => {
      const { provider } = request.params
      const { request_id, sku, order_id } = request.body

      const known = await app.pool.query<{ code: string }>(
        'select code from provider_issues where provider = $1 and request_id = $2',
        [provider, request_id]
      )

      if (known.rows[0]) {
        return reply.send({ status: 'ok', request_id, code: known.rows[0].code })
      }

      const dice = Math.random()
      const { errorRate, timeoutRate } = providerBehaviour[provider]
      const willHang = dice < timeoutRate

      if (!willHang && dice < timeoutRate + errorRate) {
        return reply.status(503).send({ status: 'error', reason: 'provider unavailable' })
      }

      const issued = await withTransaction(async (client) => {
        const key = await client.query<{ id: string; code: string }>(
          `select id, code from license_keys
           where sku = $1 and order_id is null
           order by id
           for update skip locked
           limit 1`,
          [sku]
        )

        const picked = key.rows[0]

        if (!picked) return null

        await client.query(
          `insert into provider_issues (provider, request_id, code) values ($1, $2, $3)
           on conflict (provider, request_id) do nothing`,
          [provider, request_id, picked.code]
        )

        await client.query(
          'update license_keys set order_id = $1, issued_at = now() where id = $2',
          [order_id, picked.id]
        )

        return picked.code
      }, app.pool)

      if (!issued) {
        return reply.status(409).send({ status: 'error', reason: 'out_of_stock' })
      }

      if (willHang) {
        await hang()
      }

      return reply.send({ status: 'ok', request_id, code: issued })
    }
  )
}
