import {
  ApiError,
  listAdminOrders,
  listProducts,
  listPromocodes,
  removeKeys,
  restockKeys,
  retryAdminOrder,
  updateProduct
} from './api.js'

const RETRYABLE = ['paid', 'delivering', 'out_of_stock', 'delivery_failed']

/** @type {Record<string, string>} */
const STATUS_LABELS = {
  created: 'Создан',
  paid: 'Оплачен',
  delivering: 'Выдаётся',
  delivered: 'Выдан',
  payment_failed: 'Оплата не прошла',
  out_of_stock: 'Нет ключей',
  delivery_failed: 'Ошибка выдачи'
}

const NOTES = {
  stuck: 'Оплаченные заказы без ключа: paid, delivering, out_of_stock, delivery_failed.',
  all: 'Все заказы в системе, включая завершённые.'
}

const catalogBox = document.querySelector('[data-catalog]')
const refreshCatalogButton = document.querySelector('[data-refresh-catalog]')
const ordersBox = document.querySelector('[data-orders]')
const promoBox = document.querySelector('[data-promocodes]')
const messageBox = document.querySelector('[data-message]')
const noteBox = document.querySelector('[data-note]')
const refreshButton = document.querySelector('[data-refresh]')
const restockForm = document.querySelector('[data-restock-form]')
const restockSubmit = document.querySelector('[data-restock-submit]')
const filters = [...document.querySelectorAll('[data-filter]')].filter(
  (el) => el instanceof HTMLButtonElement
)

