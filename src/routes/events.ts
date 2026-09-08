import { PassThrough } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { config } from '../config.ts'
import { catalogChanges } from '../services/catalog-events.ts'

const open = new Set<() => void>()

export function closeCatalogStreams(): void {
  for (const shutdown of [...open]) shutdown()
  open.clear()
}

export default async function eventRoutes(app: FastifyInstance) {
  app.get(
    '/api/events',
    { config: { rateLimit: false, compress: false } },
    async (request, reply) => {
      const stream = new PassThrough()

      reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8')
      reply.raw.setHeader('cache-control', 'no-cache, no-transform')
      reply.raw.setHeader('connection', 'keep-alive')
      reply.raw.setHeader('x-accel-buffering', 'no')

      stream.write(`retry: ${config.SSE_RETRY_MS}\n\n`)

      let closed = false

      const close = () => {
        if (closed) return
        closed = true

        clearInterval(heartbeat)
        catalogChanges.off('change', onChange)
        catalogChanges.off('reconnect', onReconnect)
        open.delete(close)
        stream.destroy()
      }

      const send = (chunk: string) => {
        if (closed) return

        stream.write(chunk)

        if (stream.writableLength > config.SSE_MAX_BUFFER_BYTES) close()
      }

      const onChange = (sku: string) => {
        send(`event: catalog\ndata: ${JSON.stringify({ sku })}\n\n`)
      }

      const onReconnect = () => {
        send('event: resync\ndata: {}\n\n')
      }

      catalogChanges.on('change', onChange)
      catalogChanges.on('reconnect', onReconnect)

      const heartbeat = setInterval(() => send(': ping\n\n'), config.SSE_HEARTBEAT_MS)

      heartbeat.unref()

      open.add(close)
      request.raw.on('close', close)
      stream.on('close', close)

      return reply.send(stream)
    }
  )
}
