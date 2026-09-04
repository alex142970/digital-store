/**
 * @param {string} selector
 * @param {string} activeClass
 * @param {string} attr
 * @param {boolean} alwaysPresent
 */
function initExclusiveToggle(selector, activeClass, attr, alwaysPresent) {
  const items = [...document.querySelectorAll(selector)]
  if (items.length < 2) return

  items.forEach((item) => {
    item.addEventListener('click', () => {
      items.forEach((other) => {
        const active = other === item
        other.classList.toggle(activeClass, active)

        if (active || alwaysPresent) other.setAttribute(attr, String(active))
        else other.removeAttribute(attr)
      })
    })
  })
}

export function initToggleGroups() {
  initExclusiveToggle('.tabs .tab', 'tab--active', 'aria-pressed', true)
  initExclusiveToggle(
    '.catalog__groups .catalog__group',
    'catalog__group--active',
    'aria-current',
    false
  )
}
