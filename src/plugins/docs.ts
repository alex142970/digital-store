import fp from 'fastify-plugin'
import scalar from '@scalar/fastify-api-reference'
import { spec } from '../openapi.ts'

export default fp(async (app) => {
  app.get('/openapi.json', async () => spec)

  await app.register(scalar, {
    routePrefix: '/docs',
    configuration: { url: '/openapi.json' }
  })
})
