import { ApiError, createOrder, searchCatalog } from './api.js'
import { describe, formatPrice } from './format.js'
import { onCatalogChange, initLive } from './live.js'
import { getPromoCode } from './promo.js'

const PAGE_SIZE = 24
const DEBOUNCE_MS = 200
const EVENT_DEBOUNCE_MS = 400
const MIN_TERM = 3
const MAX_TERM = 100

const TYPES = ['', 'key', 'subscription', 'topup', 'giftcard']
const SORTS = ['relevance', 'price', 'priceDesc']

const form = document.querySelector('[data-filters]')
const list = document.querySelector('[data-results]')
const summary = document.querySelector('[data-summary]')
const empty = document.querySelector('[data-empty]')
const more = document.querySelector('[data-more]')
const fieldQ = document.querySelector('[data-filter-q]')
const fieldType = document.querySelector('[data-filter-type]')
const fieldMin = document.querySelector('[data-filter-min]')
const fieldMax = document.querySelector('[data-filter-max]')
const fieldSort = document.querySelector('[data-filter-sort]')
const fieldStock = document.querySelector('[data-filter-stock]')

if (
  !(form instanceof HTMLFormElement) ||
  !(list instanceof HTMLElement) ||
  !(summary instanceof HTMLElement) ||
  !(empty instanceof HTMLElement) ||
  !(more instanceof HTMLButtonElement) ||
  !(fieldQ instanceof HTMLInputElement) ||
  !(fieldType instanceof HTMLSelectElement) ||
  !(fieldMin instanceof HTMLInputElement) ||
  !(fieldMax instanceof HTMLInputElement) ||
  !(fieldSort instanceof HTMLSelectElement) ||
  !(fieldStock instanceof HTMLInputElement)
) {
  throw new Error('search page markup is incomplete')
}

const results = list
const summaryBox = summary
const emptyBox = empty
const moreButton = more
const q = fieldQ
const type = fieldType
const min = fieldMin
const max = fieldMax
const sort = fieldSort
const stock = fieldStock

/** @typedef {{ q: string, type: string, min: string, max: string, sort: string, stock: boolean }} Query */

/**
 * @param {string | null} value
 * @param {string[]} allowed
 * @param {string} fallback
 */
const oneOf = (value, allowed, fallback) =>
  allowed.includes(value ?? '') ? (value ?? '') : fallback

/** @param {string | null} value */
const positive = (value) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? String(parsed) : ''
}

/** @returns {Query} */
function queryFromUrl() {
  const params = new URLSearchParams(window.location.search)
  const flag = params.get('stock')

  return {
    q: (params.get('q') ?? '').slice(0, MAX_TERM),
    type: oneOf(params.get('type'), TYPES, ''),
    min: positive(params.get('min')),
    max: positive(params.get('max')),
    sort: oneOf(params.get('sort'), SORTS, 'relevance'),
    stock: flag === '1' || flag === 'true'
  }
}

/** @returns {Query} */
function queryFromForm() {
  return {
    q: q.value.trim().slice(0, MAX_TERM),
    type: oneOf(type.value, TYPES, ''),
    min: positive(min.value),
    max: positive(max.value),
    sort: oneOf(sort.value, SORTS, 'relevance'),
    stock: stock.checked
  }
}

/** @param {Query} query */
function fillForm(query) {
  q.value = query.q
  type.value = query.type
  min.value = query.min
  max.value = query.max
  sort.value = query.sort
  stock.checked = query.stock
}

/** @param {Query} query */
function toSearchParams(query) {
  const params = new URLSearchParams()

  if (query.q) params.set('q', query.q)
  if (query.type) params.set('type', query.type)
  if (query.min) params.set('min', query.min)
  if (query.max) params.set('max', query.max)
  if (query.sort !== 'relevance') params.set('sort', query.sort)
  if (query.stock) params.set('stock', '1')

  return params
}

/**
 * @param {Query} query
 * @param {number} from
 * @param {number} size
 */
