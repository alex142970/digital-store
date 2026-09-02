import { config } from '../config.ts'
import type { components } from '../types/api.d.ts'

type IssueResponse = components['schemas']['IssueResponse']
type IssueError = components['schemas']['IssueError']

export type Provider = 'a' | 'b'

export type IssueOutcome =
  | { kind: 'issued'; provider: Provider; code: string }
  | { kind: 'out_of_stock'; provider: Provider }
  | { kind: 'refused'; provider: Provider; detail: string }
  | { kind: 'unknown'; provider: Provider; detail: string }

const baseUrl = () => process.env.PROVIDER_BASE_URL ?? `http://127.0.0.1:${config.PORT}`

async function askProvider(
  provider: Provider,
  payload: { request_id: string; sku: string; order_id: string }
): Promise<IssueOutcome> {
  try {
    const response = await fetch(`${baseUrl()}/internal/providers/${provider}/issue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.PROVIDER_TIMEOUT_MS)
    })

    if (response.status === 200) {
      const body = (await response.json()) as IssueResponse
      return { kind: 'issued', provider, code: body.code }
    }

    const body = (await response.json().catch(() => null)) as IssueError | null

    if (body?.reason === 'out_of_stock') {
      return { kind: 'out_of_stock', provider }
    }

    if (body?.reason) {
      return { kind: 'refused', provider, detail: body.reason }
    }

    return { kind: 'unknown', provider, detail: `http ${response.status}` }
  } catch (error) {
    const detail =
      error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : String(error)
    return { kind: 'unknown', provider, detail }
  }
}

async function askWithRetries(
  provider: Provider,
  payload: { request_id: string; sku: string; order_id: string },
  onAttempt: (outcome: IssueOutcome) => Promise<void>
): Promise<IssueOutcome> {
  let last: IssueOutcome = { kind: 'unknown', provider, detail: 'no attempts made' }

  for (let attempt = 0; attempt < config.PROVIDER_MAX_ATTEMPTS; attempt += 1) {
    last = await askProvider(provider, payload)
    await onAttempt(last)

    if (last.kind !== 'unknown') return last
  }

  return last
}

export async function issueCode(
  requestId: string,
  sku: string,
  orderId: string,
  onAttempt: (outcome: IssueOutcome) => Promise<void>
): Promise<IssueOutcome> {
  const payload = { request_id: requestId, sku, order_id: orderId }
  const primary = await askWithRetries('a', payload, onAttempt)

  if (primary.kind !== 'refused') return primary

  return askWithRetries('b', payload, onAttempt)
}
