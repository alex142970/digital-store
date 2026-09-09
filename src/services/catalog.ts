import type pg from 'pg'
import type { components } from '../types/api.d.ts'

export type Product = components['schemas']['Product']
export type CatalogPage = components['schemas']['CatalogPage']

export type CatalogQuery = {
  q?: string
  type?: string
  min?: number
  max?: number
  stock?: boolean
  sort?: 'relevance' | 'price' | 'priceDesc'
  limit?: number
  offset?: number
}

const MIN_TERM = 3
const FUZZY_THRESHOLD = 0.6

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`)

const IN_STOCK = 'p.in_stock'

const ORDER = {
  price: 'm.price asc, m.sku asc',
  priceDesc: 'm.price desc, m.sku asc',
  relevance: 'm.exact desc, m.similarity desc, m.in_stock desc, m.price asc, m.sku asc'
}

type Row = { item: Product; total: number }

export async function searchCatalog(pool: pg.Pool, query: CatalogQuery): Promise<CatalogPage> {
  const limit = Math.min(Math.max(query.limit ?? 24, 1), 60)
  const offset = Math.max(query.offset ?? 0, 0)
  const term = query.q?.trim().toLowerCase() ?? ''

  if (term.length > 0 && term.length < MIN_TERM) return { items: [], total: 0 }

  const filters: string[] = []
  const params: unknown[] = []

  const add = (value: unknown): string => {
    params.push(value)
    return `$${params.length}`
  }

  let exact = 'false'
  let similarity = '0'

  if (term) {
    const pattern = add(escapeLike(term))
    const raw = add(term)

    exact = `p.search_text like '%' || ${pattern} || '%' escape '\\'`
    similarity = `greatest(similarity(p.search_text, ${raw}), word_similarity(${raw}, p.search_text))`

    filters.push(`(${exact} or ${raw} <% p.search_text)`)
    filters.push(`(${exact} or word_similarity(${raw}, p.search_text) >= ${FUZZY_THRESHOLD})`)
  }

  if (query.type) filters.push(`p.type = ${add(query.type)}`)
  if (query.min !== undefined) filters.push(`p.price >= ${add(query.min)}`)
  if (query.max !== undefined) filters.push(`p.price <= ${add(query.max)}`)
  if (query.stock) filters.push(IN_STOCK)

  const where = filters.length > 0 ? `where ${filters.join(' and ')}` : ''
  const order = ORDER[query.sort ?? 'relevance'] ?? ORDER.relevance

  const { rows } = await pool.query<Row>(
    `with matched as (
       select p.sku, p.name, p.type, p.price, p.currency, p.image,
              p.old_price as "oldPrice", p.in_stock,
              ${exact} as exact,
              ${similarity} as similarity
       from products p
       ${where}
     ),
     counted as (select count(*)::int as total from matched)
     select to_jsonb(found) - 'similarity' - 'exact' - 'in_stock' as item, counted.total
     from counted
     left join lateral (
       select m.*, (
         select count(*)::int from license_keys k
         where k.sku = m.sku and k.allocated_order_id is null and k.order_id is null
       ) as available
       from matched m
       order by ${order}
       limit ${add(limit)} offset ${add(offset)}
     ) found on true`,
    params
  )

  return {
    items: rows.filter((row) => row.item !== null).map((row) => row.item),
    total: rows[0]?.total ?? 0
  }
}