function toRequest(query, from, size) {
  /** @type {Record<string, string>} */
  const request = { limit: String(Math.min(size, 60)), offset: String(from) }

  if (query.q) request.q = query.q
  if (query.type) request.type = query.type
  if (query.min) request.min = query.min
  if (query.max) request.max = query.max
  if (query.sort) request.sort = query.sort
  if (query.stock) request.stock = 'true'

  return request
}

/** @param {number} value */
function plural(value) {
  const tail = value % 100
  if (tail >= 11 && tail <= 14) return 'позиций'

  switch (value % 10) {
    case 1:
      return 'позиция'
    case 2:
    case 3:
    case 4:
      return 'позиции'
    default:
      return 'позиций'
  }
}

/** @param {import('./api.js').Product} product */
function buildCard(product) {
  const item = document.createElement('li')
  item.dataset.item = product.sku

  const card = document.createElement('article')
  card.className = 'card card--compact'

  const name = document.createElement('h3')
  name.className = 'card__name'

  const price = document.createElement('span')
  price.className = 'card__price'

  const stockLine = document.createElement('span')
  stockLine.className = 'card__stock'

  const buy = document.createElement('button')
  buy.className = 'button card__buy'
  buy.type = 'button'
  buy.dataset.buy = product.sku

  const error = document.createElement('p')
  error.className = 'card__error'
  error.setAttribute('role', 'status')
  error.hidden = true

  card.append(name, price, stockLine, buy, error)
  item.append(card)

  fillCard(item, product)
  return item
}

/**
 * @param {HTMLElement} item
 * @param {import('./api.js').Product} product
 */
function fillCard(item, product) {
  const name = item.querySelector('.card__name')
  const price = item.querySelector('.card__price')
  const stockLine = item.querySelector('.card__stock')
  const buy = item.querySelector('.card__buy')

  if (name) name.textContent = product.name
  if (price) price.textContent = formatPrice(product.price, product.currency)

  const available = typeof product.available === 'number' ? product.available : 0

  if (stockLine instanceof HTMLElement) {
    stockLine.textContent = available > 0 ? `в наличии: ${available}` : 'раскуплено'
    stockLine.dataset.state = available > 0 ? 'in' : 'out'
  }

  if (buy instanceof HTMLButtonElement && buy.dataset.pending === undefined) {
    buy.disabled = available <= 0
    buy.textContent = available > 0 ? 'Купить' : 'Раскуплено'
    buy.setAttribute('aria-label', `Купить: ${product.name}`)
  }
}

/**
 * @param {import('./api.js').Product[]} products
 * @param {boolean} append
 */
function renderList(products, append) {
  const focused = document.activeElement
  const restore =
    focused instanceof HTMLElement && results.contains(focused)
      ? focused.closest('li')?.dataset.item
      : undefined

  /** @type {Map<string, HTMLElement>} */
  const known = new Map()

  for (const node of [...results.children]) {
    if (!(node instanceof HTMLElement)) continue

    const key = node.dataset.item ?? ''

    if (known.has(key)) node.remove()
    else known.set(key, node)
  }

  if (append) {
    products.forEach((product) => {
      if (!known.has(product.sku)) results.append(buildCard(product))
    })
    return
  }

  let cursor = results.firstElementChild

  for (const product of products) {
    const existing = known.get(product.sku)
    let node

    if (existing) {
      known.delete(product.sku)
      fillCard(existing, product)
      node = existing
    } else {
      node = buildCard(product)
    }

    if (node === cursor) {
      cursor = cursor.nextElementSibling
    } else {
      results.insertBefore(node, cursor)
    }
  }

  known.forEach((node) => node.remove())

  if (restore && document.activeElement === document.body) {
    const back = results.querySelector(`[data-item="${CSS.escape(restore)}"] .card__buy`)
    if (back instanceof HTMLElement) back.focus({ preventScroll: true })
  }
}

let seq = 0
let shown = -1
let offset = 0
let total = 0
let debounce = 0
let eventTimer = 0
let current = queryFromUrl()
/** @type {AbortController | null} */
let inflight = null

