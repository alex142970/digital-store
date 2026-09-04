const STORAGE_KEY = 'promo-code'

/** @returns {string} */
export function getPromoCode() {
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

/** @param {string} code */
function remember(code) {
  try {
    if (code) sessionStorage.setItem(STORAGE_KEY, code)
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    return
  }
}

/** @type {(() => void) | null} */
let refresh = null

export function forgetPromoCode() {
  remember('')
  refresh?.()
}

export function initPromo() {
  const toggle = document.querySelector('[data-promo-toggle]')
  const panel = document.querySelector('[data-promo-panel]')
  const input = document.querySelector('[data-promo-input]')
  const apply = document.querySelector('[data-promo-apply]')
  const status = document.querySelector('[data-promo-status]')

  if (
    !(toggle instanceof HTMLButtonElement) ||
    !(panel instanceof HTMLElement) ||
    !(input instanceof HTMLInputElement) ||
    !(apply instanceof HTMLButtonElement) ||
    !(status instanceof HTMLElement)
  ) {
    return
  }

  const render = () => {
    const code = getPromoCode()

    status.textContent = code ? `Промокод ${code} применится при покупке` : ''
    status.dataset.state = code ? 'applied' : ''
    apply.textContent = code ? 'Сбросить' : 'Применить'
    toggle.dataset.applied = code ? 'true' : 'false'
  }

  /** @param {boolean} open */
  const setOpen = (open) => {
    panel.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    if (open) input.focus({ preventScroll: true })
  }

  const submit = () => {
    if (getPromoCode()) {
      forgetPromoCode()
      input.value = ''
      render()
      return
    }

    const code = input.value.trim().toUpperCase()

    if (!code) {
      status.textContent = 'Введите промокод'
      status.dataset.state = 'error'
      input.focus({ preventScroll: true })
      return
    }

    input.value = code
    remember(code)
    render()
  }

  toggle.addEventListener('click', (event) => {
    event.stopPropagation()
    setOpen(panel.hidden)
  })

  apply.addEventListener('click', submit)

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    submit()
  })

  document.addEventListener('click', (event) => {
    if (panel.hidden) return
    if (event.target instanceof Node && panel.contains(event.target)) return
    setOpen(false)
  })

  refresh = () => {
    input.value = getPromoCode()
    render()
  }

  refresh()
}