if (
  catalogBox instanceof HTMLElement &&
  refreshCatalogButton instanceof HTMLButtonElement &&
  ordersBox instanceof HTMLElement &&
  promoBox instanceof HTMLElement &&
  messageBox instanceof HTMLElement &&
  noteBox instanceof HTMLElement &&
  refreshButton instanceof HTMLButtonElement &&
  restockForm instanceof HTMLFormElement &&
  restockSubmit instanceof HTMLButtonElement
) {
  /** @type {'stuck' | 'all'} */
  let state = 'stuck'

  /**
   * @param {string} text
   * @param {'ok' | 'error'} kind
   */
  const showMessage = (text, kind) => {
    messageBox.textContent = text
    messageBox.dataset.kind = kind
    messageBox.hidden = false
  }

  const clearMessage = () => {
    messageBox.hidden = true
    messageBox.textContent = ''
  }

  /** @param {unknown} error */
  const reportError = (error) => {
    showMessage(error instanceof ApiError ? error.message : 'Неизвестная ошибка', 'error')
  }

  /** @param {number} value */
  const money = (value) => `${(value / 1).toLocaleString('ru-RU')} ₽`

  /** @param {string | undefined} value */
  const moment = (value) => (value ? new Date(value).toLocaleString('ru-RU') : '—')

  /** @param {import('./api.js').Order} order */
  const renderRow = (order) => {
    const row = document.createElement('tr')
    row.dataset.orderRow = order.id

    const id = document.createElement('td')
    id.textContent = order.id

    const sku = document.createElement('td')
    sku.textContent = order.sku

    const total = document.createElement('td')
    total.textContent = money(order.total)

    if (order.discount > 0) {
      const promo = document.createElement('span')
      promo.className = 'admin__reason'
      promo.textContent = `скидка ${money(order.discount)}${order.promoCode ? ` (${order.promoCode})` : ''}`
      total.append(promo)
    }

    const status = document.createElement('td')
    const badge = document.createElement('span')
    badge.className = 'admin__status'
    badge.dataset.status = order.status
    badge.textContent = STATUS_LABELS[order.status] ?? order.status
    status.append(badge)

    if (order.failureReason) {
      const reason = document.createElement('span')
      reason.className = 'admin__reason'
      reason.textContent = order.failureReason
      status.append(reason)
    }

    const code = document.createElement('td')
    code.textContent = order.code ?? '—'

    const updated = document.createElement('td')
    updated.textContent = moment(order.updatedAt)

    const actions = document.createElement('td')

    if (RETRYABLE.includes(order.status)) {
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.dataset.retry = order.id
      retry.textContent = 'Выдать повторно'
      retry.addEventListener('click', async () => {
        retry.disabled = true
        retry.textContent = 'Выдаём…'
        clearMessage()

        try {
          const updatedOrder = await retryAdminOrder(order.id)
          const label = STATUS_LABELS[updatedOrder.status] ?? updatedOrder.status
          showMessage(`${updatedOrder.id}: ${label}`, updatedOrder.code ? 'ok' : 'error')
        } catch (error) {
          reportError(error)
        }

        await load()
      })
      actions.append(retry)
    }

    row.append(id, sku, total, status, code, updated, actions)
    return row
  }

  /** @param {import('./api.js').Order[]} orders */
  const renderOrders = (orders) => {
    ordersBox.replaceChildren()

    if (orders.length === 0) {
      const empty = document.createElement('p')
      empty.dataset.empty = ''
      empty.textContent = state === 'stuck' ? 'Незавершённых заказов нет.' : 'Заказов пока нет.'
      ordersBox.append(empty)
      return
    }

    const table = document.createElement('table')
    table.className = 'admin__table'

    const head = document.createElement('thead')
    const headRow = document.createElement('tr')

    for (const title of ['Заказ', 'SKU', 'Сумма', 'Статус', 'Ключ', 'Обновлён', '']) {
      const cell = document.createElement('th')
      cell.textContent = title
      headRow.append(cell)
    }

    head.append(headRow)

    const body = document.createElement('tbody')
    orders.forEach((order) => body.append(renderRow(order)))

    table.append(head, body)
    ordersBox.append(table)
  }

  const loadPromocodes = async () => {
    try {
      const { promocodes } = await listPromocodes()
      promoBox.replaceChildren()

      const table = document.createElement('table')
      table.className = 'admin__table'

      const head = document.createElement('thead')
      const headRow = document.createElement('tr')

      for (const title of ['Код', 'Скидка', 'Лимит', 'Использован', 'Осталось']) {
        const cell = document.createElement('th')
        cell.textContent = title
        headRow.append(cell)
      }

      head.append(headRow)

      const body = document.createElement('tbody')

      for (const promo of promocodes) {
        const row = document.createElement('tr')
        row.dataset.promoRow = promo.code

        const code = document.createElement('td')
        code.textContent = promo.code

        const value = document.createElement('td')
        value.textContent =
          promo.type === 'percent' ? `${promo.value}%` : `${promo.value} ${promo.currency ?? ''}`

        const limit = document.createElement('td')
        limit.textContent = String(promo.maxUses)

        const used = document.createElement('td')
        used.textContent = String(promo.usedCount)

        const left = document.createElement('td')
        left.dataset.promoRemaining = ''
        left.textContent = String(promo.remaining)

        if (promo.remaining === 0) {
          const badge = document.createElement('span')
          badge.className = 'admin__status'
          badge.dataset.status = 'out_of_stock'
          badge.textContent = 'исчерпан'
          left.replaceChildren(badge)
        }

        row.append(code, value, limit, used, left)
        body.append(row)
      }

      table.append(head, body)
      promoBox.append(table)
    } catch (error) {
      reportError(error)
    }
  }

  const load = async () => {
    noteBox.textContent = NOTES[state]

    try {
      const { orders } = await listAdminOrders(state)
      renderOrders(orders)
      ordersBox.dataset.count = String(orders.length)
    } catch (error) {
      reportError(error)
    }

    await loadPromocodes()
  }

  filters.forEach((button) => {
    button.addEventListener('click', async () => {
      const next = button.dataset.filter
      if (next !== 'stuck' && next !== 'all') return

      state = next
      filters.forEach((other) => other.setAttribute('aria-pressed', String(other === button)))
      clearMessage()
      await load()
    })
  })

  refreshButton.addEventListener('click', async () => {
    clearMessage()
    await load()
  })

  /** @param {import('./api.js').Product} product */
  const catalogRow = (product) => {
    const row = document.createElement('tr')
    row.dataset.productRow = product.sku

    const sku = document.createElement('td')
    sku.textContent = product.sku

    const name = document.createElement('td')
    name.textContent = product.name

    const priceCell = document.createElement('td')
    const price = document.createElement('input')
    price.type = 'number'
    price.min = '1'
    price.value = String(product.price)
    price.dataset.price = product.sku
    price.className = 'admin__price'
    priceCell.append(price)

    const stock = document.createElement('td')
    stock.dataset.stock = product.sku
    stock.textContent = String(product.available ?? 0)

    const actions = document.createElement('td')
    actions.className = 'admin__row-actions'

    const apply = document.createElement('button')
    apply.type = 'button'
    apply.textContent = 'Сохранить цену'
    apply.addEventListener('click', async () => {
      clearMessage()

      try {
        const updated = await updateProduct(product.sku, { price: Number(price.value) })
        showMessage(`${updated.sku}: цена ${updated.price} ₽`, 'ok')
        await loadCatalog()
      } catch (error) {
        reportError(error)
      }
    })

    const minus = document.createElement('button')
    minus.type = 'button'
    minus.dataset.minus = product.sku
    minus.textContent = '−1'
    minus.addEventListener('click', () => void changeStock(product.sku, -1))

    const plus = document.createElement('button')
    plus.type = 'button'
    plus.dataset.plus = product.sku
    plus.textContent = '+1'
    plus.addEventListener('click', () => void changeStock(product.sku, 1))

    const drain = document.createElement('button')
    drain.type = 'button'
    drain.dataset.drain = product.sku
    drain.textContent = 'Обнулить'
    drain.addEventListener('click', () => {
      const left = Number(stock.textContent ?? '0')
      void changeStock(product.sku, -left)
    })

    actions.append(apply, minus, plus, drain)
    row.append(sku, name, priceCell, stock, actions)

    return row
  }

  /**
   * @param {string} sku
   * @param {number} delta
   */
  const changeStock = async (sku, delta) => {
    clearMessage()

    if (delta === 0) return

    try {
      if (delta > 0) {
        const stamp = Date.now().toString(36).toUpperCase()
        const keys = Array.from({ length: delta }, (_, i) => `ADMIN-${stamp}-${sku}-${i}`)
        const result = await restockKeys(sku, keys)
        showMessage(`${sku}: добавлено ${result.added}, свободно ${result.available}`, 'ok')
      } else {
        const result = await removeKeys(sku, -delta)
        showMessage(`${sku}: убрано ${result.removed}, свободно ${result.available}`, 'ok')
      }

      await loadCatalog()
    } catch (error) {
      reportError(error)
    }
  }

  const loadCatalog = async () => {
    try {
      const { products } = await listProducts()

      catalogBox.replaceChildren()

      const table = document.createElement('table')
      table.className = 'admin__table'

      const head = document.createElement('thead')
      const headRow = document.createElement('tr')

      for (const title of ['SKU', 'Название', 'Цена', 'Свободно', '']) {
        const cell = document.createElement('th')
        cell.textContent = title
        headRow.append(cell)
      }

      head.append(headRow)

      const body = document.createElement('tbody')
      products.forEach((/** @type {import('./api.js').Product} */ product) =>
        body.append(catalogRow(product))
      )

      table.append(head, body)
      catalogBox.append(table)
    } catch (error) {
      reportError(error)
    }
  }

  refreshCatalogButton.addEventListener('click', () => void loadCatalog())

  void loadCatalog()

  restockForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    clearMessage()

    const data = new FormData(restockForm)
    const sku = String(data.get('sku') ?? '').trim()
    const keys = String(data.get('keys') ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    if (!sku || keys.length === 0) {
      showMessage('Укажите SKU и хотя бы один ключ', 'error')
      return
    }

    restockSubmit.disabled = true

    try {
      const result = await restockKeys(sku, keys)
      showMessage(`${sku}: добавлено ${result.added}, свободно ${result.available}`, 'ok')
      restockForm.reset()
      await load()
      await loadCatalog()
    } catch (error) {
      reportError(error)
    } finally {
      restockSubmit.disabled = false
    }
  })

  load()
}
