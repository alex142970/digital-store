const OFFLINE_HINT_MS = 4000
const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 15000

/** @type {Set<(sku: string | null) => void>} */
const listeners = new Set()

/** @param {(sku: string | null) => void} handler */
export function onCatalogChange(handler) {
  listeners.add(handler)
  return () => listeners.delete(handler)
}

/** @param {string | null} sku */
function notify(sku) {
  listeners.forEach((handler) => handler(sku))
}

export function initLive() {
  /** @type {EventSource | null} */
  let source = null
  let offlineTimer = 0
  let reconnectTimer = 0
  let backoff = RECONNECT_MIN_MS

  /** @param {'online' | 'offline'} state */
  const setState = (state) => {
    document.documentElement.dataset.live = state
  }

  const markOffline = () => {
    if (offlineTimer) return
    offlineTimer = window.setTimeout(() => {
      offlineTimer = 0
      setState('offline')
    }, OFFLINE_HINT_MS)
  }

  const reconnect = () => {
    if (reconnectTimer) return

    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = 0
      connect()
    }, backoff)

    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
  }

  const connect = () => {
    source?.close()
    source = new EventSource('/api/events')

    source.addEventListener('open', () => {
      window.clearTimeout(offlineTimer)
      offlineTimer = 0
      backoff = RECONNECT_MIN_MS
      setState('online')
      notify(null)
    })

    source.addEventListener('catalog', (event) => {
      try {
        const payload = JSON.parse(event.data)
        if (typeof payload.sku === 'string') notify(payload.sku)
      } catch {
        notify(null)
      }
    })

    source.addEventListener('resync', () => notify(null))

    source.addEventListener('error', () => {
      markOffline()

      if (source?.readyState === EventSource.CLOSED) reconnect()
    })
  }

  setState('offline')

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return

    notify(null)
    if (source?.readyState === EventSource.CLOSED) reconnect()
  })

  window.addEventListener('online', () => {
    notify(null)
    if (source?.readyState === EventSource.CLOSED) reconnect()
  })

  connect()
}
