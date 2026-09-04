import { test, expect } from '@playwright/test'

test.describe('виджет пополнения', () => {
  test('пустая форма подсвечивает оба поля и объясняет причину', async ({ page }) => {
    await page.goto('/')

    const login = page.locator('[data-login-input]')
    const amount = page.locator('[data-amount-input]')
    await amount.fill('')

    await page.getByRole('button', { name: /Оплатить/ }).click()

    await expect(login).toHaveAttribute('aria-invalid', 'true')
    await expect(amount).toHaveAttribute('aria-invalid', 'true')
    await expect(page.locator('#login-error')).toHaveText('Введите логин Steam')
    await expect(page.locator('#amount-error')).toHaveText('Укажите сумму пополнения')

    await expect(page.locator('#login-error')).toBeVisible()
  })

  test('нулевая сумма считается невалидной, а сумма > 0 — нет', async ({ page }) => {
    await page.goto('/')

    const amount = page.locator('[data-amount-input]')
    await amount.fill('0')
    await page.locator('[data-login-input]').fill('steamuser')
    await page.getByRole('button', { name: /Оплатить/ }).click()

    await expect(amount).toHaveAttribute('aria-invalid', 'true')
    await expect(page.locator('#amount-error')).toHaveText('Укажите сумму пополнения')

    await amount.fill('500')
    await expect(amount).toHaveAttribute('aria-invalid', 'false')
    await expect(page.locator('#amount-error')).toBeEmpty()
  })

  test('ошибка логина живо пересчитывается после первой попытки отправки', async ({ page }) => {
    await page.goto('/')

    await page.locator('[data-amount-input]').fill('500')
    await page.getByRole('button', { name: /Оплатить/ }).click()

    const login = page.locator('[data-login-input]')
    await expect(login).toHaveAttribute('aria-invalid', 'true')

    await login.fill('  ')
    await expect(login).toHaveAttribute('aria-invalid', 'true')
    await expect(page.locator('#login-error')).toHaveText('Введите логин Steam')

    await login.fill('alex')
    await expect(login).toHaveAttribute('aria-invalid', 'false')
    await expect(page.locator('#login-error')).toBeEmpty()
  })

  test('переключение валюты меняет символ, значок и подпись кнопки одновременно', async ({
    page
  }) => {
    await page.goto('/')

    const submit = page.locator('[data-pay-label]')
    const symbol = page.locator('[data-amount-symbol]')
    const icon = page.locator('[data-amount-icon]')

    await expect(symbol).toHaveText('$')
    await expect(icon).toHaveText('$')
    await expect(submit).toHaveText('Оплатить 500$')

    await page.locator('[data-currency-option="RUB"]').click()

    await expect(symbol).toHaveText('₽')
    await expect(icon).toHaveText('₽')
    await expect(submit).toHaveText('Оплатить 500₽')
    await expect(page.locator('[data-currency-option="RUB"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await expect(page.locator('[data-currency-option="USD"]')).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })

  test('поле суммы принимает только цифры и не более 7 знаков', async ({ page }) => {
    await page.goto('/')

    const amount = page.locator('[data-amount-input]')
    await amount.pressSequentially('12ab34cd5678901', { delay: 5 })

    await expect(amount).toHaveValue('1234567')
  })

  test('клик по всему полю суммы фокусирует инпут', async ({ page }) => {
    await page.goto('/')

    const field = page.locator('.topup__field--amount')
    const box = await field.boundingBox()
    if (!box) throw new Error('поле суммы не найдено на странице')

    await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2)

    await expect(page.locator('[data-amount-input]')).toBeFocused()
  })

  test('форма не перезагружает страницу при отправке по Enter', async ({ page }) => {
    await page.goto('/')

    await page.locator('[data-login-input]').fill('alex')
    await page.locator('[data-amount-input]').fill('500')
    await page.locator('[data-login-input]').press('Enter')

    await expect(page).toHaveURL(/\/$/)
    await expect(page.locator('[data-login-input]')).toHaveAttribute('aria-invalid', 'false')
  })
})
