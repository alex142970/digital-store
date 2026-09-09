import { test, expect } from '@playwright/test'

test.describe('витрина', () => {
  test('каталог загружается тремя секциями по 5 карточек', async ({ page }) => {
    await page.goto('/')

    await expect(page).toHaveTitle(/Digital Store/)

    const sections = ['popular', 'recommended', 'other']
    for (const name of sections) {
      const cards = page.locator(`[data-products="${name}"] .card`)
      await expect(cards).toHaveCount(5)
    }

    const firstCard = page.locator('[data-products="popular"] .card').first()
    await expect(firstCard.locator('.card__name')).not.toBeEmpty()
    await expect(firstCard.locator('.card__price')).toContainText('₽')
    await expect(firstCard.getByRole('button', { name: /Купить/ })).toBeVisible()
  })

  test('поиск: фокус затемняет страницу, Enter не перезагружает её', async ({ page }) => {
    await page.goto('/')

    const overlay = page.locator('.overlay')
    await expect(overlay).toHaveCSS('visibility', 'hidden')

    const input = page.getByPlaceholder('Игра, приложение или услуга...')
    await input.click()
    await expect(overlay).toHaveCSS('visibility', 'visible')

    await input.fill('gta')
    await input.press('Enter')

    await expect(page).toHaveURL(/\/$/)
    await expect(page.locator('[data-products="popular"] .card')).toHaveCount(5)

    await input.blur()
    await expect(overlay).toHaveCSS('visibility', 'hidden')
  })

  test('кнопка поиска не заливается серым при наведении', async ({ page }) => {
    await page.goto('/')

    const magnifier = page.getByRole('button', { name: 'Найти' })
    await magnifier.hover()

    await expect(magnifier).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  })

  test('меню каталога: открытие, фокус-ловушка, закрытие по Escape', async ({ page }) => {
    await page.goto('/')

    const toggle = page.locator('[data-catalog-toggle]')
    const menu = page.locator('[data-catalog-menu]')

    await expect(menu).toBeHidden()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await toggle.click()
    await expect(menu).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')

    const firstGroup = page.getByRole('button', { name: /Игры и игровые сервисы/ })
    await expect(firstGroup).toBeFocused()

    const lastLink = menu.getByRole('link', { name: /Bundle-наборы/ })

    await page.keyboard.press('Shift+Tab')
    await expect(toggle).toBeFocused()

    await page.keyboard.press('Shift+Tab')
    await expect(lastLink).toBeFocused()

    await page.keyboard.press('Tab')
    await expect(toggle).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(toggle).toBeFocused()
  })

  test('меню каталога закрывается кликом снаружи', async ({ page }) => {
    await page.goto('/')

    await page.locator('[data-catalog-toggle]').click()
    await expect(page.locator('[data-catalog-menu]')).toBeVisible()

    await page.mouse.click(10, 10)
    await expect(page.locator('[data-catalog-menu]')).toBeHidden()
  })

  test('клик по ссылке меню закрывает его и не прыгает по странице', async ({ page }) => {
    await page.goto('/')

    const menu = page.locator('[data-catalog-menu]')
    await page.locator('[data-catalog-toggle]').click()

    const scrollBefore = await page.evaluate(() => window.scrollY)

    await menu.getByRole('link', { name: 'Steam', exact: true }).click()

    await expect(menu).toBeHidden()
    const scrollAfter = await page.evaluate(() => window.scrollY)
    expect(scrollAfter).toBe(scrollBefore)
  })

  test('табы категорий переключают активный элемент', async ({ page }) => {
    await page.goto('/')

    const tabs = page.locator('.tabs .tab')
    await expect(tabs.first()).toHaveClass(/tab--active/)
    await expect(tabs.first()).toHaveAttribute('aria-pressed', 'true')

    const second = tabs.nth(1)
    await second.click()

    await expect(second).toHaveClass(/tab--active/)
    await expect(second).toHaveAttribute('aria-pressed', 'true')
    await expect(tabs.first()).not.toHaveClass(/tab--active/)
    await expect(tabs.first()).toHaveAttribute('aria-pressed', 'false')
  })

  test('группы каталога переключают активный элемент', async ({ page }) => {
    await page.goto('/')
    await page.locator('[data-catalog-toggle]').click()

    const groups = page.locator('.catalog__groups .catalog__group')
    await expect(groups.first()).toHaveClass(/catalog__group--active/)

    const target = page.getByRole('button', { name: /Программы/ })
    await target.click()

    await expect(target).toHaveClass(/catalog__group--active/)
    await expect(target).toHaveAttribute('aria-current', 'true')
    await expect(groups.first()).not.toHaveClass(/catalog__group--active/)
    await expect(groups.first()).not.toHaveAttribute('aria-current', 'true')
  })

  test('иконка сервиса подсвечивается при наведении', async ({ page }) => {
    await page.goto('/')

    await page.mouse.move(0, 0)

    const service = page.locator('.service').first()
    await expect(service).toHaveCSS('transform', 'none')

    await service.hover()

    await expect(service).not.toHaveCSS('transform', 'none')
  })

  test('карточка товара приподнимается при наведении', async ({ page }) => {
    await page.goto('/')

    await page.mouse.move(0, 0)

    const card = page.locator('[data-products="popular"] .card').first()
    await expect(card).toHaveCSS('transform', 'none')
    const restShadow = await card.evaluate((el) => getComputedStyle(el).boxShadow)

    await card.hover()

    await expect(card).not.toHaveCSS('transform', 'none')
    await expect
      .poll(async () => card.evaluate((el) => getComputedStyle(el).boxShadow))
      .not.toBe(restShadow)
  })

  test('баннер сам переключает слайды и зацикливается', async ({ page }) => {
    await page.clock.install()
    await page.goto('/')

    const banner = page.locator('[data-banner]')
    await expect(banner).toHaveAttribute('data-slide', '0')

    await page.clock.fastForward(5100)
    await expect(banner).toHaveAttribute('data-slide', '1')

    await page.locator('[data-banner-prev]').click()
    await expect(banner).toHaveAttribute('data-slide', '0')

    await page.locator('[data-banner-prev]').click()
    await expect(banner).toHaveAttribute('data-slide', '5')

    await page.locator('[data-banner-next]').click()
    await expect(banner).toHaveAttribute('data-slide', '0')
  })

  test('баннер не крутится, пока курсор над ним, и продолжает после ухода', async ({ page }) => {
    await page.clock.install()
    await page.goto('/')

    const banner = page.locator('[data-banner]')
    await banner.hover()

    const paused = await banner.getAttribute('data-slide')
    await page.clock.fastForward(12000)
    await expect(banner).toHaveAttribute('data-slide', String(paused))

    await page.locator('.services').hover()
    await page.clock.fastForward(5100)
    await expect(banner).not.toHaveAttribute('data-slide', String(paused))
  })

  test('баннер: стрелки и точки переключают активный слайд', async ({ page }) => {
    await page.goto('/')

    const dots = page.locator('[data-banner-dot]')
    await expect(dots.nth(0)).toHaveAttribute('aria-current', 'true')

    await page.locator('[data-banner-next]').click()
    await expect(dots.nth(1)).toHaveAttribute('aria-current', 'true')
    await expect(dots.nth(0)).not.toHaveAttribute('aria-current', 'true')

    await page.locator('[data-banner-prev]').click()
    await expect(dots.nth(0)).toHaveAttribute('aria-current', 'true')

    await dots.nth(3).click()
    await expect(dots.nth(3)).toHaveAttribute('aria-current', 'true')

    await expect(page).toHaveURL(/\/$/)
  })

  test('skip-link ведёт к содержимому и виден по фокусу', async ({ page }) => {
    await page.goto('/')

    const skip = page.locator('.skip-link')
    const restTop = await skip.evaluate((el) => parseFloat(getComputedStyle(el).top))
    expect(restTop).toBeLessThan(-100)

    await skip.focus()
    await expect(skip).toHaveCSS('top', '16px')
    await expect(skip).toHaveAttribute('href', '#products')
  })
})
