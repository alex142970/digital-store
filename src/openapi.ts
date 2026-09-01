import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const SPEC_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'openapi.yaml')
const SCHEMA_ID = 'spec'

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

function rewriteRefs(node: JsonValue): JsonValue {
  if (Array.isArray(node)) return node.map(rewriteRefs)
  if (node === null || typeof node !== 'object') return node

  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => {
      if (key === '$ref' && typeof value === 'string' && value.startsWith('#/components/')) {
        return [key, `${SCHEMA_ID}#${value.slice(1)}`]
      }
      return [key, rewriteRefs(value)]
    })
  )
}

export const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, JsonValue>

export const specSchema = {
  $id: SCHEMA_ID,
  components: rewriteRefs(spec.components as JsonValue)
}

export const ref = (name: string) => ({ $ref: `${SCHEMA_ID}#/components/schemas/${name}` })
