/**
 * @typedef {{ sku: string, name: string, type: string, price: number, currency: string, image: string | null, oldPrice?: number | null, available?: number }} Product
 * @typedef {{ id: string, sku: string, amount: number, discount: number, total: number, currency: string, status: string, code: string | null, failureReason: string | null, createdAt?: string, updatedAt?: string, promoCode?: string | null }} Order
 */

const TIMEOUT_MS = 15000

/** @type {Record<number, string>} */
const STATUS_MESSAGES = {
  400: 'Запрос отклонён',
  404: 'Не найдено',
  409: 'Действие сейчас недоступно',
  429: 'Слишком много запросов, попробуйте позже',
  500: 'Сервис временно недоступен',
  503: 'Сервис временно недоступен'
}

export class ApiError extends Error {
  status
  code
  body

  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [body]
   */
  constructor(status, code, message, body) {
    super(message)
    this.status = status
    this.code = code
    this.body = body ?? {}
  }
}

/**
 * @param {string} path
 * @param {RequestInit} [options]
 * @returns {Promise<any>}
 */
const request = async (path, options = {}) => {
  let response

  try {
    response = await fetch(path, {
      ...options,
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers
      },
      signal: options.signal ?? AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError'
    throw new ApiError(
      0,
      'network',
      timedOut ? 'Сервис не ответил вовремя' : 'Нет связи с сервисом'
    )
  }

  const body = await response.json().catch(() => null)

  if (!response.ok) {
    const code = body && typeof body.error === 'string' ? body.error : 'unknown'
    const detail = body && typeof body.message === 'string' ? body.message : ''
    const fallback = STATUS_MESSAGES[response.status] ?? 'Ошибка запроса'
    throw new ApiError(response.status, code, detail || fallback, body ?? {})
  }

  if (body === null) {
    throw new ApiError(response.status, 'malformed', 'Сервис вернул неожиданный ответ')
  }

  return body
}

/** @returns {Promise<{ products: Product[] }>} */
export const listProducts = () => request('/api/products')

/**
 * @param {string} sku
 * @param {string} idempotencyKey
 * @param {string} [promoCode]
 * @returns {Promise<Order>}
 */
export const createOrder = (sku, idempotencyKey, promoCode) =>
  request('/api/orders', {
    method: 'POST',
    body: JSON.stringify(promoCode ? { sku, idempotencyKey, promoCode } : { sku, idempotencyKey })
  })

/**
 * @param {string} orderId
 * @param {'success' | 'fail'} outcome
 * @returns {Promise<{ eventId: string }>}
 */
export const payOrder = (orderId, outcome) =>
  request(`/api/orders/${encodeURIComponent(orderId)}/pay`, {
    method: 'POST',
    body: JSON.stringify({ outcome })
  })

/**
 * @param {string} orderId
 * @returns {Promise<Order>}
 */
export const getOrder = (orderId) => request(`/api/orders/${encodeURIComponent(orderId)}`)

/** @returns {Promise<{ promocodes: { code: string, type: string, value: number, currency: string | null, maxUses: number, usedCount: number, remaining: number }[] }>} */
export const listPromocodes = () => request('/api/admin/promocodes')

/**
 * @param {'stuck' | 'all'} state
 * @returns {Promise<{ orders: Order[] }>}
 */
export const listAdminOrders = (state) =>
  request(`/api/admin/orders?state=${encodeURIComponent(state)}`)

/**
 * @param {string} orderId
 * @returns {Promise<Order>}
 */
export const retryAdminOrder = (orderId) =>
  request(`/api/admin/orders/${encodeURIComponent(orderId)}/retry`, { method: 'POST' })

/**
 * @param {string} sku
 * @param {string[]} keys
 * @returns {Promise<{ sku: string, added: number, available: number }>}
 */
export const restockKeys = (sku, keys) =>
  request('/api/admin/keys', {
    method: 'POST',
    body: JSON.stringify({ sku, keys })
  })

/**
 * @param {string} sku
 * @param {{ price?: number, oldPrice?: number | null }} patch
 * @returns {Promise<Product>}
 */
export const updateProduct = (sku, patch) =>
  request(`/api/admin/products/${encodeURIComponent(sku)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  })

/**
 * @param {string} sku
 * @param {number} count
 * @returns {Promise<{ sku: string, removed: number, requested: number, available: number }>}
 */
export const removeKeys = (sku, count) =>
  request('/api/admin/keys', {
    method: 'DELETE',
    body: JSON.stringify({ sku, count })
  })
