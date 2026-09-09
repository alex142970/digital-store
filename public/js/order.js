import { ApiError, cancelOrder, getOrder, payOrder } from './api.js'
import { startCountdown } from './countdown.js'
import { describe, formatPrice } from './format.js'
import { initLive, onCatalogChange } from './live.js'

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
const FAILURE_LABELS = {
  reservation_expired: 'Бронь истекла',
  cancelled_by_customer: 'Бронь снята'
}

/** @type {Record<string, string>} */
const FAILURE_HINTS = {
  reservation_expired: 'Оплата не пришла вовремя, товар вернулся в продажу.',
  cancelled_by_customer: 'Вы сняли бронь, товар вернулся в продажу.'
}

const IN_PROGRESS = ['paid', 'delivering']
const RELEASED = ['reservation_expired', 'cancelled_by_customer']
const POLL_MS = 2000
const POLL_MAX_MS = 15000
const EXPIRY_POLL_MS = 1000
const EXPIRY_POLL_MAX_MS = 8000
const ACTION_RECHECK_MS = 6000

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

const errorBox = document.createElement('p')
errorBox.className = 'status__error'
errorBox.dataset.error = ''
errorBox.setAttribute('role', 'status')
errorBox.hidden = true
container.after(errorBox)

let lastAnnounced = ''

/** @param {Order} order */
function labelFor(order) {
  const failure = order.failureCode ? FAILURE_LABELS[order.failureCode] : undefined

  return failure ?? STATUS_LABELS[order.status] ?? order.status
}

