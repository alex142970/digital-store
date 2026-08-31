import { afterAll, beforeAll, expect, test } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { buildApp } from '../../src/app.ts'
import { createPool } from '../../src/db/pool.ts'
import { migrate } from '../../src/db/migrate.ts'

let container: StartedPostgreSqlContainer
let pool: pg.Pool
let app: FastifyInstance

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').start()
  pool = createPool({ connectionString: container.getConnectionUri() })
  await migrate(pool)
  app = await buildApp({ pool, logger: false })
})

afterAll(async () => {
  await app?.close()
  await pool?.end()
  await container?.stop()
})

test('health reports database is reachable', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/health' })

  expect(response.statusCode).toBe(200)
  expect(response.json()).toMatchObject({ status: 'ok', db: 'up' })
})

test('health reports 503 when database is unreachable', async () => {
  const brokenPool = createPool({ connectionString: 'postgres://nobody@127.0.0.1:1/none' })
  const brokenApp = await buildApp({ pool: brokenPool, logger: false })

  const response = await brokenApp.inject({ method: 'GET', url: '/api/health' })

  expect(response.statusCode).toBe(503)
  expect(response.json()).toMatchObject({ status: 'error', db: 'down' })

  await brokenApp.close()
  await brokenPool.end()
})

test('parallel migrations apply exactly once', async () => {
  const fresh = await new PostgreSqlContainer('postgres:18-alpine').start()
  const freshPool = createPool({ connectionString: fresh.getConnectionUri() })

  try {
    const [first, second] = await Promise.all([migrate(freshPool), migrate(freshPool)])
    const applied = [...first, ...second]

    expect(applied).toEqual(['001_init.sql'])
  } finally {
    await freshPool.end()
    await fresh.stop()
  }
})
