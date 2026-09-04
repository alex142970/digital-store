import fp from 'fastify-plugin'
import scalar from '@scalar/fastify-api-reference'
import { spec } from '../openapi.ts'

const DOCS_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data: https://fonts.scalar.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'"
].join(';')

export default fp(async (app) => {
  app.get('/openapi.json', async () => spec)

  await app.register(async (docs) => {
    docs.addHook('onSend', async (request, reply) => {
      if (request.url.startsWith('/docs')) {
        reply.header('content-security-policy', DOCS_CSP)
      }
    })

    await docs.register(scalar, {
      routePrefix: '/docs',
      configuration: { url: '/openapi.json' }
    })
  })
})
