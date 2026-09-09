import { createHash } from 'node:crypto'

export type BulkProduct = {
  sku: string
  name: string
  type: string
  price: number
  currency: string
}

const GAMES = [
  'Counter-Strike 2',
  'Dota 2',
  'PUBG',
  'Escape from Tarkov',
  'Valorant',
  'Genshin Impact',
  'Apex Legends',
  'Rust',
  'Warframe',
  'Path of Exile',
  'World of Tanks',
  'War Thunder',
  'Fortnite',
  'Minecraft',
  'Roblox',
  'GTA V',
  'Red Dead Redemption 2',
  'Cyberpunk 2077',
  'Baldurs Gate 3',
  'Elden Ring',
  'Hogwarts Legacy',
  'Starfield',
  'Palworld',
  'Helldivers 2',
  'Sea of Thieves',
  'Rainbow Six Siege',
  'Overwatch 2',
  'Team Fortress 2',
  'Left 4 Dead 2',
  'Terraria'
]

const SERVICES = [
  'Steam',
  'Xbox Game Pass',
  'PlayStation Plus',
  'Nintendo Switch Online',
  'Discord Nitro',
  'Spotify Premium',
  'YouTube Premium',
  'Netflix',
  'Telegram Premium',
  'ChatGPT Plus',
  'Battle.net',
  'Epic Games',
  'GOG',
  'Origin'
]

const KEY_KINDS = ['ключ активации', 'лицензионный ключ', 'ключ для Steam', 'предзаказ']
const SUB_KINDS = [
  'подписка 1 месяц',
  'подписка 3 месяца',
  'подписка 6 месяцев',
  'подписка 12 месяцев'
]
const TOPUP_AMOUNTS = [300, 500, 1000, 1500, 2500, 5000]
const GIFT_AMOUNTS = [500, 1000, 1500, 3000, 5000]

const priceFor = (sku: string, base: number, spread: number): number => {
  const digest = createHash('sha256').update(sku).digest()
  return base + ((digest.at(0) ?? 0) % spread) * 10
}

const slug = (value: string): string =>
  value
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toUpperCase()
    .slice(0, 20)

export function bulkCatalog(size: number): BulkProduct[] {
  const items: BulkProduct[] = []
  const seen = new Set<string>()

  const push = (sku: string, name: string, type: string, price: number) => {
    if (items.length >= size || seen.has(sku)) return
    seen.add(sku)
    items.push({ sku, name, type, price, currency: 'RUB' })
  }

  KEY_KINDS.forEach((kind, variant) => {
    for (const game of GAMES) {
      const sku = `BULK-KEY-${slug(game)}-${variant + 1}`
      push(sku, `${game} — ${kind}`, 'key', priceFor(sku, 490, 260))
    }
  })

  SUB_KINDS.forEach((kind, variant) => {
    for (const service of SERVICES) {
      const sku = `BULK-SUB-${slug(service)}-${variant + 1}`
      push(sku, `${service} — ${kind}`, 'subscription', priceFor(sku, 290, 180))
    }
  })

  for (const amount of TOPUP_AMOUNTS) {
    for (const service of SERVICES) {
      const sku = `BULK-TOP-${slug(service)}-${amount}`
      push(sku, `Пополнение ${service} ${amount} ₽`, 'topup', amount)
    }
  }

  for (const amount of GIFT_AMOUNTS) {
    for (const service of SERVICES) {
      const sku = `BULK-GIFT-${slug(service)}-${amount}`
      push(sku, `Подарочная карта ${service} ${amount} ₽`, 'giftcard', amount)
    }
  }

  for (let edition = 2; items.length < size; edition += 1) {
    const before = items.length

    for (const game of GAMES) {
      const sku = `BULK-ED${edition}-${slug(game)}`
      push(sku, `${game} — издание ${edition}`, 'key', priceFor(sku, 690, 320))
    }

    for (const service of SERVICES) {
      const sub = `BULK-SUBED${edition}-${slug(service)}`
      push(
        sub,
        `${service} — расширенная подписка ${edition}`,
        'subscription',
        priceFor(sub, 390, 240)
      )

      const gift = `BULK-GIFTED${edition}-${slug(service)}`
      push(
        gift,
        `Подарочная карта ${service}, набор ${edition}`,
        'giftcard',
        priceFor(gift, 990, 400)
      )
    }

    if (items.length === before) break
  }

  return items
}
