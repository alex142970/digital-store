import { ApiError, createOrder, listProducts } from './api.js'
import { describe, formatPrice } from './format.js'
import { forgetPromoCode, getPromoCode } from './promo.js'

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

  if (product.oldPrice) {
    const oldPrice = document.createElement('span')
    oldPrice.className = 'card__old-price'
    oldPrice.textContent = formatPrice(product.oldPrice, product.currency)
    prices.append(oldPrice)
  }

  const buy = document.createElement('button')
  buy.className = 'button card__buy'
  buy.type = 'button'
  buy.textContent = 'Купить'
  buy.dataset.buy = product.sku
  buy.setAttribute('aria-label', `Купить: ${product.name}`)

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
  button.disabled = false
  button.textContent = 'Купить'
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

  button.disabled = true
  button.textContent = 'Создаём заказ…'

  try {
    const order = await createOrder(sku, idempotencyKeyFor(sku), getPromoCode())
    forgetIdempotencyKey(sku)
    window.location.href = `/order.html?id=${encodeURIComponent(order.id)}`
  } catch (failure) {
    resetBuyButton(button)

    if (error instanceof HTMLElement) {
      error.textContent = describePromoFailure(failure) ?? describe(failure)
      error.hidden = false
    }
  }
}

export async function initProducts() {
  const roots = ROWS.map((name) => document.querySelector(`[data-products="${name}"]`)).filter(
    (root) => root !== null
  )

  if (roots.length === 0) return

  roots.forEach((root) => root.addEventListener('click', onBuyClick))

  window.addEventListener('pageshow', () => {
    document.querySelectorAll('[data-buy]').forEach((button) => {
      if (button instanceof HTMLButtonElement && button.disabled) resetBuyButton(button)
    })
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

  try {
    const { products } = await listProducts()

    if (!Array.isArray(products) || products.length === 0) {
      roots.forEach((root) => renderMessage(root, 'Каталог пока пуст', () => load(roots)))
      return
    }

    fillRows(roots, products)
  } catch (error) {
    const message = `Не удалось загрузить каталог: ${describe(error)}`
    roots.forEach((root) => renderMessage(root, message, () => load(roots)))
  } finally {
    loading = false
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
