import { spawn, type ChildProcess } from 'node:child_process'
import { PostgreSqlContainer } from '@testcontainers/postgresql'

export const E2E_PORT = 3100
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`

function waitForHealth(url: string, proc: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000
    let stderr = ''

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    proc.once('exit', (code) => {
      if (code !== null) reject(new Error(`e2e server exited early (code ${code}):\n${stderr}`))
    })

    const attempt = () => {
      fetch(url)
        .then((res) => (res.ok ? resolve() : Promise.reject(new Error(`status ${res.status}`))))
        .catch(() => {
          if (Date.now() > deadline) {
            reject(new Error(`e2e server did not become healthy in time:\n${stderr}`))
            return
          }
          setTimeout(attempt, 300)
        })
    }

    attempt()
  })
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer('postgres:18-alpine').start()
  const databaseUrl = container.getConnectionUri()

  process.env.DATABASE_URL = databaseUrl
  process.env.E2E_DATABASE_URL = databaseUrl
  process.env.LOG_LEVEL = 'error'
  process.env.CATALOG_BULK_SIZE = '1200'

  const { createPool } = await import('../../src/db/pool.ts')
  const { migrate } = await import('../../src/db/migrate.ts')
  const { seed } = await import('../../src/db/seed.ts')

  const pool = createPool()
  await migrate(pool)
  await seed(pool)
  await pool.end()

  const server = spawn('node', ['--env-file-if-exists=.env', 'src/server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(E2E_PORT),
      DATABASE_URL: databaseUrl,
      PROVIDER_A_ERROR_RATE: '0',
      PROVIDER_A_TIMEOUT_RATE: '0',
      PROVIDER_B_ERROR_RATE: '0',
      PROVIDER_B_TIMEOUT_RATE: '0',
      PROVIDER_TIMEOUT_MS: '1000',
      DELIVERY_SWEEP_INTERVAL_MS: '300',
      DELIVERY_STUCK_AFTER_MS: '1000',
      CATALOG_BULK_SIZE: '1200',
      LOG_LEVEL: 'error'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  })

  await waitForHealth(`${E2E_BASE_URL}/api/health`, server)

  return async () => {
    server.kill('SIGTERM')
    await new Promise((resolve) => server.once('exit', resolve))
    await container.stop()
  }
}
