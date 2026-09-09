import { test, expect, type APIRequestContext } from '@playwright/test'

const SKU = 'GIFT-XBOX-1500'

async function stockOf(request: APIRequestContext, sku: string): Promise<number> {
  const response = await request.get('/api/products')
  const { products } = await response.json()

  return products.find((product: { sku: string }) => product.sku === sku).available
}

test.describe('живая витрина', () => {
  let basePrice = 0
  let baseStock = 0

  test.beforeEach(async ({ request }) => {
    const response = await request.get('/api/products')
    const { products } = await response.json()
    const product = products.find((item: { sku: string }) => item.sku === SKU)

    basePrice = product.price
    baseStock = product.available
  })

  test.afterEach(async ({ request }) => {
    await request.patch(`/api/admin/products/${SKU}`, { data: { price: basePrice } })

    const current = await stockOf(request, SKU)

    if (current < baseStock) {
      const stamp = Date.now().toString(36).toUpperCase()
      await request.post('/api/admin/keys', {
        data: {
          sku: SKU,
          keys: Array.from({ length: baseStock - current }, (_, i) => `RESTORE-${stamp}-${i}`)
        }
      })
    }
  })

  test('поток событий подключается при открытии витрины', async ({ page }) => {
    await page.goto('/')

    await expect(page.locator('html')).toHaveAttribute('data-live', 'online')
  })

  test('геометрия шапки соответствует макету', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')

    await expect(page.locator('html')).toHaveAttribute('data-live', 'online')

    const geometry = await page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector)
        return element ? Math.round(element.getBoundingClientRect().width) : null
      }

      const inner = document.querySelector('.header__inner')

      return {
        profile: box('.header__profile'),
        search: box('.search'),
        catalog: box('.catalog__button'),
        row: inner ? inner.scrollWidth : null
      }
    })

    expect(geometry).toEqual({ profile: 44, search: 688, catalog: 120, row: 1200 })
  })

  test('изменение цены видно в двух вкладках без перезагрузки', async ({ browser, request }) => {
    const first = await browser.newPage()
    const second = await browser.newPage()

    try {
      await first.goto('/')
      await second.goto('/')

      const card = `[data-card="${SKU}"] .card__price`
      await expect(first.locator(card)).toBeVisible()
      await expect(second.locator(card)).toBeVisible()

      const before = await first.locator(card).textContent()
      expect(before).not.toContain('1 234')

      await first.waitForTimeout(1500)
      await second.waitForTimeout(100)

      await first.evaluate(() => {
        Object.assign(window, { __alive: 'yes' })
      })

      await request.patch(`/api/admin/products/${SKU}`, { data: { price: 1234 } })

      await expect(first.locator(card)).toContainText('1 234')
      await expect(second.locator(card)).toContainText('1 234')

      const survived = await first.evaluate(
        () => (window as unknown as Record<string, unknown>).__alive
      )
      expect(survived).toBe('yes')
    } finally {
      await first.close()
      await second.close()
    }
  })

  test('обнуление остатка гасит кнопку сразу во всех вкладках', async ({ browser, request }) => {
    const first = await browser.newPage()
    const second = await browser.newPage()

    try {
      await first.goto('/')
      await second.goto('/')

      const buy = `[data-card="${SKU}"] [data-buy]`
      await expect(first.locator(buy)).toBeEnabled()
      await expect(second.locator(buy)).toBeEnabled()

      const left = await stockOf(request, SKU)
      await request.delete('/api/admin/keys', { data: { sku: SKU, count: left } })

      await expect(first.locator(buy)).toBeDisabled()
      await expect(second.locator(buy)).toBeDisabled()
      await expect(first.locator(buy)).toHaveText('Раскуплено')

      await request.post('/api/admin/keys', {
        data: { sku: SKU, keys: [`LIVE-BACK-${Date.now()}`] }
      })

      await expect(first.locator(buy)).toBeEnabled()
      await expect(second.locator(buy)).toBeEnabled()
    } finally {
      await first.close()
      await second.close()
    }
  })

  test('витрина сама восстанавливается после падения каталога', async ({ page }) => {
    let failNext = true

    await page.route('**/api/products', async (route) => {
      if (failNext) {
        failNext = false
        await route.abort('failed')
        return
      }

      await route.continue()
    })

    await page.goto('/')

    await expect(page.locator('[data-products="popular"]')).toContainText(
      'Не удалось загрузить каталог'
    )

    await expect(page.locator('[data-products="popular"] .card')).toHaveCount(5, {
      timeout: 15_000
    })
  })

  test('поток восстанавливается после ответа 503 от прокси', async ({ page, request }) => {
    let rejected = 0

    await page.route('**/api/events', async (route) => {
      if (rejected < 2) {
        rejected += 1
        await route.fulfill({ status: 503, body: 'proxy is down' })
        return
      }

      await route.continue()
    })

    await page.goto('/')

    await expect(page.locator('html')).toHaveAttribute('data-live', 'offline', {
      timeout: 10_000
    })

    await expect(page.locator('html')).toHaveAttribute('data-live', 'online', {
      timeout: 20_000
    })
    expect(rejected).toBe(2)

    const card = `[data-card="${SKU}"] .card__price`
    await first_price_changes(page, request, card)
  })
})
async function first_price_changes(
  page: import('@playwright/test').Page,
  request: APIRequestContext,
  card: string
) {
  await page.waitForTimeout(1500)
  await request.patch(`/api/admin/products/${SKU}`, { data: { price: 4567 } })
  await expect(page.locator(card)).toContainText('4 567', { timeout: 10_000 })
}
