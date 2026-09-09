import { test, expect, type Page } from '@playwright/test'

const results = '[data-results] > li'

async function type(page: Page, value: string) {
  await page.locator('[data-filter-q]').fill(value)
}

test.describe('поиск по каталогу', () => {
  test('И2: прямая ссылка открывает тот же экран, что и ввод руками', async ({ page }) => {
    await page.goto('/search.html')
    await type(page, 'tarkov')
    await expect(page.locator(results).first()).toContainText('Tarkov')

    const typed = await page.locator('[data-summary]').textContent()
    expect(page.url()).toContain('q=tarkov')

    const direct = await page.context().newPage()
    await direct.goto('/search.html?q=tarkov')

    await expect(direct.locator('[data-summary]')).toHaveText(String(typed))
    await expect(direct.locator('[data-filter-q]')).toHaveValue('tarkov')

    await direct.close()
  })

  test('И2: фильтры попадают в адрес и восстанавливаются из него', async ({ page }) => {
    await page.goto('/search.html')

    await page.locator('[data-filter-type]').selectOption('subscription')
    await page.locator('[data-filter-stock]').check()
    await page.locator('[data-filter-sort]').selectOption('price')
    await page.locator('[data-filter-min]').fill('300')

    await expect(page).toHaveURL(/type=subscription/)
    await expect(page).toHaveURL(/stock=1/)
    await expect(page).toHaveURL(/sort=price/)
    await expect(page).toHaveURL(/min=300/)

    await expect(page.locator('[data-summary]')).toContainText('позиц')
    await page.waitForTimeout(300)
    const shown = await page.locator('[data-summary]').textContent()

    await page.reload()

    await expect(page.locator('[data-filter-type]')).toHaveValue('subscription')
    await expect(page.locator('[data-filter-stock]')).toBeChecked()
    await expect(page.locator('[data-filter-sort]')).toHaveValue('price')
    await expect(page.locator('[data-filter-min]')).toHaveValue('300')
    await expect(page.locator('[data-summary]')).toHaveText(String(shown))
  })

  test('И2: кнопка «назад» возвращает предыдущий фильтр вместе с выдачей', async ({ page }) => {
    await page.goto('/search.html')

    const summary = page.locator('[data-summary]')
    const initial = await summary.textContent()

    await page.locator('[data-filter-type]').selectOption('key')
    await expect(page).toHaveURL(/type=key/)
    await expect(summary).not.toHaveText(String(initial))
    const keys = await summary.textContent()

    await page.locator('[data-filter-type]').selectOption('topup')
    await expect(page).toHaveURL(/type=topup/)
    await expect(summary).not.toHaveText(String(keys))

    await page.goBack()

    await expect(page.locator('[data-filter-type]')).toHaveValue('key')
    await expect(summary).toHaveText(String(keys))
  })

  test('И1: устаревший ответ не перетирает свежий', async ({ page }) => {
    await page.goto('/search.html')

    let slowed = false
    await page.route('**/api/catalog**', async (route) => {
      const url = route.request().url()

      if (!slowed && url.includes('q=steam')) {
        slowed = true
        await new Promise((resolve) => setTimeout(resolve, 2500))
      }

      await route.continue()
    })

    await type(page, 'steam')
    await page.waitForTimeout(400)
    await type(page, 'tarkov')

    await expect(page.locator(results).first()).toContainText('Tarkov')

    await page.waitForTimeout(3000)

    await expect(page.locator(results).first()).toContainText('Tarkov')
    await expect(page.locator('[data-filter-q]')).toHaveValue('tarkov')
  })

  test('И3: совпавшие карточки переживают обновление, список не пересоздаётся', async ({
    page
  }) => {
    await page.goto('/search.html?q=roblox')
    await expect(page.locator(results).first()).toBeVisible()

    const mutations = await page.evaluate(async () => {
      const list = document.querySelector('[data-results]')
      if (!list) return -1

      let changes = 0
      const observer = new MutationObserver((records) => {
        for (const record of records)
          changes += record.addedNodes.length + record.removedNodes.length
      })

      observer.observe(list, { childList: true })

      const field = document.querySelector('[data-filter-q]')
      if (field instanceof HTMLInputElement) {
        field.value = 'roblox'
        field.dispatchEvent(new Event('input', { bubbles: true }))
      }

      await new Promise((resolve) => setTimeout(resolve, 900))
      observer.disconnect()

      return changes
    })

    expect(mutations).toBe(0)
  })

  test('И4: ввод не порождает запрос на каждый символ', async ({ page }) => {
    await page.goto('/search.html')

    let requests = 0
    page.on('request', (request) => {
      if (request.url().includes('/api/catalog')) requests += 1
    })

    const field = page.locator('[data-filter-q]')
    for (const chunk of ['t', 'ta', 'tar', 'tark', 'tarko', 'tarkov']) {
      await field.fill(chunk)
      await page.waitForTimeout(30)
    }

    await expect(page.locator(results).first()).toContainText('Tarkov')
    await page.waitForTimeout(600)

    expect(requests).toBeLessThan(4)
  })

  test('И5: пустой результат объясняет себя', async ({ page }) => {
    await page.goto('/search.html?q=такоготочнонетвкаталоге')

    await expect(page.locator('[data-empty]')).toBeVisible()
    await expect(page.locator('[data-empty]')).toContainText('ничего не нашлось')
    await expect(page.locator(results)).toHaveCount(0)
  })

  test('И6: изменение остатка убирает и возвращает позицию при фильтре «в наличии»', async ({
    page,
    request
  }) => {
    const sku = 'GIFT-XBOX-1500'
    const card = page.locator(`[data-item="${sku}"]`)

    await page.goto(`/search.html?q=${sku}&stock=1`)
    await expect(card).toHaveCount(1)

    const before = Number(
      (await (await request.get('/api/products')).json()).products.find(
        (item: { sku: string }) => item.sku === sku
      ).available
    )

    await request.delete('/api/admin/keys', { data: { sku, count: before } })

    await expect(card).toHaveCount(0, { timeout: 15_000 })

    const stamp = Date.now().toString(36).toUpperCase()
    await request.post('/api/admin/keys', {
      data: { sku, keys: Array.from({ length: before }, (_, i) => `SEARCH-${stamp}-${i}`) }
    })

    await expect(card).toHaveCount(1, { timeout: 15_000 })
  })

  test('постраничная догрузка дописывает, а не заменяет', async ({ page }) => {
    await page.goto('/search.html?sort=price')

    await expect(page.locator(results)).toHaveCount(24)
    const first = await page.locator(results).first().getAttribute('data-item')

    await page.locator('[data-more]').click()

    await expect(page.locator(results)).toHaveCount(48)
    expect(await page.locator(results).first().getAttribute('data-item')).toBe(first)
  })
})
