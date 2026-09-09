import { test, expect } from '@playwright/test'
import {
  STUCK_SKU,
  closeFixtures,
  dropReservedKey,
  seedStuckKey,
  removeStuckProduct,
  resetStuckProduct
} from './fixtures.ts'

test.describe('покупка товара', () => {
  test.afterAll(async () => {
    await removeStuckProduct()
    await closeFixtures()
  })

  test('успешная оплата: от клика «Купить» до выдачи ключа', async ({ page }) => {
    await page.goto('/')

    const buyButton = page
      .locator('[data-products="popular"] .card')
      .first()
      .getByRole('button', { name: /Купить/ })
    const sku = await buyButton.getAttribute('data-buy')
    await buyButton.click()

    await expect(page).toHaveURL(/\/order\.html\?id=ord_/)

    const status = page.locator('[data-order]')
    await expect(status.locator('.status__badge')).toHaveText('Ожидает оплаты')
    await expect(status).toContainText(String(sku))

    await status.getByRole('button', { name: 'Оплатить' }).click()

    await expect(status.locator('.status__badge')).toHaveText('Ключ выдан', { timeout: 15_000 })
    await expect(status.locator('.status__key')).not.toBeEmpty()
    await expect(status.getByRole('button', { name: 'Вернуться в каталог' })).toBeVisible()
  })

  test('неудачная оплата финальна: повторить нельзя, нужен новый заказ', async ({ page }) => {
    await page.goto('/')

    await page
      .locator('[data-products="recommended"] .card')
      .first()
      .getByRole('button', { name: /Купить/ })
      .click()

    const status = page.locator('[data-order]')
    await status.getByRole('button', { name: 'Оплата не прошла' }).click()

    await expect(status.locator('.status__badge')).toHaveText('Оплата не прошла')
    await expect(status.locator('.status__badge')).toHaveAttribute('data-state', 'failed')

    await expect(status.getByRole('button', { name: 'Оплатить' })).toHaveCount(0)
    await expect(status.getByRole('button', { name: 'Оплата не прошла' })).toHaveCount(0)
    await expect(status.getByRole('button', { name: 'Вернуться в каталог' })).toBeVisible()

    const orderId = new URL(page.url()).searchParams.get('id') ?? ''
    const retry = await page.request.post(`/api/orders/${orderId}/pay`, {
      data: { outcome: 'success' }
    })
    expect(retry.status()).toBe(409)
  })

  test('кнопка остаётся кликабельной после сетевой ошибки при оплате', async ({ page }) => {
    await page.goto('/')

    await page
      .locator('[data-products="other"] .card')
      .first()
      .getByRole('button', { name: /Купить/ })
      .click()

    const status = page.locator('[data-order]')
    const payButton = status.getByRole('button', { name: 'Оплатить' })

    await page.route('**/api/orders/*/pay', (route) => route.abort('failed'))
    await payButton.click()

    await expect(payButton).toBeEnabled()
    await expect(payButton).toHaveText('Оплатить')

    await page.unroute('**/api/orders/*/pay')
    await payButton.click()
    await expect(status.locator('.status__badge')).toHaveText('Ключ выдан', { timeout: 15_000 })
  })

  test('несуществующий заказ показывает понятную ошибку', async ({ page }) => {
    await page.goto('/order.html?id=ord_does_not_exist')

    const status = page.locator('[data-order]')
    await expect(status).toContainText('Заказ не найден')
    await expect(status.getByRole('button', { name: 'Повторить' })).toBeVisible()
  })

  test('страница заказа без id сообщает об этом без падения', async ({ page }) => {
    await page.goto('/order.html')

    await expect(page.locator('[data-order]')).toContainText('Не указан номер заказа')
  })

  test('после покупки повторный визит с тем же товаром создаёт отдельный заказ', async ({
    page
  }) => {
    await page.goto('/')

    const buy = page
      .locator('[data-products="popular"] .card')
      .first()
      .getByRole('button', {
        name: /Купить/
      })

    await buy.click()
    await expect(page).toHaveURL(/\/order\.html\?id=ord_[\w-]+/)
    const firstId = new URL(page.url()).searchParams.get('id')

    await page.goto('/')
    await page
      .locator('[data-products="popular"] .card')
      .first()
      .getByRole('button', {
        name: /Купить/
      })
      .click()

    await expect(page).toHaveURL(/\/order\.html\?id=ord_[\w-]+/)
    const secondId = new URL(page.url()).searchParams.get('id')

    expect(secondId).not.toBe(firstId)
  })

  test('пустой пул: страница заказа не падает и даёт повторить после пополнения', async ({
    page,
    request
  }) => {
    await resetStuckProduct()

    await seedStuckKey()

    const created = await request.post('/api/orders', {
      data: { sku: STUCK_SKU, idempotencyKey: `e2e-empty-pool-${Date.now()}` }
    })
    const order = await created.json()
    await dropReservedKey(order.id)
    await request.post(`/api/orders/${order.id}/pay`, { data: { outcome: 'success' } })

    await page.goto(`/order.html?id=${order.id}`)

    const status = page.locator('[data-order]')
    const badge = status.locator('.status__badge')

    await expect(badge).toHaveText('Ключей временно нет', { timeout: 15_000 })
    await expect(badge).toHaveAttribute('data-state', 'failed')
    await expect(status).toContainText('key pool is empty')

    await expect(status.getByRole('button', { name: 'Проверить ещё раз' })).toBeVisible()

    const code = `E2E-${Date.now().toString(36).toUpperCase()}-PAGE`
    await request.post('/api/admin/keys', { data: { sku: STUCK_SKU, keys: [code] } })

    await expect(badge).toHaveText('Ключ выдан', { timeout: 15_000 })
    await expect(status.locator('.status__key')).toContainText(code)

    await removeStuckProduct()
  })

  test('двойной клик по «Купить» создаёт ровно один заказ', async ({ page }) => {
    await page.goto('/')

    let posted = 0
    await page.route('**/api/orders', async (route) => {
      if (route.request().method() === 'POST') posted += 1
      await route.continue()
    })

    await page
      .locator('[data-products="popular"] .card')
      .first()
      .getByRole('button', { name: /Купить/ })
      .evaluate((button) => {
        if (!(button instanceof HTMLElement)) return
        button.click()
        button.click()
      })

    await expect(page).toHaveURL(/\/order\.html\?id=ord_/)
    expect(posted).toBe(1)
  })

  test('сбой создания заказа показывает ошибку в карточке и возвращает кнопку', async ({
    page
  }) => {
    await page.goto('/')

    await page.route('**/api/orders', (route) =>
      route.request().method() === 'POST' ? route.abort('failed') : route.continue()
    )

    const card = page.locator('[data-products="popular"] .card').first()
    const buy = card.getByRole('button', { name: /Купить/ })
    await buy.click()

    await expect(card.locator('.card__error')).toBeVisible()
    await expect(buy).toBeEnabled()
    await expect(buy).toHaveText('Повторить')
    await expect(page).toHaveURL(/\/$/)

    await page.unroute('**/api/orders')
    await buy.click()
    await expect(page).toHaveURL(/\/order\.html\?id=ord_/)
  })
})