/**
 * @param {Query} query
 * @param {boolean} append
 * @param {number} [size]
 */
async function run(query, append, size = PAGE_SIZE) {
  if (query.q.length > 0 && query.q.length < MIN_TERM) {
    renderList([], false)
    total = 0
    offset = 0
    summaryBox.textContent = ''
    emptyBox.hidden = false
    emptyBox.textContent = `Введите хотя бы ${MIN_TERM} символа`
    moreButton.hidden = true
    return
  }

  const mine = ++seq
  const controller = new AbortController()

  inflight?.abort()
  inflight = controller

  const from = append ? offset : 0

  try {
    const page = await searchCatalog(toRequest(query, from, size), controller.signal)

    if (mine < shown) return

    shown = mine
    total = page.total
    offset = from + page.items.length

    renderList(page.items, append)

    summaryBox.textContent = total > 0 ? `${total} ${plural(total)}` : ''
    emptyBox.hidden = total > 0
    emptyBox.textContent = query.q
      ? `По запросу «${query.q}» ничего не нашлось`
      : 'Под выбранные фильтры ничего не подходит'
    moreButton.hidden = offset >= total
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return

    moreButton.hidden = true
    summaryBox.textContent = `Не удалось загрузить: ${describe(error)}`
  } finally {
    if (inflight === controller) inflight = null
  }
}

const refresh = () => run(current, false, Math.max(offset, PAGE_SIZE))

/** @param {boolean} replace */
function apply(replace) {
  const query = queryFromForm()
  const params = toSearchParams(query)
  const url = params.size > 0 ? `?${params}` : window.location.pathname

  if (replace) window.history.replaceState(null, '', url)
  else window.history.pushState(null, '', url)

  current = query
  void run(query, false)
}

;[q, min, max].forEach((field) => {
  field.addEventListener('input', () => {
    window.clearTimeout(debounce)
    debounce = window.setTimeout(() => apply(true), DEBOUNCE_MS)
  })
})

;[type, sort, stock].forEach((field) => {
  field.addEventListener('change', () => {
    window.clearTimeout(debounce)
    apply(false)
  })
})

form.addEventListener('submit', (event) => {
  event.preventDefault()
  window.clearTimeout(debounce)
  apply(false)
})

moreButton.addEventListener('click', () => {
  window.clearTimeout(debounce)

  const typed = queryFromForm()

  if (JSON.stringify(typed) !== JSON.stringify(current)) {
    apply(true)
    return
  }

  void run(current, true)
})

results.addEventListener('click', (event) => {
  const target = event.target
  const button = target instanceof Element ? target.closest('[data-buy]') : null

  if (!(button instanceof HTMLButtonElement) || button.disabled) return

  void buy(button)
})

/** @param {HTMLButtonElement} button */
async function buy(button) {
  const sku = button.dataset.buy
  if (!sku) return

  const item = button.closest('li')
  const error = item?.querySelector('.card__error')

  button.dataset.pending = '1'
  button.disabled = true
  button.textContent = 'Создаём заказ…'

  if (error instanceof HTMLElement) error.hidden = true

  try {
    const key = `search-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const order = await createOrder(sku, key, getPromoCode())

    window.location.href = `/order.html?id=${encodeURIComponent(order.id)}`
  } catch (failure) {
    delete button.dataset.pending
    button.disabled = false
    button.textContent = 'Купить'

    if (error instanceof HTMLElement) {
      error.textContent =
        failure instanceof ApiError && failure.code === 'out_of_stock'
          ? 'Этот товар только что раскупили'
          : `Не удалось оформить: ${describe(failure)}`
      error.hidden = false
    }
  }
}

window.addEventListener('popstate', () => {
  current = queryFromUrl()
  fillForm(current)
  void run(current, false)
})

onCatalogChange(() => {
  window.clearTimeout(eventTimer)
  eventTimer = window.setTimeout(() => void refresh(), EVENT_DEBOUNCE_MS)
})

try {
  initLive()
} catch {
  console.warn('live updates unavailable on the search page')
}

fillForm(current)
void run(current, false)
