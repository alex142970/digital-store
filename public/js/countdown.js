const TICK_MS = 250
const URGENT_MS = 60_000

/** @param {number} ms */
function clock(ms) {
  const total = Math.ceil(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const tail = `${String(minutes).padStart(hours > 0 ? 2 : 1, '0')}:${String(seconds).padStart(2, '0')}`

  return hours > 0 ? `${hours}:${tail}` : tail
}

/**
 *
 * @param {object} options
 * @param {HTMLElement} options.box
 * @param {HTMLElement} options.value
 * @param {number} options.remainingMs
 * @param {() => void} options.onExpire
 * @returns {() => void}
 */
export function startCountdown({ box, value, remainingMs, onExpire }) {
  const startedAt = performance.now()
  const deadline = Date.now() + remainingMs
  let timer = 0
  let expired = false

  const stop = () => {
    window.clearInterval(timer)
    timer = 0
  }

  const tick = () => {
    const left = Math.min(remainingMs - (performance.now() - startedAt), deadline - Date.now())

    if (left <= 0) {
      if (expired) return
      expired = true

      stop()
      box.dataset.state = 'expired'
      value.textContent = '0:00'
      queueMicrotask(onExpire)
      return
    }

    box.dataset.state = left <= URGENT_MS ? 'urgent' : 'active'
    value.textContent = clock(left)
  }

  tick()

  if (!expired) {
    timer = window.setInterval(tick, TICK_MS)
  }

  return stop
}
