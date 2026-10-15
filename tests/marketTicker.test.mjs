import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateCommodityPrices,
  captureMarketPriceSnapshot,
  getMarketTickerEntries,
  getMarketTickerHistoryStatus,
  loadMarketPriceHistory,
  MARKET_BASELINE_TOLERANCE_MS,
  MARKET_BASELINE_WINDOW_MS,
  MARKET_HISTORY_RETENTION_MS,
  MARKET_SNAPSHOT_INTERVAL_MS,
  saveMarketPriceHistory,
} from '../src/marketTicker.ts'

const quoteRows = [
  { id_commodity: '10', commodity_name: 'Aphorite', id_terminal: 'one', price_buy: 10, price_sell: 30 },
  { id_commodity: '10', commodity_name: 'Aphorite', id_terminal: 'two', price_buy: 20, price_sell: 40 },
  { id_commodity: '10', commodity_name: 'Aphorite', id_terminal: 'three', price_buy: 30, price_sell: 50 },
  { id_commodity: '10', commodity_name: 'Aphorite', id_terminal: 'one', price_buy: 12, price_sell: 0 },
  { id_commodity: '20', commodity_name: 'Bexalite', id_terminal: 'four', price_buy: 0, price_sell: 100 },
  { id_commodity: '20', commodity_name: 'Bexalite', id_terminal: 'four', price_buy: -2, price_sell: 0 },
]

test('aggregates median buy and sell separately and deduplicates terminals', () => {
  const prices = aggregateCommodityPrices(quoteRows)
  assert.equal(prices.length, 2)
  assert.deepEqual(prices[0], { commodityId: '10', commodityName: 'Aphorite', buyPrice: 20, sellPrice: 40 })
  assert.deepEqual(prices[1], { commodityId: '20', commodityName: 'Bexalite', buyPrice: null, sellPrice: 100 })
})

test('computes side-specific 24-hour amount and percent changes', () => {
  const now = 2_000_000_000_000
  const history = [{
    capturedAt: now - MARKET_BASELINE_WINDOW_MS,
    prices: [{ commodityId: '10', commodityName: 'Aphorite', buyPrice: 20, sellPrice: 40 }],
  }]
  const [entry] = getMarketTickerEntries([
    { id_commodity: '10', commodity_name: 'Aphorite', id_terminal: 'current', price_buy: 30, price_sell: 30 },
  ], history, now)
  assert.deepEqual(entry.buyChange, { amount: 10, percent: 50 })
  assert.deepEqual(entry.sellChange, { amount: -10, percent: -25 })
  assert.equal(getMarketTickerHistoryStatus(history, now), 'ready')
})

test('accepts only baselines at or before the 24-hour target and within tolerance', () => {
  const now = 2_000_000_000_000
  const prices = [{ commodityId: '10', commodityName: 'Aphorite', buyPrice: 20, sellPrice: 40 }]
  const acceptable = [{ capturedAt: now - MARKET_BASELINE_WINDOW_MS - MARKET_BASELINE_TOLERANCE_MS, prices }]
  const tooOld = [{ capturedAt: now - MARKET_BASELINE_WINDOW_MS - MARKET_BASELINE_TOLERANCE_MS - 1, prices }]
  const tooRecent = [{ capturedAt: now - MARKET_BASELINE_WINDOW_MS + 1, prices }]
  assert.equal(getMarketTickerHistoryStatus(acceptable, now), 'ready')
  assert.equal(getMarketTickerHistoryStatus(tooOld, now), 'stale')
  assert.equal(getMarketTickerHistoryStatus(tooRecent, now), 'collecting')
})

test('leaves missing or zero baseline sides unavailable', () => {
  const now = 2_000_000_000_000
  const history = [{
    capturedAt: now - MARKET_BASELINE_WINDOW_MS,
    prices: [{ commodityId: '10', commodityName: 'Aphorite', buyPrice: null, sellPrice: 0 }],
  }]
  const [entry] = getMarketTickerEntries([
    { id_commodity: '10', commodity_name: 'Aphorite', id_terminal: 'current', price_buy: 30, price_sell: 30 },
  ], history, now)
  assert.equal(entry.buyChange, null)
  assert.equal(entry.sellChange, null)
})

test('captures no more than one snapshot per interval and prunes old history', () => {
  const now = 2_000_000_000_000
  const oldSnapshot = { capturedAt: now - MARKET_HISTORY_RETENTION_MS - 1, prices: [] }
  const first = captureMarketPriceSnapshot([oldSnapshot], quoteRows, now)
  assert.equal(first.length, 1)
  assert.equal(first[0].capturedAt, now)
  assert.equal(captureMarketPriceSnapshot(first, quoteRows, now + MARKET_SNAPSHOT_INTERVAL_MS - 1).length, 1)
  assert.equal(captureMarketPriceSnapshot(first, quoteRows, now + MARKET_SNAPSHOT_INTERVAL_MS).length, 2)
})

test('persists only validated local snapshot data', () => {
  const originalWindow = globalThis.window
  let stored = JSON.stringify([{ capturedAt: 1, prices: [{ commodityId: '1', commodityName: 'Ore', buyPrice: 10, sellPrice: null }] }])
  globalThis.window = { localStorage: { getItem: () => stored, setItem: (_key, value) => { stored = value } } }
  try {
    assert.equal(loadMarketPriceHistory().length, 1)
    assert.equal(saveMarketPriceHistory(loadMarketPriceHistory()), true)
    assert.equal(JSON.parse(stored).length, 1)
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
})
