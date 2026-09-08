import { test, expect, type APIRequestContext } from '@playwright/test'
import {
  STUCK_SKU,
  closeFixtures,
  dropReservedKey,
  seedStuckKey,
  keysUsedFor,
  removeStuckProduct,
  resetStuckProduct
} from './fixtures.ts'

test.afterAll(async () => {
  await removeStuckProduct()
  await closeFixtures()
})

async function stuckOrder(request: APIRequestContext): Promise<string> {
  await seedStuckKey()

  const created = await request.post('/api/orders', {
    data: { sku: STUCK_SKU, idempotencyKey: `e2e-admin-${Date.now()}-${Math.random()}` }
  })
  expect(created.status()).toBe(201)
  const order = await created.json()

  await dropReservedKey(order.id)
  await request.post(`/api/orders/${order.id}/pay`, { data: { outcome: 'success' } })

  await expect
    .poll(
      async () => {
        const state = await request.get(`/api/orders/${order.id}`)
        return (await state.json()).status
      },
      { timeout: 15_000 }
    )
    .toBe('out_of_stock')

  return order.id as string
}

test.describe('админка', () => {
  test('открывается без токена и сразу показывает список', async ({ page }) => {
    await page.goto('/admin.html')

    await expect(page.getByRole('heading', { name: 'Админка' })).toBeVisible()
    await expect(page.locator('[data-filter="stuck"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-note]')).toContainText('Оплаченные заказы без ключа')
    await expect(page.locator('[data-orders]')).not.toBeEmpty()
    await expect(page.getByRole('textbox', { name: /Токен/ })).toHaveCount(0)
  })

  test('API админки отвечает без заголовка авторизации', async ({ request }) => {
    const response = await request.get('/api/admin/orders')

    expect(response.status()).toBe(200)
    expect(await response.json()).toHaveProperty('orders')
  })

  test('застрявший заказ попадает в список «оплачен, но не выдан»', async ({ page, request }) => {
    await resetStuckProduct()
    const orderId = await stuckOrder(request)

    await page.goto('/admin.html')

    const row = page.locator(`[data-order-row="${orderId}"]`)
    await expect(row).toBeVisible()
    await expect(row.locator('.admin__status')).toHaveAttribute('data-status', 'out_of_stock')
    await expect(row).toContainText('key pool is empty')
    await expect(row.getByRole('button', { name: 'Выдать повторно' })).toBeVisible()
  })

  test('фильтр переключает между застрявшими и всеми заказами', async ({ page, request }) => {
    const created = await request.post('/api/orders', {
      data: { sku: 'KEY-CS2-PRIME', idempotencyKey: `e2e-filter-${Date.now()}` }
    })
    const order = await created.json()
    await request.post(`/api/orders/${order.id}/pay`, { data: { outcome: 'success' } })

    await expect
      .poll(
        async () => {
          const state = await request.get(`/api/orders/${order.id}`)
          return (await state.json()).status
        },
        { timeout: 15_000 }
      )
      .toBe('delivered')

    await page.goto('/admin.html')

    const row = page.locator(`[data-order-row="${order.id}"]`)
    await expect(row).toHaveCount(0)

    await page.locator('[data-filter="all"]').click()

    await expect(page.locator('[data-filter="all"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-filter="stuck"]')).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('[data-note]')).toContainText('Все заказы')
    await expect(row).toBeVisible()
    await expect(row.locator('.admin__status')).toHaveAttribute('data-status', 'delivered')
    await expect(row.getByRole('button', { name: 'Выдать повторно' })).toHaveCount(0)
  })

  test('пополнение пула и повторная выдача доводят заказ до выдачи', async ({ page, request }) => {
    await resetStuckProduct()
    const orderId = await stuckOrder(request)

    await page.goto('/admin.html')

    const code = `E2E-${Date.now().toString(36).toUpperCase()}-RSTK`
    await page.getByPlaceholder('KEY-CS2-PRIME').fill(STUCK_SKU)
    await page.getByPlaceholder('AAAA-BBBB-CCCC').fill(code)
    await page.getByRole('button', { name: 'Добавить ключи' }).click()

    await expect(page.locator('[data-message]')).toContainText('добавлено 1')

    const row = page.locator(`[data-order-row="${orderId}"]`)
    await row.getByRole('button', { name: 'Выдать повторно' }).click()

    await expect(page.locator('[data-message]')).toContainText(orderId, { timeout: 15_000 })
    await expect(row).toHaveCount(0)

    const state = await request.get(`/api/orders/${orderId}`)
    const delivered = await state.json()
    expect(delivered.status).toBe('delivered')
    expect(delivered.code).toBe(code)
    expect(await keysUsedFor(code)).toBe(1)
  })

  test('повторная выдача идемпотентна: второй вызов не выдаёт второй ключ', async ({ request }) => {
    await resetStuckProduct()
    const orderId = await stuckOrder(request)

    const code = `E2E-${Date.now().toString(36).toUpperCase()}-IDEM`
    const restock = await request.post('/api/admin/keys', {
      data: { sku: STUCK_SKU, keys: [code] }
    })
    expect(restock.status()).toBe(201)

    const first = await request.post(`/api/admin/orders/${orderId}/retry`)
    expect(first.status()).toBe(200)
    expect((await first.json()).code).toBe(code)

    const second = await request.post(`/api/admin/orders/${orderId}/retry`)
    expect(second.status()).toBe(200)
    expect((await second.json()).code).toBe(code)

    expect(await keysUsedFor(code)).toBe(1)
  })

  test('повторная выдача завершённого заказа не ломает его', async ({ request }) => {
    await resetStuckProduct()
    const orderId = await stuckOrder(request)

    const code = `E2E-${Date.now().toString(36).toUpperCase()}-DONE`
    await request.post('/api/admin/keys', { data: { sku: STUCK_SKU, keys: [code] } })
    await request.post(`/api/admin/orders/${orderId}/retry`)

    const extra = `E2E-${Date.now().toString(36).toUpperCase()}-XTRA`
    await request.post('/api/admin/keys', { data: { sku: STUCK_SKU, keys: [extra] } })

    const again = await request.post(`/api/admin/orders/${orderId}/retry`)
    expect(again.status()).toBe(200)
    expect((await again.json()).code).toBe(code)
    expect(await keysUsedFor(extra)).toBe(0)
  })

  test('повторная выдача несуществующего заказа отвечает 404', async ({ request }) => {
    const response = await request.post('/api/admin/orders/ord_missing_e2e/retry')

    expect(response.status()).toBe(404)
  })

  test('пополнение неизвестного SKU показывает ошибку', async ({ page }) => {
    await page.goto('/admin.html')

    await page.getByPlaceholder('KEY-CS2-PRIME').fill('NO-SUCH-SKU')
    await page.getByPlaceholder('AAAA-BBBB-CCCC').fill('AAAA-BBBB-CCCC')
    await page.getByRole('button', { name: 'Добавить ключи' }).click()

    const message = page.locator('[data-message]')
    await expect(message).toBeVisible()
    await expect(message).toHaveAttribute('data-kind', 'error')
  })

  test('повторное пополнение теми же ключами не плодит дубликаты', async ({ request }) => {
    await resetStuckProduct()

    const code = `E2E-${Date.now().toString(36).toUpperCase()}-DUP`
    const first = await request.post('/api/admin/keys', {
      data: { sku: STUCK_SKU, keys: [code] }
    })
    const second = await request.post('/api/admin/keys', {
      data: { sku: STUCK_SKU, keys: [code] }
    })

    expect((await first.json()).added).toBe(1)
    expect((await second.json()).added).toBe(0)
    expect((await second.json()).available).toBe(1)
  })

  test('пустая форма пополнения не отправляется', async ({ page }) => {
    await page.goto('/admin.html')

    await page.getByRole('button', { name: 'Добавить ключи' }).click()

    await expect(page.getByPlaceholder('KEY-CS2-PRIME')).toBeFocused()
    await expect(page.locator('[data-message]')).toBeHidden()
  })

  test('кнопка «Обновить» перечитывает список', async ({ page, request }) => {
    await resetStuckProduct()

    await page.goto('/admin.html')
    const before = Number(await page.locator('[data-orders]').getAttribute('data-count'))

    const orderId = await stuckOrder(request)

    await page.getByRole('button', { name: 'Обновить', exact: true }).click()

    await expect(page.locator(`[data-order-row="${orderId}"]`)).toBeVisible()
    const after = Number(await page.locator('[data-orders]').getAttribute('data-count'))
    expect(after).toBeGreaterThan(before)
  })

  test('ошибка сети при загрузке списка показывает сообщение, а не пустую страницу', async ({
    page
  }) => {
    await page.route('**/api/admin/orders*', (route) => route.abort('failed'))
    await page.goto('/admin.html')

    const message = page.locator('[data-message]')
    await expect(message).toBeVisible()
    await expect(message).toHaveAttribute('data-kind', 'error')
  })

  test('раздел «Цены и остатки» показывает каталог и меняет цену', async ({ page, request }) => {
    await page.goto('/admin.html')

    const rows = page.locator('[data-product-row]')
    await expect(rows.first()).toBeVisible()

    const row = page.locator('[data-product-row="KEY-GTA5"]')
    const price = row.locator('[data-price]')

    const before = await request.get('/api/products')
    const original = (await before.json()).products.find(
      (item: { sku: string }) => item.sku === 'KEY-GTA5'
    ).price

    await price.fill('4321')
    await row.getByRole('button', { name: 'Сохранить цену' }).click()

    await expect(page.locator('[data-message]')).toContainText('4321')

    const after = await request.get('/api/products')
    const updated = (await after.json()).products.find(
      (item: { sku: string }) => item.sku === 'KEY-GTA5'
    )
    expect(updated.price).toBe(4321)

    await request.patch('/api/admin/products/KEY-GTA5', { data: { price: original } })
  })

  test('кнопки остатка добавляют и убирают единицы', async ({ page, request }) => {
    await page.goto('/admin.html')

    const row = page.locator('[data-product-row="GIFT-PSN-1000"]')
    const stock = row.locator('[data-stock]')

    await expect(row).toBeVisible()
    const before = Number(await stock.textContent())

    await row.getByRole('button', { name: '+1' }).click()
    await expect(stock).toHaveText(String(before + 1))

    await row.getByRole('button', { name: '−1' }).click()
    await expect(stock).toHaveText(String(before))

    const catalog = await request.get('/api/products')
    const product = (await catalog.json()).products.find(
      (item: { sku: string }) => item.sku === 'GIFT-PSN-1000'
    )
    expect(product.available).toBe(before)
  })

  test('зачёркнутая цена ниже текущей отклоняется понятной ошибкой', async ({ request }) => {
    const response = await request.patch('/api/admin/products/KEY-EFT', {
      data: { oldPrice: 1 }
    })

    expect(response.status()).toBe(400)
    expect((await response.json()).error).toBe('validation_error')
  })

  test('забронированные и выданные ключи удалить нельзя', async ({ request }) => {
    await resetStuckProduct()
    await seedStuckKey()

    const created = await request.post('/api/orders', {
      data: { sku: STUCK_SKU, idempotencyKey: `e2e-protected-${Date.now()}` }
    })
    expect(created.status()).toBe(201)

    const removal = await request.delete('/api/admin/keys', {
      data: { sku: STUCK_SKU, count: 5 }
    })

    expect(removal.status()).toBe(200)
    const body = await removal.json()
    expect(body).toMatchObject({ requested: 5, removed: 0, available: 0 })
  })
})