/** @param {Order} order */
function announce(order) {
  const label = labelFor(order)
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
function renderPriceNotice(order) {
  const risen = order.currentPrice > order.amount
  const notice = document.createElement('p')
  notice.className = 'status__notice'
  notice.dataset.priceNotice = risen ? 'up' : 'down'

  const was = formatPrice(order.amount, order.currency)
  const now = formatPrice(order.currentPrice, order.currency)
  const pay = formatPrice(order.total, order.currency)

  notice.textContent = risen
    ? `Товар подорожал: ${was} → ${now}. Бронь держит старую цену, к оплате ${pay}.`
    : `Товар подешевел: ${was} → ${now}. Ваш заказ остаётся по цене брони, к оплате ${pay}.`

  return notice
}

/** @param {number} remainingMs */
function renderCountdown(remainingMs) {
  const box = document.createElement('div')
  box.className = 'status__timer'
  box.dataset.countdown = ''

  const caption = document.createElement('span')
  caption.className = 'status__timer-caption'
  caption.textContent = 'Бронь действует'

  const value = document.createElement('strong')
  value.className = 'status__timer-value'
  value.dataset.countdownValue = ''

  const hint = document.createElement('span')
  hint.className = 'status__timer-hint'
  hint.textContent = 'После отсчёта товар вернётся в продажу'

  box.append(caption, value, hint)

  stopCountdown = startCountdown({
    box,
    value,
    remainingMs,
    onExpire: () => {
      caption.textContent = 'Бронь истекает'
      hint.textContent = 'Проверяем статус на сервере…'
      watchExpiry()
    }
  })

  return box
}
/**
 * @param {Order} order
 * @param {number} [elapsedMs]
 */
function render(order, elapsedMs = 0) {
  stopCountdown()
  currentSku = order.sku
  renderedBusy = busy

  const focused = document.activeElement
  const restore =
    focused instanceof HTMLElement && container.contains(focused) ? focused.textContent : null

  container.replaceChildren()

  const remaining =
    order.expiresInMs === null || order.expiresInMs === undefined
      ? null
      : Math.max(0, order.expiresInMs - elapsedMs)

  const badge = document.createElement('span')
  badge.className = 'status__badge'
  badge.dataset.status = order.status

  badge.textContent = labelFor(order)

  if (order.status === 'delivered') badge.dataset.state = 'delivered'
  else if (order.status !== 'created' && !IN_PROGRESS.includes(order.status)) {
    badge.dataset.state = 'failed'
  }

  container.append(badge)

  if (order.status === 'created' && order.priceChanged) {
    container.append(renderPriceNotice(order))
  }

  if (remaining !== null) {
    container.append(renderCountdown(remaining))
  } else {
    stopCountdown = () => {}
  }

  const list = document.createElement('dl')
  list.className = 'status__rows'
  list.append(renderRow('Заказ', order.id), renderRow('Товар', order.sku))

  if (order.discount > 0) {
    list.append(renderRow('Скидка', formatPrice(order.discount, order.currency)))
  }

  list.append(renderRow('Сумма', formatPrice(order.total, order.currency)))

  const reason = order.failureCode ? FAILURE_HINTS[order.failureCode] : undefined

  if (reason) list.append(renderRow('Причина', reason))
  else if (order.failureReason) list.append(renderRow('Причина', order.failureReason))

  container.append(list)

  if (order.code) {
    const key = document.createElement('code')
    key.className = 'status__key'
    key.textContent = order.code
    container.append(key)
  }

  const actions = document.createElement('div')
  actions.className = 'status__actions'

  if (order.status === 'created') {
    const lapsed = remaining === 0
    const success = renderButton('Оплатить', 'button', () => pay('success', actions, success))
    const failure = renderButton('Оплата не прошла', 'button', () => pay('fail', actions, failure))
    const drop = renderButton('Снять бронь', 'button button--ghost', () => cancel(actions))

    success.dataset.needsReservation = ''
    failure.dataset.needsReservation = ''
    success.disabled = lapsed || busy
    failure.disabled = lapsed || busy
    drop.disabled = busy

    actions.append(success, failure, drop)
  }

  if (IN_PROGRESS.includes(order.status)) {
    const waiting = document.createElement('p')
    waiting.className = 'status__hint'
    waiting.textContent = 'Ждём ключ, страница обновится сама'
    container.append(waiting)
  }

  if (order.status === 'out_of_stock' || order.status === 'delivery_failed') {
    actions.append(renderButton('Проверить ещё раз', 'button', () => load()))
  }

  if (order.failureCode && RELEASED.includes(order.failureCode)) {
    const back = document.createElement('a')
    back.className = 'button'
    back.href = `/?product=${encodeURIComponent(order.sku)}`
    back.dataset.backToProduct = order.sku
    back.textContent = 'Вернуться к товару'
    actions.append(back)
  }

  actions.append(
    renderButton('Вернуться в каталог', 'button button--ghost', () => {
      window.location.href = '/'
    })
  )

  container.append(actions)

  const lost =
    !(document.activeElement instanceof HTMLElement) || document.activeElement === document.body

  if (restore && lost) {
    const same = [...actions.querySelectorAll('button, a')].find(
      (node) =>
        node.textContent === restore && !(node instanceof HTMLButtonElement && node.disabled)
    )

    if (same instanceof HTMLElement) same.focus({ preventScroll: true })
  }
}

/** @param {HTMLElement} actions */
function lock(actions) {
  const buttons = [...actions.querySelectorAll('button')].filter((button) => !button.disabled)

  buttons.forEach((button) => {
    button.disabled = true
  })

  return buttons
}

/**
 *
 * @param {HTMLElement} actions
 * @param {HTMLButtonElement[]} buttons
 */
function unlock(actions, buttons) {
  if (!actions.isConnected) {
    if (renderedBusy) void load()
    return
  }

  const lapsed = countdownLapsed()

  buttons.forEach((button) => {
    if (lapsed && button.dataset.needsReservation !== undefined) return
    button.disabled = false
  })
}
/**
 * @param {'success' | 'fail'} outcome
 * @param {HTMLElement} actions
 * @param {HTMLButtonElement} pressed
 */
async function pay(outcome, actions, pressed) {
  if (busy) return

  busy = true
  dropError()

  const buttons = lock(actions)
  const label = pressed.textContent
  pressed.textContent = 'Проводим оплату…'

  try {
    await payOrder(String(orderId), outcome)

    revision += 1
    busy = false

    recheckUntil = Date.now() + ACTION_RECHECK_MS
    await load()
  } catch (error) {
    busy = false

    keepError(`Оплата не удалась: ${describe(error)}`)
    await load().catch(() => {})
    unlock(actions, buttons)

    if (pressed.isConnected) pressed.textContent = label
  }
}

/** @param {HTMLElement} actions */
async function cancel(actions) {
  if (busy) return

  busy = true
  dropError()

  const buttons = lock(actions)

  try {
    const cancelled = await cancelOrder(String(orderId))

    revision += 1
    busy = false
    stopExpiryWatch()
    dropError()

    recheckUntil = 0
    paymentPending = false
    inProgress = false
    window.clearTimeout(pollTimer)

    render(cancelled)
    announce(cancelled)
  } catch (error) {
    busy = false

    if (error instanceof ApiError && error.status === 409) {
      if (error.code === 'payment_in_progress') {
        paymentPending = true
        keepError('Оплата этого заказа уже обрабатывается, снять бронь нельзя.')
      } else {
        recheckUntil = Date.now() + ACTION_RECHECK_MS
      }

      await load().catch(() => {})
      unlock(actions, buttons)
      return
    }

    keepError(`Не удалось снять бронь: ${describe(error)}`)
    await load().catch(() => {})
    unlock(actions, buttons)
  }
}

/** @param {string} text */
function renderError(text) {
  if (!errorBox.hidden && errorBox.textContent === text) return

  errorBox.hidden = false
  errorBox.textContent = text
}

function clearError() {
  errorBox.hidden = true
  errorBox.textContent = ''
}

/** @param {string} text */
function keepError(text) {
  actionError = text

  recheckUntil = Date.now() + ACTION_RECHECK_MS
}

function dropError() {
  actionError = ''
  recheckUntil = 0
  pollDelay = awaitingExpiry ? EXPIRY_POLL_MS : POLL_MS
  clearError()
}

let revision = 0
let pollTimer = 0
let pollDelay = POLL_MS
let loading = false
let queued = false
let inProgress = false
let awaitingExpiry = false
let busy = false
let renderedBusy = false
let paymentPending = false
let actionError = ''
let recheckUntil = 0
let hasRenderedOnce = false
let currentSku = ''
let stopCountdown = () => {}

/** @returns {HTMLElement | null} */
const countdownBox = () => container.querySelector('[data-countdown]')

const countdownLapsed = () => countdownBox()?.dataset.state === 'expired'

const watching = () => inProgress || paymentPending || awaitingExpiry || Date.now() < recheckUntil

const recoverable = () =>
  watching() || (countdownBox() !== null && !countdownLapsed()) || (renderedBusy && !busy)

function schedulePoll() {
  window.clearTimeout(pollTimer)
  if (document.hidden) return
  pollTimer = window.setTimeout(load, pollDelay)
}

function slower() {
  pollDelay = Math.min(pollDelay * 2, awaitingExpiry ? EXPIRY_POLL_MAX_MS : POLL_MAX_MS)
}

function watchExpiry() {
  if (awaitingExpiry) return

  awaitingExpiry = true
  pollDelay = EXPIRY_POLL_MS
  schedulePoll()
}

function stopExpiryWatch() {
  if (!awaitingExpiry) return

  awaitingExpiry = false
  pollDelay = POLL_MS
}

async function load() {
  if (loading) {
    queued = true
    return
  }

  loading = true
  window.clearTimeout(pollTimer)

  const mine = ++revision
  const startedAt = performance.now()

  try {
    const order = await getOrder(String(orderId))

    if (mine !== revision) return

    if (order.status !== 'created' || (order.expiresInMs ?? 0) > 0) stopExpiryWatch()

    if (order.status !== 'created') {
      actionError = ''
      recheckUntil = 0
      paymentPending = false
    }

    if (actionError) renderError(actionError)
    else clearError()

    render(order, performance.now() - startedAt)
    announce(order)
    hasRenderedOnce = true
    inProgress = IN_PROGRESS.includes(order.status)

    if (watching()) {
      if (awaitingExpiry) {
        schedulePoll()
        slower()
      } else {
        pollDelay = POLL_MS
        schedulePoll()
      }
    }
  } catch (error) {
    if (mine !== revision) return

    if (hasRenderedOnce) {
      renderError(
        actionError
          ? `${actionError.replace(/\s*([^\s.!?…:;,])\s*$/, '$1.')} Статус тоже не читается.`
          : `Не удалось обновить статус: ${describe(error)}`
      )

      if (recoverable()) {
        schedulePoll()
        slower()
      }

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

    if (queued) {
      queued = false
      void load()
    }
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) window.clearTimeout(pollTimer)
  else if (recoverable()) void load()
})

window.addEventListener('pagehide', () => {
  window.clearTimeout(pollTimer)
})

window.addEventListener('pageshow', (event) => {
  if (!event.persisted || !orderId) return

  recheckUntil = Date.now() + ACTION_RECHECK_MS
  pollDelay = awaitingExpiry ? EXPIRY_POLL_MS : POLL_MS
  void load()
})

try {
  initLive()
} catch (error) {
  console.warn('live updates unavailable, falling back to polling', error)
}

if (!orderId) {
  container.replaceChildren()
  container.append(
    Object.assign(document.createElement('p'), { textContent: 'Не указан номер заказа' })
  )
} else {
  onCatalogChange((sku) => {
    if (sku !== null && sku !== currentSku) return
    if (sku === null && loading) return
    void load()
  })

  void load()
}
