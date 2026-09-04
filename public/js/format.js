/**
 * @param {number} value
 * @param {string} currency
 */
export const formatPrice = (value, currency) => {
  try {
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0
    }).format(value)
  } catch {
    return `${value} ${currency}`
  }
}

/** @param {unknown} error */
export const describe = (error) => (error instanceof Error ? error.message : String(error))
