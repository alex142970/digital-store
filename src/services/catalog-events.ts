import { EventEmitter } from 'node:events'
import pg from 'pg'
import { config } from '../config.ts'

export type CatalogListener = { stop: () => Promise<void> }

const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 10_000

export const catalogChanges = new EventEmitter()

catalogChanges.setMaxListeners(0)

export function startCatalogListener(
  log: {
    info: (obj: object, msg: string) => void
    error: (obj: object, msg: string) => void
  },
  connectionString: string = config.DATABASE_URL
): CatalogListener {
  let client: pg.Client | null = null
  let timer: NodeJS.Timeout | null = null
  let backoff = RECONNECT_MIN_MS
  let stopped = false

  const schedule = () => {
    if (stopped || timer) return

    timer = setTimeout(() => {
      timer = null
      void connect()
    }, backoff)

    timer.unref()
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
  }

  const connect = async () => {
    if (stopped) return

    const next = new pg.Client({
      connectionString,
      keepAlive: true,
      connectionTimeoutMillis: 10_000
    })

    client = next

    next.on('error', (error) => {
      log.error({ err: error }, 'catalog listener connection failed')
      client = null
      next.end().catch(() => {})
      schedule()
    })

    next.on('notification', (message) => {
      if (message.payload) catalogChanges.emit('change', message.payload)
    })

    try {
      await next.connect()
      await next.query('listen catalog')

      if (stopped) {
        client = null
        await next.end().catch(() => {})
        return
      }

      client = next
      backoff = RECONNECT_MIN_MS
      catalogChanges.emit('reconnect')
    } catch (error) {
      log.error({ err: error }, 'catalog listener could not subscribe')
      await next.end().catch(() => {})
      schedule()
    }
  }

  void connect()

  return {
    stop: async () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      const open = client
      client = null
      await open?.end().catch(() => {})
    }
  }
}
