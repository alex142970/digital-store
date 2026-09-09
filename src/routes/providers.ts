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

      const order = await app.pool.query<{ sku: string }>('select sku from orders where id = $1', [
        order_id
      ])

      if (order.rowCount === 0 || order.rows[0]?.sku !== sku) {
        return reply.status(409).send({ status: 'error', reason: 'sku does not match the order' })
      }

      const issued = await withTransaction(async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [
          `provider:${provider}:${request_id}`
        ])

        await client.query('select 1 from orders where id = $1 for update', [order_id])

        const repeated = await client.query<{ code: string }>(
          'select code from provider_issues where provider = $1 and request_id = $2',
          [provider, request_id]
        )

        if (repeated.rows[0]) return { kind: 'issued' as const, code: repeated.rows[0].code }

        const owned = await client.query<{ id: string }>(
          'select id from license_keys where allocated_order_id = $1 and order_id is null',
          [order_id]
        )

        const ownedId = owned.rows[0]?.id

        const key = await client.query<{ id: string; code: string }>(
          ownedId
            ? `select id, code from license_keys
               where id = $1
               for update skip locked`
            : `select id, code from license_keys
               where sku = $1 and allocated_order_id is null and order_id is null
               order by id
               for update skip locked
               limit 1`,
          ownedId ? [ownedId] : [sku]
        )

        const picked = key.rows[0]

        if (!picked) return { kind: ownedId ? ('busy' as const) : ('empty' as const) }

        const taken = await client.query(
          `update license_keys
           set allocated_order_id = $1, order_id = $1, issued_at = now()
           where id = $2
             and order_id is null
             and (allocated_order_id = $1 or allocated_order_id is null)`,
          [order_id, picked.id]
        )

        if ((taken.rowCount ?? 0) === 0) return { kind: 'busy' as const }

        await client.query(
          `insert into provider_issues (provider, request_id, code) values ($1, $2, $3)
           on conflict (provider, request_id) do nothing`,
          [provider, request_id, picked.code]
        )

        return { kind: 'issued' as const, code: picked.code }
      }, app.pool)

      if (issued.kind === 'busy') {
        return reply.status(503).send({ status: 'error', reason: 'inventory busy, retry' })
      }

      if (issued.kind === 'empty') {
        return reply.status(409).send({ status: 'error', reason: 'out_of_stock' })
      }

      if (willHang) {
        await hang()
      }

      return reply.send({ status: 'ok', request_id, code: issued.code })
    }
  )
}
