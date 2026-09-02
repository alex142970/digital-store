import { afterEach, expect, test, vi } from 'vitest'
import { issueCode, type IssueOutcome } from '../src/services/providers.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

const timeoutError = () => {
  const error = new Error('timed out')
  error.name = 'TimeoutError'
  return error
}

test('a provider that only ever times out is retried, never replaced by the backup', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(String(url))
    throw timeoutError()
  })

  const log: IssueOutcome[] = []
  const outcome = await issueCode('req_ord_x', 'KEY-CS2-PRIME', 'ord_x', async (a) => {
    log.push(a)
  })

  expect(outcome).toEqual({ kind: 'unknown', provider: 'a', detail: 'timeout' })
  expect(calls.every((u) => u.includes('/providers/a/'))).toBe(true)
  expect(calls).toHaveLength(3)
  expect(log.every((a) => a.provider === 'a' && a.kind === 'unknown')).toBe(true)
})

test('every attempt carries the same request_id', async () => {
  const ids: string[] = []
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    ids.push(JSON.parse(init.body).request_id)
    throw timeoutError()
  })

  await issueCode('req_ord_y', 'KEY-CS2-PRIME', 'ord_y', async () => {})

  expect(new Set(ids)).toEqual(new Set(['req_ord_y']))
})

test('an explicit refusal stops retrying A and goes to B exactly once', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(String(url))
    return {
      status: 500,
      json: async () => ({ status: 'error', reason: 'provider unavailable' })
    }
  })

  const outcome = await issueCode('req_ord_z', 'KEY-CS2-PRIME', 'ord_z', async () => {})

  expect(outcome.provider).toBe('b')
  expect(calls.filter((u) => u.includes('/providers/a/'))).toHaveLength(1)
  expect(calls.filter((u) => u.includes('/providers/b/'))).toHaveLength(1)
})
