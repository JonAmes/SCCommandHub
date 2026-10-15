const crypto = require('node:crypto')

function createGameLogParserState(channel) {
  return { channel, buysByPlayer: new Map(), sellsByPlayer: new Map() }
}

function readTimestamp(line) {
  return line.match(/^<([^>]+)>/)?.[1] ?? new Date().toISOString()
}

function addRequest(queueMap, request) {
  const queue = queueMap.get(request.playerId) ?? []
  queue.push(request)
  if (queue.length > 25) queue.shift()
  queueMap.set(request.playerId, queue)
}

function takeRequest(queueMap, playerId, shopId) {
  const queue = queueMap.get(playerId)
  if (!queue?.length) return null
  const index = shopId ? queue.findIndex((request) => request.shopId === shopId) : 0
  if (index < 0) return null
  const [request] = queue.splice(index, 1)
  if (!queue.length) queueMap.delete(playerId)
  return request
}

function makeTransactionEvent(request, channel, completionLine) {
  const id = crypto.createHash('sha256').update(`${request.timestamp}|${request.playerId}|${request.shopId}|${request.kind}|${request.itemClassGuid}|${request.quantity}|${request.total}`).digest('hex')
  return {
    type: 'transaction',
    id,
    channel,
    kind: request.kind,
    itemName: request.itemName,
    itemClassGuid: request.itemClassGuid,
    quantity: request.quantity,
    unitPrice: request.total / request.quantity,
    total: request.total,
    currency: request.currency,
    shopName: request.shopName,
    recordedAt: request.timestamp,
    confirmedAt: readTimestamp(completionLine),
  }
}

function parseGameLogLines(lines, state) {
  const events = []

  for (const line of lines) {
    const timestamp = readTimestamp(line)
    const buyMatch = line.match(/SendStandardItemBuyRequest> Sending SShopBuyRequest - playerId\[(\d+)\] shopId\[(\d+)\] shopName\[([^\]]*)\] kioskId\[(\d+)\] client_price\[([\d.]+)\] itemClassGUID\[([^\]]+)\] itemName\[([^\]]+)\] quantity\[(\d+)\] currencyType\[([^\]]+)\]/)
    if (buyMatch && buyMatch[9] === 'UEC') {
      const total = Number(buyMatch[5])
      const quantity = Number(buyMatch[8])
      if (Number.isFinite(total) && total > 0 && Number.isInteger(quantity) && quantity > 0) {
        addRequest(state.buysByPlayer, {
          playerId: buyMatch[1], shopId: buyMatch[2], shopName: buyMatch[3], total, quantity,
          itemClassGuid: buyMatch[6], itemName: buyMatch[7], currency: buyMatch[9], kind: 'buy', timestamp,
        })
      }
      continue
    }

    const sellMatch = line.match(/SendShopSellRequest> Sending SShopSellRequest - playerId\[(\d+)\] shopId\[(\d+)\] shopName\[([^\]]*)\] kioskId\[(\d+)\] client_price\[([\d.]+)\] itemClassGUID\[([^\]]+)\] itemName\[([^\]]+)\] quantity\[(\d+)\]/)
    if (sellMatch) {
      const total = Number(sellMatch[5])
      const quantity = Number(sellMatch[8])
      if (Number.isFinite(total) && total > 0 && Number.isInteger(quantity) && quantity > 0) {
        addRequest(state.sellsByPlayer, {
          playerId: sellMatch[1], shopId: sellMatch[2], shopName: sellMatch[3], total, quantity,
          itemClassGuid: sellMatch[6], itemName: sellMatch[7], currency: 'UEC', kind: 'sell', timestamp,
        })
      }
      continue
    }

    const buyResponse = line.match(/RmShopFlowResponse> Shop Flow Response - playerId\[(\d+)\] result\[([^\]]+)\]/)
    if (buyResponse) {
      if (buyResponse[2] === 'Success') {
        const request = takeRequest(state.buysByPlayer, buyResponse[1])
        if (request) events.push(makeTransactionEvent(request, state.channel, line))
      } else {
        takeRequest(state.buysByPlayer, buyResponse[1])
      }
      continue
    }

    const sellResponse = line.match(/Received ShopFlowResponse - playerId\[(\d+)\] shopId\[(\d+)\].*result\[([^\]]+)\] type\[Selling\]/)
    if (sellResponse) {
      const request = takeRequest(state.sellsByPlayer, sellResponse[1], sellResponse[2])
      if (request && sellResponse[3] === 'Success') events.push(makeTransactionEvent(request, state.channel, line))
      continue
    }

    const shipMatch = line.match(/Vehicle Control Flow.*Local client node \[(\d+)\] releasing control token for '([A-Z0-9]+(?:_[A-Z0-9]+)+)_(\d+)'/i)
    if (shipMatch) {
      const modelSlug = shipMatch[2]
      const id = crypto.createHash('sha256').update(`${timestamp}|${shipMatch[1]}|${modelSlug}|${shipMatch[3]}`).digest('hex')
      events.push({ type: 'ship', id, channel: state.channel, modelSlug, recordedAt: timestamp })
    }
  }

  return events
}

module.exports = { createGameLogParserState, parseGameLogLines }
