import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyHelmet from '@fastify/helmet'
import fastifyRateLimit from '@fastify/rate-limit'
import type pg from 'pg'
import { config } from './config.ts'
import { getPool } from './db/pool.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export type BuildOptions = {
  pool?: pg.Pool
  logger?: boolean
}

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const pool = options.pool ?? getPool()

  const app = Fastify({
    logger: options.logger === false ? false : { level: config.LOG_LEVEL },
    trustProxy: config.TRUST_PROXY
  })

  await app.register(fastifyHelmet, { contentSecurityPolicy: false })
  await app.register(fastifyRateLimit, {
    max: 600,
    timeWindow: '1 minute',
    allowList: (request) => request.url === '/api/health'
  })
  await app.register(fastifyStatic, { root: join(ROOT, 'public'), prefix: '/' })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, 'request failed')
    const status = error.statusCode ?? 500
    return reply.status(status).send({
      error: status >= 500 ? 'internal_error' : (error.code ?? 'request_error'),
      message: status >= 500 ? 'Internal server error' : error.message
    })
  })

  app.get('/api/health', async (_request, reply) => {
    try {
      await pool.query('select 1')
      return reply.send({ status: 'ok', db: 'up' })
    } catch {
      return reply.status(503).send({ status: 'error', db: 'down' })
    }
  })

  return app
}
