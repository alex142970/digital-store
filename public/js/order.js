import { ApiError, getOrder, payOrder } from './api.js'
import { describe, formatPrice } from './format.js'

/** @typedef {import('./api.js').Order} Order */

/** @type {Record<string, string>} */
const STATUS_LABELS = {
  created: 'Ожидает оплаты',
  paid: 'Оплачен, готовим ключ',
  delivering: 'Выдаём ключ',
  delivered: 'Ключ выдан',
  payment_failed: 'Оплата не прошла',
  out_of_stock: 'Ключей временно нет',
  delivery_failed: 'Выдача не удалась'
}

/** @type {Record<string, string>} */
const BADGE_STATE = {
  delivered: 'delivered',
  payment_failed: 'failed',
  delivery_failed: 'failed',
  out_of_stock: 'failed'
}

const IN_PROGRESS = ['paid', 'delivering']
const POLL_MS = 2000

const root = document.querySelector('[data-order]')
const orderId = new URLSearchParams(window.location.search).get('id')

if (!root) {
  throw new Error('order container is missing')
}

const container = root

const liveRegion = document.createElement('p')
liveRegion.className = 'visually-hidden'
liveRegion.setAttribute('aria-live', 'polite')
liveRegion.setAttribute('aria-atomic', 'true')
container.after(liveRegion)

let lastAnnounced = ''

/** @param {Order} order */
function announce(order) {
  const label = STATUS_LABELS[order.status] ?? order.status
  const text = order.code ? `${label}. Ключ: ${order.code}` : label

  if (text === lastAnnounced) return
  lastAnnounced = text
  liveRegion.textContent = text
}

/**
 * @param {string} label
 * @param {string} value
 */
function renderRow(label, value) {
  const row = document.createElement('div')
  row.className = 'status__row'

  const key = document.createElement('dt')
  key.textContent = label

  const cell = document.createElement('dd')
  cell.textContent = value

  row.append(key, cell)
  return row
}

/**
 * @param {string} text
 * @param {string} className
 * @param {() => void} onClick
 */
function renderButton(text, className, onClick) {
  const button = document.createElement('button')
  button.className = className
  button.type = 'button'
  button.textContent = text
  button.addEventListener('click', onClick)
  return button
}

/** @param {Order} order */
function render(order) {
  container.replaceChildren()

  const badge = document.createElement('span')
  badge.className = 'status__badge'
  badge.textContent = STATUS_LABELS[order.status] ?? order.status
  if (BADGE_STATE[order.status]) badge.dataset.state = BADGE_STATE[order.status]

  const list = document.createElement('dl')
  list.className = 'status__rows'
  list.append(renderRow('Заказ', order.id), renderRow('Товар', order.sku))

  if (order.discount > 0) {
    list.append(renderRow('Скидка', formatPrice(order.discount, order.currency)))
  }

  list.append(renderRow('Сумма', formatPrice(order.total, order.currency)))

  if (order.failureReason) {
    list.append(renderRow('Причина', order.failureReason))
  }

  container.append(badge, list)

  if (order.code) {
    const key = document.createElement('code')
    key.className = 'status__key'
    key.textContent = order.code
    container.append(key)
  }

  const actions = document.createElement('div')
  actions.className = 'status__actions'

  if (order.status === 'created') {
    const success = renderButton('Оплатить', 'button', () => pay('success', actions))
    const fail = renderButton('Оплата не прошла', 'button', () => pay('fail', actions))
    actions.append(success, fail)
  }

  if (IN_PROGRESS.includes(order.status)) {
    const hint = document.createElement('p')
    hint.className = 'status__hint'
    hint.textContent = 'Ждём ключ, страница обновится сама'
    container.append(hint)
  }

  if (order.status === 'out_of_stock' || order.status === 'delivery_failed') {
    actions.append(renderButton('Проверить ещё раз', 'button', () => load()))
  }

  actions.append(
    renderButton('Вернуться в каталог', 'button button--ghost', () => {
      window.location.href = '/'
    })
  )

  container.append(actions)
}

/**
 * @param {'success' | 'fail'} outcome
 * @param {HTMLElement} actions
 */
async function pay(outcome, actions) {
  const buttons = [...actions.querySelectorAll('button')]
  buttons.forEach((button) => {
    button.disabled = true
  })

  const primary = buttons[0]
  const primaryLabel = primary?.textContent
  if (primary) primary.textContent = 'Проводим оплату…'

  try {
    await payOrder(String(orderId), outcome)
    await load()
  } catch (error) {
    buttons.forEach((button) => {
      button.disabled = false
    })
    if (primary && primaryLabel) primary.textContent = primaryLabel
    renderError(`Оплата не удалась: ${describe(error)}`)

    await load().catch(() => {})
  }
}

/** @param {string} text */
function renderError(text) {
  const existing = container.querySelector('[data-error]')

  if (existing) {
    existing.textContent = text
    return
  }

  const message = document.createElement('p')
  message.className = 'status__hint'
  message.dataset.error = ''
  message.setAttribute('role', 'status')
  message.textContent = text
  container.append(message)
}

let pollTimer = 0
let loading = false
let inProgress = false
let hasRenderedOnce = false

function schedulePoll() {
  window.clearTimeout(pollTimer)
  if (document.hidden) return
  pollTimer = window.setTimeout(load, POLL_MS)
}

async function load() {
  if (loading) return
  loading = true
  window.clearTimeout(pollTimer)

  try {
    const order = await getOrder(String(orderId))
    render(order)
    announce(order)
    hasRenderedOnce = true
    inProgress = IN_PROGRESS.includes(order.status)

    if (inProgress) schedulePoll()
  } catch (error) {
    if (hasRenderedOnce) {
      renderError(`Не удалось обновить статус: ${describe(error)}`)
      if (inProgress) schedulePoll()
      return
    }

    container.replaceChildren()

    const message = document.createElement('p')
    message.textContent =
      error instanceof ApiError && error.status === 404
        ? 'Заказ не найден. Проверьте ссылку.'
        : `Не удалось загрузить заказ: ${describe(error)}`

    const retry = renderButton('Повторить', 'button', () => load())
    container.append(message, retry)
  } finally {
    loading = false
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    window.clearTimeout(pollTimer)
  } else if (inProgress) {
    load()
  }
})

window.addEventListener('pagehide', () => window.clearTimeout(pollTimer))

if (!orderId) {
  container.replaceChildren()
  container.append(
    Object.assign(document.createElement('p'), { textContent: 'Не указан номер заказа' })
  )
} else {
  load()
}
