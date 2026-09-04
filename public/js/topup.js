/** @type {Record<string, string>} */
const SYMBOLS = {
  RUB: '₽',
  USD: '$',
  KZT: '₸'
}

const MAX_DIGITS = 7

/**
 * @param {HTMLInputElement} input
 * @param {HTMLElement} ruler
 */
function resize(input, ruler) {
  ruler.textContent = input.value || '0'
  input.style.width = `${ruler.offsetWidth}px`
}

/** @param {Element | null} root */
export function initTopup(root) {
  if (!root) return

  const options = [...root.querySelectorAll('[data-currency-option]')]
  const input = root.querySelector('[data-amount-input]')
  const symbol = root.querySelector('[data-amount-symbol]')
  const submit = root.querySelector('[data-pay-label]')
  const icon = root.querySelector('[data-amount-icon]')
  const login = root.querySelector('[data-login-input]')
  const loginError = root.querySelector('[data-error="login"]')
  const amountError = root.querySelector('[data-error="amount"]')

  if (!(input instanceof HTMLInputElement) || !(login instanceof HTMLInputElement)) return

  /**
   * @param {HTMLInputElement} control
   * @param {Element | null} errorEl
   * @param {string} message
   */
  const mark = (control, errorEl, message) => {
    const invalid = message !== ''
    control.setAttribute('aria-invalid', String(invalid))
    control.closest('.topup__field')?.classList.toggle('topup__field--invalid', invalid)
    if (errorEl) errorEl.textContent = message
  }

  /** @returns {string} */
  const loginMessage = () => (login.value.trim() ? '' : 'Введите логин Steam')

  /** @returns {string} */
  const amountMessage = () => (Number(input.value) > 0 ? '' : 'Укажите сумму пополнения')

  const validate = () => {
    const loginMessage_ = loginMessage()
    const amountMessage_ = amountMessage()

    mark(login, loginError, loginMessage_)
    mark(input, amountError, amountMessage_)

    if (loginMessage_) {
      login.focus()
    } else if (amountMessage_) {
      input.focus()
    }

    return !loginMessage_ && !amountMessage_
  }

  let currency = 'USD'

  const render = () => {
    const sign = SYMBOLS[currency] ?? ''

    if (symbol) symbol.textContent = sign
    if (icon) icon.textContent = sign
    if (submit) submit.textContent = input.value ? `Оплатить ${input.value}${sign}` : 'Оплатить'

    options.forEach((option) => {
      option.setAttribute(
        'aria-pressed',
        String(option instanceof HTMLElement && option.dataset.currencyOption === currency)
      )
    })

    resize(input, ruler)
  }

  const ruler = document.createElement('span')
  ruler.className = 'topup__ruler'
  ruler.setAttribute('aria-hidden', 'true')
  input.after(ruler)

  const field = input.closest('.topup__field')

  field?.addEventListener('pointerdown', (event) => {
    const target = event.target
    if (target instanceof Element && target.closest('button, input, label')) return

    event.preventDefault()
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  })

  input.addEventListener('input', () => {
    const before = input.value
    const filtered = before.replace(/\D/g, '').slice(0, MAX_DIGITS)

    if (filtered !== before) {
      const cursor = input.selectionStart ?? before.length
      const digitsBeforeCursor = before.slice(0, cursor).replace(/\D/g, '').length
      input.value = filtered
      const position = Math.min(digitsBeforeCursor, filtered.length)
      input.setSelectionRange(position, position)
    }

    if (amountError?.textContent) mark(input, amountError, amountMessage())
    render()
  })

  login.addEventListener('input', () => {
    if (loginError?.textContent) mark(login, loginError, loginMessage())
  })

  root.addEventListener('submit', (event) => {
    event.preventDefault()
    validate()
  })

  root.addEventListener('click', (event) => {
    const clicked = event.target
    const target = clicked instanceof Element ? clicked.closest('[data-currency-option]') : null

    if (!(target instanceof HTMLElement) || !target.dataset.currencyOption) return

    currency = target.dataset.currencyOption
    render()
  })

  const initial = options.find((option) => option.getAttribute('aria-pressed') === 'true')

  if (initial instanceof HTMLElement && initial.dataset.currencyOption) {
    currency = initial.dataset.currencyOption
  }

  render()
  document.fonts?.ready.then(render)
}
