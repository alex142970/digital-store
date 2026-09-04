/**
 * @param {Element | null} toggle
 * @param {HTMLElement | null} menu
 */
export function initCatalogMenu(toggle, menu) {
  if (!toggle || !menu) return

  const header = toggle.closest('.header')
  const main = document.querySelector('main')
  const footer = document.querySelector('footer')

  /**
   * @param {Element} el
   * @returns {el is HTMLElement}
   */
  const isHTMLElement = (el) => el instanceof HTMLElement

  const focusable = () =>
    [...menu.querySelectorAll('a[href], button:not([disabled])')]
      .filter(isHTMLElement)
      .filter((el) => el.offsetParent !== null)

  const trapItems = () => [toggle, ...focusable()].filter(isHTMLElement)

  /** @param {boolean} open */
  const setOpen = (open) => {
    if (open && header) menu.style.top = `${Math.max(header.getBoundingClientRect().bottom, 0)}px`

    menu.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    document.body.classList.toggle('is-locked', open)

    if (main instanceof HTMLElement) main.inert = open
    if (footer instanceof HTMLElement) footer.inert = open

    if (open) focusable()[0]?.focus()
  }

  toggle.addEventListener('click', (event) => {
    event.stopPropagation()
    setOpen(menu.hidden)
  })

  document.addEventListener('click', (event) => {
    if (menu.hidden) return
    if (event.target instanceof Node && menu.contains(event.target)) return
    setOpen(false)
  })

  menu.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return

    const link = event.target.closest('a')
    if (!link) return

    setOpen(false)

    if (link.getAttribute('href') === '#') {
      event.preventDefault()
      if (toggle instanceof HTMLElement) toggle.focus({ preventScroll: true })
    }
  })

  document.addEventListener('keydown', (event) => {
    if (menu.hidden) return

    if (event.key === 'Escape') {
      setOpen(false)
      if (toggle instanceof HTMLElement) toggle.focus({ preventScroll: true })
      return
    }

    if (event.key !== 'Tab') return

    const items = trapItems()
    if (items.length === 0) return

    event.preventDefault()

    const currentIndex = items.findIndex((el) => el === document.activeElement)
    const delta = event.shiftKey ? -1 : 1
    const nextIndex =
      currentIndex === -1
        ? (event.shiftKey ? items.length : 1) - 1
        : (currentIndex + delta + items.length) % items.length

    items[nextIndex]?.focus()
  })
}
