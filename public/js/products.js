import { ApiError, createOrder, listProducts } from './api.js'
import { describe, formatPrice } from './format.js'
import { forgetPromoCode, getPromoCode } from './promo.js'
import { onCatalogChange } from './live.js'

/** @type {Record<string, string>} */
const PROMO_MESSAGES = {
  promo_not_found: 'Промокод не найден',
  promo_limit_reached: 'Промокод исчерпан',
  promo_currency_mismatch: 'Промокод не подходит к валюте товара'
}

/** @param {unknown} failure */
const describePromoFailure = (failure) => {
  if (!(failure instanceof ApiError)) return null

  const message = PROMO_MESSAGES[failure.code]
  if (!message) return null

  forgetPromoCode()
  return `${message}. Оформите заказ ещё раз без него.`
}

/** @typedef {import('./api.js').Product} Product */

const ROW_LIMIT = 5
const ROWS = ['popular', 'recommended', 'other']

/** @param {string} sku */
const storageKeyFor = (sku) => `order-key:${sku}`

/** @type {Map<string, string>} */
const memoryKeys = new Map()

const newKey = () => `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/** @param {string} sku */
function idempotencyKeyFor(sku) {
  const storageKey = storageKeyFor(sku)

  try {
    const saved = sessionStorage.getItem(storageKey)
    if (saved) return saved
  } catch {
    const remembered = memoryKeys.get(storageKey) ?? newKey()
    memoryKeys.set(storageKey, remembered)
    return remembered
  }

  const created = newKey()

  try {
    sessionStorage.setItem(storageKey, created)
  } catch {
    memoryKeys.set(storageKey, created)
    return created
  }

  return created
}

/** @param {string} sku */
function forgetIdempotencyKey(sku) {
  memoryKeys.delete(storageKeyFor(sku))

  try {
    sessionStorage.removeItem(storageKeyFor(sku))
  } catch {
    return
  }
}

/** @param {Product} product */
function renderCover(product) {
  const cover = document.createElement('div')
  cover.className = 'card__cover'

  const fallback = () => {
    cover.classList.add('card__cover--fallback')
    cover.textContent = product.name.slice(0, 2).toUpperCase()
  }

  if (!product.image) {
    fallback()
    return cover
  }

  const image = document.createElement('img')
  image.src = `/${product.image.replace(/^\/+/, '')}`
  image.alt = ''
  image.loading = 'lazy'
  image.width = 227
  image.height = 152
  image.addEventListener('error', fallback)
  cover.append(image)

  return cover
}

/** @param {Product} product */
function renderCard(product) {
  const item = document.createElement('li')
  const card = document.createElement('article')
  card.className = 'card'

  const body = document.createElement('div')
  body.className = 'card__body'

  const name = document.createElement('h3')
  name.className = 'card__name'
  name.textContent = product.name

  const prices = document.createElement('div')
  prices.className = 'card__prices'

  const price = document.createElement('span')
  price.className = 'card__price'
  price.textContent = formatPrice(product.price, product.currency)
  prices.append(price)

  const oldPrice = document.createElement('span')
  oldPrice.className = 'card__old-price'

  if (typeof product.oldPrice === 'number') {
    oldPrice.textContent = formatPrice(product.oldPrice, product.currency)
  } else {
    oldPrice.hidden = true
  }

  prices.append(oldPrice)

  card.dataset.card = product.sku

  const available = typeof product.available === 'number' ? product.available : null

  const buy = document.createElement('button')
  buy.className = 'button card__buy'
  buy.type = 'button'
  buy.dataset.buy = product.sku
  buy.setAttribute('aria-label', `Купить: ${product.name}`)
  applyAvailability(buy, available)

  const error = document.createElement('p')
  error.className = 'card__error'
  error.setAttribute('role', 'status')
  error.hidden = true

  body.append(name, prices, buy, error)
  card.append(renderCover(product), body)
  item.append(card)

  return item
}

/**
 * @param {Element} root
 * @param {string} text
 * @param {() => void} [retry]
 */
function renderMessage(root, text, retry) {
  const item = document.createElement('li')
  item.className = 'cards__message'

  const label = document.createElement('span')
  label.setAttribute('role', 'status')
  label.textContent = text
  item.append(label)

  if (retry) {
    const button = document.createElement('button')
    button.className = 'button'
    button.type = 'button'
    button.textContent = 'Повторить'
    button.addEventListener('click', retry)
    item.append(button)
  }

  root.replaceChildren(item)
}

/** @param {HTMLButtonElement} button */
function resetBuyButton(button) {
  const raw = button.dataset.available
  const left = raw === undefined ? null : Number(raw)
  applyAvailability(button, left !== null && Number.isFinite(left) ? left : null)
}

/**
 * @param {HTMLButtonElement} button
 * @param {number | null} available
 */
function applyAvailability(button, available) {
  if (available !== null) button.dataset.available = String(available)

  if (button.dataset.pending === '1') return

  if (button.dataset.retry === '1') {
    button.disabled = false
    button.textContent = 'Повторить'
    return
  }

  const soldOut = available !== null && available <= 0
  button.disabled = soldOut
  button.textContent = soldOut ? 'Раскуплено' : 'Купить'
}

/** @param {Event} event */
function onAlternativeClick(event) {
  const target = event.target
  const chosen = target instanceof Element ? target.closest('[data-alternative]') : null

  if (!(chosen instanceof HTMLElement) || !chosen.dataset.alternative) return

  const card = document.querySelector(`[data-card="${CSS.escape(chosen.dataset.alternative)}"]`)

  if (!(card instanceof HTMLElement)) return

  card.scrollIntoView({ behavior: 'smooth', block: 'center' })
  card.classList.add('card--highlighted')
  window.setTimeout(() => card.classList.remove('card--highlighted'), 1600)

  const buy = card.querySelector('[data-buy]')
  if (buy instanceof HTMLElement) buy.focus({ preventScroll: true })
}

/** @param {Event} event */
async function onBuyClick(event) {
  const target = event.target
  const button = target instanceof Element ? target.closest('[data-buy]') : null

  if (!(button instanceof HTMLButtonElement) || !button.dataset.buy) return

  const sku = button.dataset.buy
  const error = button.parentElement?.querySelector('.card__error')

  if (error instanceof HTMLElement) {
    error.hidden = true
    error.textContent = ''
  }

  button.dataset.pending = '1'
  delete button.dataset.retry
  button.disabled = true
  button.textContent = 'Создаём заказ…'

  try {
    const order = await createOrder(sku, idempotencyKeyFor(sku), getPromoCode())
    delete button.dataset.pending
    forgetIdempotencyKey(sku)
    window.location.href = `/order.html?id=${encodeURIComponent(order.id)}`
  } catch (failure) {
    delete button.dataset.pending

    const unknownOutcome =
      failure instanceof ApiError && (failure.status === 0 || failure.code === 'malformed')

    if (unknownOutcome) button.dataset.retry = '1'

    resetBuyButton(button)

    if (error instanceof HTMLElement) {
      error.replaceChildren(describeCheckoutFailure(failure))
      error.hidden = false
    }

    if (failure instanceof ApiError && failure.code === 'out_of_stock') {
      void refreshFromServer(catalogRoots)
    }
  }
}

/** @param {unknown} failure */
function describeCheckoutFailure(failure) {
  const box = document.createDocumentFragment()
  const text = document.createElement('span')

  text.textContent =
    (failure instanceof ApiError && failure.code === 'out_of_stock'
      ? failure.message
      : describePromoFailure(failure)) ?? describe(failure)

  box.append(text)

  const alternatives =
    failure instanceof ApiError && Array.isArray(failure.body?.alternatives)
      ? failure.body.alternatives
      : []

  if (alternatives.length > 0) {
    const list = document.createElement('span')
    list.className = 'card__alternatives'
    list.append(' Другие предложения: ')

    alternatives.forEach((item, index) => {
      const link = document.createElement('button')
      link.type = 'button'
      link.className = 'card__alternative'
      link.dataset.alternative = item.sku
      link.textContent = `${item.name} — ${formatPrice(item.price, item.currency)}`
      if (index > 0) list.append(', ')
      list.append(link)
    })

    box.append(list)
  }

  return box
}

/** @param {import('./api.js').Product} product */
function refreshCard(product) {
  const card = document.querySelector(`[data-card="${CSS.escape(product.sku)}"]`)

  if (!(card instanceof HTMLElement)) return

  const price = card.querySelector('.card__price')
  const oldPrice = card.querySelector('.card__old-price')
  const buy = card.querySelector('[data-buy]')

  if (price instanceof HTMLElement) price.textContent = formatPrice(product.price, product.currency)

  if (oldPrice instanceof HTMLElement) {
    if (typeof product.oldPrice === 'number') {
      oldPrice.textContent = formatPrice(product.oldPrice, product.currency)
      oldPrice.hidden = false
    } else {
      oldPrice.hidden = true
    }
  }

  if (buy instanceof HTMLButtonElement) {
    applyAvailability(buy, typeof product.available === 'number' ? product.available : null)
  }
}

const REFRESH_DEBOUNCE_MS = 250
const REFRESH_MAX_WAIT_MS = 1000
const REFRESH_RETRY_MS = 800
const REFRESH_RETRY_MAX_MS = 30_000

/** @type {Element[]} */
let catalogRoots = []

let generation = 0
let refreshing = false
let pendingRefresh = false
let ready = false
let failures = 0

const retryDelay = () => Math.min(REFRESH_RETRY_MS * 2 ** failures, REFRESH_RETRY_MAX_MS)

/** @param {Element[]} roots */
async function refreshFromServer(roots) {
  if (!ready || refreshing) {
    pendingRefresh = true
    return
  }

  refreshing = true
  const mine = ++generation

  try {
    const { products } = await listProducts()

    if (mine !== generation) return
    if (!Array.isArray(products) || products.length === 0) return

    const known = new Set(
      [...document.querySelectorAll('[data-card]')].map((card) =>
        card instanceof HTMLElement ? card.dataset.card : null
      )
    )

    if (products.some((product) => !known.has(product.sku))) {
      fillRows(roots, products)
      return
    }

    products.forEach(refreshCard)
    failures = 0
  } catch {
    failures += 1
    pendingRefresh = true
  } finally {
    refreshing = false

    if (pendingRefresh) {
      pendingRefresh = false
      window.setTimeout(() => void refreshFromServer(roots), retryDelay())
    }
  }
}

export async function initProducts() {
  const roots = ROWS.map((name) => document.querySelector(`[data-products="${name}"]`)).filter(
    (root) => root !== null
  )

  if (roots.length === 0) return

  catalogRoots = roots
  roots.forEach((root) => root.addEventListener('click', onBuyClick))
  document.addEventListener('click', onAlternativeClick)
  let refreshTimer = 0
  let firstSignalAt = 0

  onCatalogChange(() => {
    const now = Date.now()

    if (firstSignalAt === 0) firstSignalAt = now

    if (now - firstSignalAt >= REFRESH_MAX_WAIT_MS) {
      window.clearTimeout(refreshTimer)
      firstSignalAt = 0
      void refreshFromServer(roots)
      return
    }

    window.clearTimeout(refreshTimer)
    refreshTimer = window.setTimeout(() => {
      firstSignalAt = 0
      void refreshFromServer(roots)
    }, REFRESH_DEBOUNCE_MS)
  })

  window.addEventListener('pageshow', (event) => {
    document.querySelectorAll('[data-buy]').forEach((button) => {
      if (button instanceof HTMLButtonElement) resetBuyButton(button)
    })

    if (event.persisted) void refreshFromServer(roots)
  })

  await load(roots)
}

let loading = false

/** @param {Element[]} roots */
async function load(roots) {
  if (loading) return
  loading = true

  if (roots.length === 0) {
    loading = false
    return
  }

  roots.forEach((root) => renderMessage(root, 'Загружаем каталог…'))

  const mine = ++generation

  try {
    const { products } = await listProducts()

    if (mine !== generation) return

    if (!Array.isArray(products) || products.length === 0) {
      roots.forEach((root) => renderMessage(root, 'Каталог пока пуст', () => load(roots)))
      return
    }

    fillRows(roots, products)
    failures = 0
  } catch (error) {
    if (mine !== generation) return

    const message = `Не удалось загрузить каталог: ${describe(error)}`
    roots.forEach((root) => renderMessage(root, message, () => load(roots)))
    failures += 1
    pendingRefresh = true
  } finally {
    loading = false
    ready = true

    if (pendingRefresh) {
      pendingRefresh = false
      window.setTimeout(() => void refreshFromServer(roots), retryDelay())
    }
  }
}

/**
 * @param {Product} product
 * @returns {Element | null}
 */
function renderCardSafely(product) {
  try {
    return renderCard(product)
  } catch {
    return null
  }
}

/**
 * @param {Element[]} roots
 * @param {Product[]} products
 */
function fillRows(roots, products) {
  roots.forEach((root, position) => {
    const items = products.slice(position * ROW_LIMIT, (position + 1) * ROW_LIMIT)
    const cards = items.map(renderCardSafely).filter((card) => card !== null)
    root.replaceChildren(...cards)
  })
}
