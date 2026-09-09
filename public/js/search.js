/**
 * @param {Element | null} search
 * @param {Element | null} overlay
 */
export function initSearch(search, overlay) {
  if (!search) return

  const dismiss = () => {
    const active = document.activeElement
    if (active instanceof HTMLElement && search.contains(active)) active.blur()
  }

  search.addEventListener('submit', (event) => {
    event.preventDefault()

    const field = search.querySelector('input[type="search"]')
    const term = field instanceof HTMLInputElement ? field.value.trim() : ''
    const params = new URLSearchParams(term ? { q: term } : {})

    window.location.href = `/search.html${params.size > 0 ? `?${params}` : ''}`
  })

  overlay?.addEventListener('pointerdown', dismiss)

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') dismiss()
  })
}
