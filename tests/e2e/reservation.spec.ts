import { test, expect, type APIRequestContext } from '@playwright/test'
import { closeFixtures, dropReservedKey, shortenReservation } from './fixtures.ts'

const SKU = 'KEY-EFT'

const money = (value: number) =>
  new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0
  }).format(value)

const plain = (text: string) => text.replace(/\s/g, ' ')

async function order(request: APIRequestContext, sku = SKU): Promise<string> {
  const response = await request.post('/api/orders', {
    data: { sku, idempotencyKey: `e2e-reservation-${Date.now()}-${Math.random()}` }
  })

  expect(response.status()).toBe(201)

  return (await response.json()).id
}

test.describe('бронь с таймером', () => {
  let basePrice = 0
  let baseStock = 0

  const stockOf = async (request: APIRequestContext) => {
    const { products } = await (await request.get('/api/products')).json()

    return products.find((item: { sku: string }) => item.sku === SKU).available as number
  }

  test.beforeEach(async ({ request }) => {
    const { products } = await (await request.get('/api/products')).json()
    const product = products.find((item: { sku: string }) => item.sku === SKU)

    basePrice = product.price
    baseStock = product.available
  })

  test.afterEach(async ({ request }) => {
    await request.patch(`/api/admin/products/${SKU}`, { data: { price: basePrice } })

    const missing = baseStock - (await stockOf(request))

    if (missing > 0) {
      const stamp = Date.now().toString(36).toUpperCase()
      await request.post('/api/admin/keys', {
        data: {
          sku: SKU,
          keys: Array.from({ length: missing }, (_, i) => `RESERVE-${stamp}-${i}`)
        }
      })
    }
  })

  test.afterAll(async () => {
    await closeFixtures()
  })

  test('на странице оформления идёт видимый обратный отсчёт', async ({ page, request }) => {
    const id = await order(request)
    await page.goto(`/order.html?id=${id}`)

    const timer = page.locator('[data-countdown]')
    const value = page.locator('[data-countdown-value]')

    await expect(timer).toBeVisible()
    await expect(timer).toHaveAttribute('data-state', 'active')
    await expect(value).toHaveText(/^\d+:\d{2}$/)

    const first = await value.textContent()
    await expect(value).not.toHaveText(String(first), { timeout: 5000 })
  })

  test('подорожание видно до оплаты, а списывается цена брони', async ({ page, request }) => {
    const id = await order(request)
    await page.goto(`/order.html?id=${id}`)

    await expect(page.locator('html')).toHaveAttribute('data-live', 'online')
    await expect(page.locator('[data-price-notice]')).toHaveCount(0)

    await request.patch(`/api/admin/products/${SKU}`, { data: { price: basePrice + 800 } })

    const notice = page.locator('[data-price-notice]')
    await expect(notice).toBeVisible({ timeout: 10_000 })
    await expect(notice).toHaveAttribute('data-price-notice', 'up')
    await expect
      .poll(async () => plain((await notice.textContent()) ?? ''), { timeout: 10_000 })
      .toBe(
        plain(
          `Товар подорожал: ${money(basePrice)} → ${money(basePrice + 800)}. ` +
            `Бронь держит старую цену, к оплате ${money(basePrice)}.`
        )
      )

    const status = page.locator('[data-order]')
    const before = await status.locator('.status__row').last().textContent()

    await status.getByRole('button', { name: 'Оплатить' }).click()
    await expect(status.locator('.status__badge')).toHaveText('Ключ выдан', { timeout: 15_000 })

    expect(await status.locator('.status__row').last().textContent()).toBe(before)
  })

  test('подешевевший товар со скидкой: показаны обе цены, сумма брони держится', async ({
    page,
    request
  }) => {
    const created = await request.post('/api/orders', {
      data: {
        sku: SKU,
        idempotencyKey: `e2e-price-drop-${Date.now()}-${Math.random()}`,
        promoCode: 'WELCOME10'
      }
    })

    expect(created.status()).toBe(201)

    const order = await created.json()
    expect(order.discount).toBeGreaterThan(0)
    expect(order.total).toBeLessThan(order.amount)

    await page.goto(`/order.html?id=${order.id}`)
    await expect(page.locator('html')).toHaveAttribute('data-live', 'online')
    await expect(page.locator('[data-price-notice]')).toHaveCount(0)

    await request.patch(`/api/admin/products/${SKU}`, { data: { price: order.total + 60 } })

    const expected = (now: number) =>
      plain(
        `Товар подешевел: ${money(order.amount)} → ${money(now)}. ` +
          `Ваш заказ остаётся по цене брони, к оплате ${money(order.total)}.`
      )

    const notice = page.locator('[data-price-notice]')
    await expect(notice).toBeVisible({ timeout: 10_000 })
    await expect(notice).toHaveAttribute('data-price-notice', 'down')
    await expect
      .poll(async () => plain((await notice.textContent()) ?? ''), { timeout: 10_000 })
      .toBe(expected(order.total + 60))

    await request.patch(`/api/admin/products/${SKU}`, { data: { price: order.total - 200 } })
    await expect
      .poll(async () => plain((await notice.textContent()) ?? ''), { timeout: 10_000 })
      .toBe(expected(order.total - 200))
    await expect(notice).toHaveAttribute('data-price-notice', 'down')

    expect(await (await request.get(`/api/orders/${order.id}`)).json()).toMatchObject({
      amount: order.amount,
      discount: order.discount,
      total: order.total
    })
  })

  test('по истечении отсчёта бронь снимается и товар возвращается в продажу', async ({
    page,
    request
  }) => {
    const id = await order(request)
    await shortenReservation(id, 2)

    await page.goto(`/order.html?id=${id}`)

    const status = page.locator('[data-order]')
    await expect(status.locator('.status__badge')).toHaveText('Бронь истекла', { timeout: 20_000 })
    await expect(status).toContainText('товар вернулся в продажу')

    await expect(status.getByRole('button', { name: 'Оплатить' })).toHaveCount(0)
    await expect(status.getByRole('link', { name: 'Вернуться к товару' })).toBeVisible()

    const refused = await request.post(`/api/orders/${id}/pay`, { data: { outcome: 'success' } })
    expect(refused.status()).toBe(409)
  })

  test('на нуле отсчёт не обещает освобождение, пока сервер его не подтвердил', async ({
    page,
    request
  }) => {
    const id = await order(request)

    await dropReservedKey(id)
    await shortenReservation(id, 1)

    await page.goto(`/order.html?id=${id}`)

    const timer = page.locator('[data-countdown]')
    await expect(timer).toHaveAttribute('data-state', 'expired', { timeout: 10_000 })
    await expect(timer).toContainText('Проверяем статус на сервере')
    await expect(page.locator('[data-countdown-value]')).toHaveText('0:00')

    await expect(page.locator('.status__badge')).toHaveText('Ожидает оплаты')
    await expect(page.locator('[data-order]')).not.toContainText('вернулся в продажу')

    await page.waitForTimeout(2500)
    await expect(page.locator('.status__badge')).toHaveText('Ожидает оплаты')
  })

  test('«Вернуться к товару» открывает карточку и подсвечивает её', async ({ page, request }) => {
    const id = await order(request)
    await shortenReservation(id, 1)

    await page.goto(`/order.html?id=${id}`)

    const back = page.getByRole('link', { name: 'Вернуться к товару' })
    await expect(back).toBeVisible({ timeout: 20_000 })
    await back.click()

    await expect(page).toHaveURL(new RegExp(`\\?product=${SKU}`))

    const card = page.locator(`[data-card="${SKU}"]`)
    await expect(card).toHaveClass(/card--highlighted/)
    await expect(card).toBeInViewport()
  })

  test('снятая бронь возвращает последнюю единицу всем открытым вкладкам', async ({
    browser,
    request
  }) => {
    const before = await stockOf(request)
    expect(before).toBeGreaterThan(1)
    await request.delete('/api/admin/keys', { data: { sku: SKU, count: before - 1 } })

    const catalog = await browser.newPage()
    await catalog.goto('/')
    await expect(catalog.locator('html')).toHaveAttribute('data-live', 'online')

    const buy = catalog.locator(`[data-card="${SKU}"] [data-buy]`)
    await expect(buy).toBeEnabled()

    const id = await order(request)

    await expect(buy).toBeDisabled({ timeout: 10_000 })
    await expect(buy).toHaveText('Раскуплено')

    const status = await browser.newPage()
    await status.goto(`/order.html?id=${id}`)
    await status.getByRole('button', { name: 'Снять бронь' }).click()

    await expect(status.locator('.status__badge')).toHaveText('Бронь снята')
    await expect(status.locator('[data-countdown]')).toHaveCount(0)

    await expect(buy).toBeEnabled({ timeout: 10_000 })
    await expect(buy).toHaveText('Купить')

    await catalog.close()
    await status.close()
  })

  test('без потока событий страница узнаёт об истечении брони сама', async ({ page, request }) => {
    await page.route('**/api/events', (route) => route.abort('failed'))

    const id = await order(request)
    await shortenReservation(id, 2)

    await page.goto(`/order.html?id=${id}`)

    await expect(page.locator('html')).toHaveAttribute('data-live', 'offline', {
      timeout: 10_000
    })

    await expect(page.locator('.status__badge')).toHaveText('Бронь истекла', { timeout: 25_000 })
  })

  test('неудачная отмена возвращает кнопку, а не оставляет её мёртвой', async ({
    page,
    request
  }) => {
    const id = await order(request)
    await page.goto(`/order.html?id=${id}`)

    const drop = page.getByRole('button', { name: 'Снять бронь' })
    await expect(drop).toBeEnabled()

    await page.route(`**/api/orders/${id}/cancel`, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'internal_error', message: 'нет связи' })
      })
    )

    await drop.click()

    const failure = page.locator('[data-error]')
    await expect(failure).toBeVisible()
    await expect(failure).toContainText('Не удалось снять бронь')
    await expect(drop).toBeEnabled()

    await page.unroute(`**/api/orders/${id}/cancel`)
    await drop.click()

    await expect(page.locator('.status__badge')).toHaveText('Бронь снята')
    await expect(failure).toBeHidden()
  })

  test('отмена во время обработки платежа объясняет отказ, а не молчит', async ({
    page,
    request
  }) => {
    const id = await order(request)
    await page.goto(`/order.html?id=${id}`)

    const drop = page.getByRole('button', { name: 'Снять бронь' })
    await expect(drop).toBeEnabled()

    await page.route(`**/api/orders/${id}/cancel`, (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'payment_in_progress',
          message: 'Payment for this order is being processed'
        })
      })
    )

    await drop.click()

    const failure = page.locator('[data-error]')
    await expect(failure).toBeVisible()
    await expect(failure).toContainText('Оплата этого заказа уже обрабатывается')
    await expect(page.locator('.status__badge')).toHaveText('Ожидает оплаты')
  })

  test('во время обработки платежа страница дожидается выдачи и без потока событий', async ({
    page,
    request
  }) => {
    await page.route('**/api/events', (route) => route.abort('failed'))

    const id = await order(request)
    await page.goto(`/order.html?id=${id}`)

    await page.route(`**/api/orders/${id}/cancel`, (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'payment_in_progress',
          message: 'Payment for this order is being processed'
        })
      })
    )

    await page.getByRole('button', { name: 'Снять бронь' }).click()

    const failure = page.locator('[data-error]')
    await expect(failure).toContainText('уже обрабатывается')

    await request.post(`/api/orders/${id}/pay`, { data: { outcome: 'success' } })

    await expect(page.locator('.status__badge')).toHaveText('Ключ выдан', { timeout: 25_000 })
    await expect(failure).toBeHidden()
  })

  test('обрыв связи в момент отмены не оставляет кнопки мёртвыми', async ({ page, request }) => {
    const id = await order(request)
    await page.goto(`/order.html?id=${id}`)

    const drop = page.getByRole('button', { name: 'Снять бронь' })
    const buy = page.getByRole('button', { name: 'Оплатить' })
    await expect(drop).toBeEnabled()

    await page.route(`**/api/orders/${id}**`, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'internal_error', message: 'сервис недоступен' })
      })
    )

    await drop.click()

    const failure = page.locator('[data-error]')
    await expect(failure).toBeVisible()
    await expect(failure).toContainText('Не удалось снять бронь')
    await expect(drop).toBeEnabled()
    await expect(buy).toBeEnabled()
    await expect(buy).toHaveText('Оплатить')
  })

  test('просроченная бронь не оживляет оплату после сорвавшейся отмены', async ({
    page,
    request
  }) => {
    const id = await order(request)

    await dropReservedKey(id)
    await shortenReservation(id, 1)

    await page.goto(`/order.html?id=${id}`)

    const buy = page.getByRole('button', { name: 'Оплатить' })
    const drop = page.getByRole('button', { name: 'Снять бронь' })

    await expect(page.locator('[data-countdown]')).toHaveAttribute('data-state', 'expired', {
      timeout: 10_000
    })
    await expect(buy).toBeDisabled()
    await expect(drop).toBeEnabled()

    await page.route(`**/api/orders/${id}**`, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'internal_error', message: 'сервис недоступен' })
      })
    )

    await drop.click()

    await expect(page.locator('[data-error]')).toContainText('Не удалось снять бронь')

    await expect(drop).toBeEnabled()
    await expect(buy).toBeDisabled()
  })

  test('перерисовка во время отмены не воскрешает оплату просроченной брони', async ({
    page,
    request
  }) => {
    const id = await order(request)

    await dropReservedKey(id)
    await shortenReservation(id, 4)

    await page.goto(`/order.html?id=${id}`)

    const buy = page.getByRole('button', { name: 'Оплатить' })
    const drop = page.getByRole('button', { name: 'Снять бронь' })
    const timer = page.locator('[data-countdown]')
    await expect(drop).toBeEnabled()

    await page.route(`**/api/orders/${id}/cancel`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 9000))
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'internal_error', message: 'сервис недоступен' })
      })
    })

    await drop.click()

    await request.patch(`/api/admin/products/${SKU}`, { data: { price: basePrice + 300 } })
    await expect(page.locator('[data-price-notice]')).toBeVisible({ timeout: 10_000 })

    await page.route(`**/api/orders/${id}`, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'internal_error', message: 'сервис недоступен' })
      })
    )

    await expect(timer).toHaveAttribute('data-state', 'expired', { timeout: 15_000 })

    await expect(page.locator('[data-error]')).toContainText('Не удалось снять бронь', {
      timeout: 15_000
    })
    await expect(timer).toHaveAttribute('data-state', 'expired')
    await expect(buy).toBeDisabled()
  })

  test('бронь, истёкшая во время запроса, не даёт оживить оплату', async ({ page, request }) => {
    const id = await order(request)

    await dropReservedKey(id)
    await shortenReservation(id, 4)

    await page.goto(`/order.html?id=${id}`)

    const buy = page.getByRole('button', { name: 'Оплатить' })
    const drop = page.getByRole('button', { name: 'Снять бронь' })
    const timer = page.locator('[data-countdown]')

    await expect(buy).toBeEnabled()
    await expect(drop).toBeEnabled()

    await page.route(`**/api/orders/${id}/cancel`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 9000))
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'internal_error', message: 'сервис недоступен' })
      })
    })

    await page.route(`**/api/orders/${id}`, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'internal_error', message: 'сервис недоступен' })
      })
    )

    await drop.click()

    await expect(timer).toHaveAttribute('data-state', 'expired', { timeout: 15_000 })
    await expect(page.locator('[data-error]')).toContainText('Не удалось снять бронь', {
      timeout: 15_000
    })

    await expect(drop).toBeEnabled()
    await expect(buy).toBeDisabled()
  })

  test('оплаченный заказ больше не показывает отсчёт', async ({ page, request }) => {
    const id = await order(request)
    await page.goto(`/order.html?id=${id}`)

    await expect(page.locator('[data-countdown]')).toBeVisible()

    await page.getByRole('button', { name: 'Оплатить' }).click()

    await expect(page.locator('.status__badge')).toHaveText('Ключ выдан', { timeout: 15_000 })
    await expect(page.locator('[data-countdown]')).toHaveCount(0)
  })
})
