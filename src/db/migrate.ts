import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'
import { createPool } from './pool.ts'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')
const LOCK_KEY = 'digital-store:migrations'

const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex').slice(0, 16)

export async function migrate(target?: pg.Pool): Promise<string[]> {
  const pool = target ?? createPool({ statement_timeout: 0, lock_timeout: 0 })
  const client = await pool.connect()
  const applied: string[] = []
  let failure: unknown

  try {
    await client.query('select pg_advisory_lock(hashtext($1))', [LOCK_KEY])
    await client.query(`
      create table if not exists schema_migrations (
        name       text primary key,
        checksum   text not null,
        applied_at timestamptz not null default now()
      )
    `)

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'select name, checksum from schema_migrations'
    )
    const done = new Map(rows.map((r) => [r.name, r.checksum]))

    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
      const hash = checksum(sql)
      const known = done.get(file)

      if (known === hash) continue
      if (known) throw new Error(`Migration ${file} changed after it was applied`)

      await client.query('begin')
      try {
        await client.query(sql)
        await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [
          file,
          hash
        ])
        await client.query('commit')
        applied.push(file)
      } catch (error) {
        await client.query('rollback').catch(() => {})
        throw new Error(`Migration ${file} failed`, { cause: error })
      }
    }
  } catch (error) {
    failure = error
  }

  try {
    await client.query('select pg_advisory_unlock(hashtext($1))', [LOCK_KEY])
    client.release()
  } catch {
    client.release(new Error('advisory unlock failed'))
  }

  if (!target) await pool.end()
  if (failure) throw failure

  return applied
}

if (import.meta.filename === process.argv[1]) {
  try {
    const applied = await migrate()
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'nothing to apply')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
