import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'
import { createPool } from './pool.ts'

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data')

type Product = {
  sku: string
  name: string
  type: string
  price: number
  currency: string
  image: string | null
  old_price?: number
}

type Promocode = {
  code: string
  type: string
  value: number
  currency?: string
  max_uses: number
}

const read = async <T>(file: string): Promise<T> =>
  JSON.parse(await readFile(join(DATA_DIR, file), 'utf8')) as T

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const codeFor = (sku: string, index: number): string => {
  const digest = createHash('sha256').update(`${sku}:${index}`).digest()
  const chars = Array.from({ length: 12 }, (_, position) =>
    CODE_ALPHABET.charAt((digest.at(position) ?? 0) % CODE_ALPHABET.length)
  ).join('')

  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`
}

export async function seed(target?: pg.Pool): Promise<Record<string, number>> {
  const pool = target ?? createPool()
  const client = await pool.connect()

  try {
    await client.query('begin')
    const { products } = await read<{ products: Product[] }>('catalog.json')
    const { sku, keys } = await read<{ sku: string; keys: string[] }>('keys.json')
    const filler = products
      .filter((product) => product.sku !== sku)
      .flatMap((product) =>
        Array.from({ length: 20 }, (_, index) => ({
          sku: product.sku,
          code: codeFor(product.sku, index)
        }))
      )
    const { promocodes } = await read<{ promocodes: Promocode[] }>('promocodes.json')

    let productRows = 0
    for (const product of products) {
      const result = await client.query(
        `insert into products (sku, name, type, price, currency, image, old_price)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (sku) do update
           set name = excluded.name,
               type = excluded.type,
               price = excluded.price,
               currency = excluded.currency,
               image = excluded.image,
               old_price = excluded.old_price`,
        [
          product.sku,
          product.name,
          product.type,
          product.price,
          product.currency,
          product.image,
          product.old_price ?? null
        ]
      )
      productRows += result.rowCount ?? 0
    }

    const keyResult = await client.query(
      `insert into license_keys (sku, code)
       select $1, unnest($2::text[])
       on conflict (code) do nothing`,
      [sku, keys]
    )

    const fillerResult = await client.query(
      `insert into license_keys (sku, code)
       select * from unnest($1::text[], $2::text[])
       on conflict (code) do nothing`,
      [filler.map((item) => item.sku), filler.map((item) => item.code)]
    )

    let promoRows = 0
    for (const promo of promocodes) {
      const result = await client.query(
        `insert into promocodes (code, type, value, currency, max_uses)
         values ($1, $2, $3, $4, $5)
         on conflict (code) do update
           set type = excluded.type,
               value = excluded.value,
               currency = excluded.currency,
               max_uses = excluded.max_uses`,
        [promo.code, promo.type, promo.value, promo.currency ?? null, promo.max_uses]
      )
      promoRows += result.rowCount ?? 0
    }

    await client.query('commit')

    return {
      products: productRows,
      keys: (keyResult.rowCount ?? 0) + (fillerResult.rowCount ?? 0),
      promocodes: promoRows
    }
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
    if (!target) await pool.end()
  }
}

if (import.meta.filename === process.argv[1]) {
  try {
    const counts = await seed()
    console.log(
      `seeded: ${Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')}`
    )
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
