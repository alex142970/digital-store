import type { RouteHandlerMethod } from 'fastify'

export function notImplemented(operation: string): RouteHandlerMethod {
  return async (_request, reply) =>
    reply.status(501).send({
      error: 'not_implemented',
      message: `Operation ${operation} is not implemented yet`
    })
}
