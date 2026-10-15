import type { UexRow } from './uex'

const storageKey = 'sc-command-hub.market-price-history-v1'
export const MARKET_SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000
export const MARKET_HISTORY_RETENTION_MS = 72 * 60 * 60 * 1000
export const MARKET_BASELINE_WINDOW_MS = 24 * 60 * 60 * 1000
export const MARKET_BASELINE_TOLERANCE_MS = 30 * 60 * 1000
const MARKET_HISTORY_WINDOW_MS = MARKET_BASELINE_WINDOW_MS
const MARKET_HISTORY_WINDOW_WITH_TOLERANCE_MS = MARKET_HISTORY_WINDOW_MS + MARKET_BASELINE_TOLERANCE_MS
const maxSnapshots = 300

export type MarketPrice = {
  commodityId: string
  commodityName: string
  buyPrice: number | null
  sellPrice: number | null
}

export type MarketPriceSnapshot = {
  capturedAt: number
  prices: MarketPrice[]
}

export type PriceChange = {
  amount: number
  percent: number
}

export type MarketTickerEntry = MarketPrice & {
  buyChange: PriceChange | null
  sellChange: PriceChange | null
}

export type MarketTickerHistoryStatus = 'ready' | 'collecting' | 'stale'

function readText(row: UexRow, key: string) {
  const value = row[key]
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

function readPositivePrice(row: UexRow, key: string) {
  const price = Number(row[key])
  return Number.isFinite(price) && price > 0 ? price : null
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function aggregateCommodityPrices(rows: UexRow[]): MarketPrice[] {
  const grouped = new Map<string, {
    commodityName: string
    buyByTerminal: Map<string, number>
    sellByTerminal: Map<string, number>
  }>()

  rows.forEach((row, index) => {
    const commodityName = readText(row, 'commodity_name')
    if (!commodityName) return
    const commodityId = readText(row, 'id_commodity') || commodityName.toLocaleLowerCase()
    const terminalId = readText(row, 'id_terminal') || readText(row, 'terminal_name') || `row-${index}`
    const group = grouped.get(commodityId) ?? {
      commodityName,
      buyByTerminal: new Map<string, number>(),
      sellByTerminal: new Map<string, number>(),
    }
    const buyPrice = readPositivePrice(row, 'price_buy')
    const sellPrice = readPositivePrice(row, 'price_sell')
    if (buyPrice !== null) group.buyByTerminal.set(terminalId, buyPrice)
    if (sellPrice !== null) group.sellByTerminal.set(terminalId, sellPrice)
    grouped.set(commodityId, group)
  })

  return [...grouped.entries()].map(([commodityId, group]) => ({
    commodityId,
    commodityName: group.commodityName,
    buyPrice: group.buyByTerminal.size ? median([...group.buyByTerminal.values()]) : null,
    sellPrice: group.sellByTerminal.size ? median([...group.sellByTerminal.values()]) : null,
  })).sort((left, right) => left.commodityName.localeCompare(right.commodityName, undefined, { sensitivity: 'base' }))
}

function isMarketPrice(value: unknown): value is MarketPrice {
  if (!value || typeof value !== 'object') return false
  const price = value as Partial<MarketPrice>
  const validSide = (side: unknown) => side === null || (typeof side === 'number' && Number.isFinite(side) && side > 0)
  return typeof price.commodityId === 'string'
    && typeof price.commodityName === 'string'
    && validSide(price.buyPrice)
    && validSide(price.sellPrice)
}

function isSnapshot(value: unknown): value is MarketPriceSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<MarketPriceSnapshot>
  return Number.isFinite(snapshot.capturedAt)
    && Array.isArray(snapshot.prices)
    && snapshot.prices.every(isMarketPrice)
}

export function loadMarketPriceHistory(): MarketPriceSnapshot[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey) || '[]')
    return Array.isArray(parsed) ? parsed.filter(isSnapshot).slice(-maxSnapshots) : []
  } catch {
    return []
  }
}

export function saveMarketPriceHistory(history: MarketPriceSnapshot[]) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(history.slice(-maxSnapshots)))
    return true
  } catch {
    return false
  }
}

export function captureMarketPriceSnapshot(history: MarketPriceSnapshot[], rows: UexRow[], capturedAt = Date.now()): MarketPriceSnapshot[] {
  const retained = history.filter((snapshot) => capturedAt - snapshot.capturedAt <= MARKET_HISTORY_RETENTION_MS)
  const aggregated = aggregateCommodityPrices(rows)
  if (!aggregated.length) return retained
  const latest = retained[retained.length - 1]
  if (latest && capturedAt - latest.capturedAt < MARKET_SNAPSHOT_INTERVAL_MS) return retained
  return [...retained, { capturedAt, prices: aggregated }].slice(-maxSnapshots)
}

function getBaselineSnapshot(history: MarketPriceSnapshot[], now: number) {
  const target = now - MARKET_BASELINE_WINDOW_MS
  return history
    .filter((snapshot) => snapshot.capturedAt <= target && target - snapshot.capturedAt <= MARKET_BASELINE_TOLERANCE_MS)
    .sort((left, right) => right.capturedAt - left.capturedAt)[0]
}

function getChange(current: number | null, baseline: number | null | undefined): PriceChange | null {
  if (current === null || baseline === null || baseline === undefined || baseline <= 0) return null
  const amount = Math.round((current - baseline) * 100) / 100
  return { amount, percent: Math.round((amount / baseline) * 10000) / 100 }
}

export function getMarketTickerHistoryStatus(history: MarketPriceSnapshot[], now = Date.now()): MarketTickerHistoryStatus {
  if (getBaselineSnapshot(history, now)) return 'ready'
  const oldest = history[0]
  return oldest && now - oldest.capturedAt > MARKET_HISTORY_WINDOW_WITH_TOLERANCE_MS ? 'stale' : 'collecting'
}

export function getMarketTickerEntries(rows: UexRow[], history: MarketPriceSnapshot[], now = Date.now()): MarketTickerEntry[] {
  const current = aggregateCommodityPrices(rows)
  const baseline = getBaselineSnapshot(history, now)
  const baselineById = new Map((baseline?.prices ?? []).map((price) => [price.commodityId, price]))
  return current.map((price) => {
    const previous = baselineById.get(price.commodityId)
    return {
      ...price,
      buyChange: getChange(price.buyPrice, previous?.buyPrice),
      sellChange: getChange(price.sellPrice, previous?.sellPrice),
    }
  })
}

