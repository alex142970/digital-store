import { buildApp } from './app.ts'
import { config } from './config.ts'
import { closePool } from './db/pool.ts'

const app = await buildApp()

let closing = false

const close = async (signal: string) => {
  if (closing) return
  closing = true
  app.log.info({ signal }, 'shutting down')

  const force = setTimeout(() => process.exit(1), 10_000)
  force.unref()

  try {
    await app.close()
    await closePool()
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed')
    process.exitCode = 1
  }
}

process.on('SIGTERM', () => void close('SIGTERM'))
process.on('SIGINT', () => void close('SIGINT'))

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' })
} catch (error) {
  app.log.error({ err: error }, 'failed to start')
  await app.close()
  await closePool()
  process.exit(1)
}
