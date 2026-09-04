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

  search.addEventListener('submit', (event) => event.preventDefault())

  overlay?.addEventListener('pointerdown', dismiss)

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') dismiss()
  })
}
