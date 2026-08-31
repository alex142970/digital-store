import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyHelmet from '@fastify/helmet'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyCompress from '@fastify/compress'
import type pg from 'pg'
import { config } from './config.ts'
import { getPool } from './db/pool.ts'
import validation from './plugins/validation.ts'
import docs from './plugins/docs.ts'
import productRoutes from './routes/products.ts'
import orderRoutes from './routes/orders.ts'
import webhookRoutes from './routes/webhook.ts'
import providerRoutes from './routes/providers.ts'
import adminRoutes from './routes/admin.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export type BuildOptions = {
  pool?: pg.Pool
  logger?: boolean
}

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const pool = options.pool ?? getPool()

  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: {
              paths: ['err.detail', 'err.where', 'err.query', 'req.headers.authorization'],
              remove: true
            }
          },
    trustProxy: config.TRUST_PROXY
  })

  await app.register(fastifyHelmet, { contentSecurityPolicy: false })
  await app.register(fastifyCompress, { global: true, threshold: 4096 })
  await app.register(fastifyRateLimit, {
    max: 1200,
    timeWindow: '1 minute',
    allowList: (request) => request.routeOptions.url === '/api/health'
  })
  app.decorate('pool', pool)

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, 'request failed')

    const status = error.statusCode ?? 500

    if (status >= 500) {
      return reply
        .status(status)
        .send({ error: 'internal_error', message: 'Internal server error' })
    }

    const code =
      error.code === 'FST_ERR_VALIDATION'
        ? 'validation_error'
        : status === 401
          ? 'unauthorized'
          : status === 404
            ? 'not_found'
            : status === 409
              ? 'conflict'
              : status === 429
                ? 'rate_limited'
                : 'validation_error'

    return reply.status(status).send({ error: code, message: error.message })
  })

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({ error: 'not_found', message: 'Route not found' })
  )

  await app.register(validation)
  await app.register(docs)
  await app.register(productRoutes)
  await app.register(orderRoutes)
  await app.register(webhookRoutes)
  await app.register(providerRoutes)
  await app.register(adminRoutes)

  await app.register(fastifyStatic, { root: join(ROOT, 'public'), prefix: '/' })

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

declare module 'fastify' {
  interface FastifyInstance {
    pool: pg.Pool
  }
}
