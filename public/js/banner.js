const AUTOPLAY_MS = 5000

/** @param {HTMLElement | null} banner */
export function initBanner(banner) {
  if (!banner) return

  const dots = [...banner.querySelectorAll('[data-banner-dot]')].filter(
    (el) => el instanceof HTMLElement
  )
  const prev = banner.querySelector('[data-banner-prev]')
  const next = banner.querySelector('[data-banner-next]')
  if (dots.length === 0) return

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  let index = Math.max(
    dots.findIndex((dot) => dot.classList.contains('banner__dot--active')),
    0
  )
  /** @type {ReturnType<typeof setInterval> | 0} */
  let timer = 0

  const render = () => {
    banner.dataset.slide = String(index)

    dots.forEach((dot, i) => {
      const active = i === index
      dot.classList.toggle('banner__dot--active', active)
      if (active) dot.setAttribute('aria-current', 'true')
      else dot.removeAttribute('aria-current')
    })
  }

  /** @param {number} nextIndex */
  const goTo = (nextIndex) => {
    index = (nextIndex + dots.length) % dots.length
    render()
  }

  const stop = () => {
    if (timer) clearInterval(timer)
    timer = 0
  }

  const start = () => {
    stop()
    if (reduceMotion || document.hidden) return
    timer = setInterval(() => goTo(index + 1), AUTOPLAY_MS)
  }

  dots.forEach((dot, i) => {
    dot.addEventListener('click', () => {
      goTo(i)
      start()
    })
  })

  if (prev instanceof HTMLElement) {
    prev.addEventListener('click', () => {
      goTo(index - 1)
      start()
    })
  }

  if (next instanceof HTMLElement) {
    next.addEventListener('click', () => {
      goTo(index + 1)
      start()
    })
  }

  banner.addEventListener('mouseenter', stop)
  banner.addEventListener('mouseleave', start)
  banner.addEventListener('focusin', stop)
  banner.addEventListener('focusout', start)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop()
    else start()
  })

  render()
  start()
}
