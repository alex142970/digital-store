import { test, expect } from '@playwright/test'

async function applyPromo(page: import('@playwright/test').Page, code: string) {
  await page.locator('[data-promo-toggle]').click()
  await page.locator('[data-promo-input]').fill(code)
  await page.locator('[data-promo-apply]').click()
}

test.describe('промокод', () => {
  test('панель открывается из кнопки макета и закрывается кликом снаружи', async ({ page }) => {
    await page.goto('/')

    const panel = page.locator('[data-promo-panel]')
    const toggle = page.locator('[data-promo-toggle]')

    await expect(panel).toBeHidden()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await toggle.click()

    await expect(panel).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('[data-promo-input]')).toBeFocused()

    await page.locator('.banner__canvas').click()
    await expect(panel).toBeHidden()
  })

  test('пустой код не применяется', async ({ page }) => {
    await page.goto('/')

    await page.locator('[data-promo-toggle]').click()
    await page.locator('[data-promo-apply]').click()

    const status = page.locator('[data-promo-status]')
    await expect(status).toHaveAttribute('data-state', 'error')
    await expect(status).toContainText('Введите промокод')
  })

  test('код приводится к верхнему регистру и сбрасывается', async ({ page }) => {
    await page.goto('/')

    await applyPromo(page, 'welcome10')

    const status = page.locator('[data-promo-status]')
    await expect(status).toHaveAttribute('data-state', 'applied')
    await expect(status).toContainText('WELCOME10')
    await expect(page.locator('[data-promo-apply]')).toHaveText('Сбросить')

    await page.locator('[data-promo-apply]').click()

    await expect(status).toHaveText('')
    await expect(page.locator('[data-promo-apply]')).toHaveText('Применить')
  })

  test('скидку считает сервер: заказ создаётся с уменьшенной суммой', async ({ page }) => {
    await page.goto('/')

    await applyPromo(page, 'WELCOME10')

    const card = page.locator('[data-products="popular"] .card').first()
    const priceText = (await card.locator('.card__price').textContent()) ?? ''
    const price = Number(priceText.replace(/\D/g, ''))

    await card.getByRole('button', { name: /Купить/ }).click()

    await expect(page).toHaveURL(/\/order\.html\?id=ord_/)

    const status = page.locator('[data-order]')
    await expect(status).toContainText('Скидка')

    const orderId = new URL(page.url()).searchParams.get('id') ?? ''
    const response = await page.request.get(`/api/orders/${orderId}`)
    const order = await response.json()

    expect(order.promoCode).toBe('WELCOME10')
    expect(order.discount).toBe(Math.floor((price * 10) / 100))
    expect(order.total).toBe(price - order.discount)
  })

  test('исчерпанный промокод показывает ошибку в карточке и сбрасывается', async ({
    page,
    request
  }) => {
    const spend = await request.post('/api/orders', {
      data: { sku: 'KEY-GTA5', idempotencyKey: `promo-spend-${Date.now()}`, promoCode: 'ONCEONLY' }
    })
    expect([201, 409]).toContain(spend.status())

    await page.goto('/')
    await applyPromo(page, 'ONCEONLY')

    const card = page.locator('[data-products="popular"] .card').first()
    await card.getByRole('button', { name: /Купить/ }).click()

    await expect(card.locator('.card__error')).toContainText('Промокод исчерпан')
    await expect(page).toHaveURL(/\/$/)

    await expect(page.locator('[data-promo-status]')).toHaveText('')
  })

  test('несуществующий промокод отклоняется сервером', async ({ page }) => {
    await page.goto('/')

    await applyPromo(page, 'NOSUCHCODE')

    const card = page.locator('[data-products="popular"] .card').first()
    await card.getByRole('button', { name: /Купить/ }).click()

    await expect(card.locator('.card__error')).toContainText('Промокод не найден')
  })

  test('админка показывает лимит и расход промокода', async ({ page, request }) => {
    await request.post('/api/orders', {
      data: { sku: 'KEY-EFT', idempotencyKey: `promo-admin-${Date.now()}`, promoCode: 'LIMIT3' }
    })

    await page.goto('/admin.html')

    const row = page.locator('[data-promo-row="LIMIT3"]')
    await expect(row).toBeVisible()
    await expect(row).toContainText('25%')
    await expect(row).toContainText('3')
  })

  test('исчерпанный промокод помечен в админке', async ({ page, request }) => {
    await request.post('/api/orders', {
      data: { sku: 'KEY-EFT', idempotencyKey: `promo-once-${Date.now()}`, promoCode: 'ONCEONLY' }
    })

    await page.goto('/admin.html')

    const row = page.locator('[data-promo-row="ONCEONLY"]')
    await expect(row).toBeVisible()
    await expect(row.locator('[data-promo-remaining] .admin__status')).toHaveText('исчерпан')
  })
})
