import pg from 'pg'
import { config } from '../config.ts'

export type PoolOverrides = Partial<pg.PoolConfig>

export function createPool(overrides: PoolOverrides = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.PG_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: config.PG_STATEMENT_TIMEOUT_MS,
    lock_timeout: config.PG_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: 10_000,
    ...overrides
  })

  pool.on('error', (error) => {
    console.error({ err: error }, 'idle client error')
  })

  return pool
}

let defaultPool: pg.Pool | undefined

export function getPool(): pg.Pool {
  defaultPool ??= createPool()
  return defaultPool
}

export async function closePool(): Promise<void> {
  const pool = defaultPool
  defaultPool = undefined
  await pool?.end()
}

export async function withTransaction<T>(
  run: (client: pg.PoolClient) => Promise<T>,
  target: pg.Pool = getPool()
): Promise<T> {
  const client = await target.connect()

  try {
    await client.query('begin')
    const result = await run(client)
    await client.query('commit')
    client.release()
    return result
  } catch (error) {
    try {
      await client.query('rollback')
      client.release()
    } catch {
      client.release(error as Error)
    }
    throw error
  }
}
