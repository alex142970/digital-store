import { initCatalogMenu } from './catalog-menu.js'
import { initTopup } from './topup.js'
import { initProducts } from './products.js'
import { initSearch } from './search.js'
import { initToggleGroups } from './toggle-groups.js'
import { initBanner } from './banner.js'
import { initPromo } from './promo.js'

initCatalogMenu(
  document.querySelector('[data-catalog-toggle]'),
  document.querySelector('[data-catalog-menu]')
)
initTopup(document.querySelector('[data-topup]'))
initSearch(document.querySelector('.search'), document.querySelector('.overlay'))
initToggleGroups()
initBanner(document.querySelector('[data-banner]'))
initPromo()

document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0) return
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

  const target = event.target
  if (target instanceof Element && target.closest('a[href="#"]')) event.preventDefault()
})

initProducts()
