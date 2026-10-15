const storageKey = 'sc-command-hub.game-log-v1'

export type PendingGameTransaction = {
  id: string
  channel: 'LIVE' | 'PTU'
  kind: 'buy' | 'sell'
  itemName: string
  itemClassGuid: string
  quantity: number
  unitPrice: number
  total: number
  currency: string
  shopName: string
  recordedAt: string
  confirmedAt: string
}

export type GameLogState = {
  pendingTransactions: PendingGameTransaction[]
  processedEventIds: string[]
  resolvedEventIds?: string[]
}

const emptyState = (): GameLogState => ({ pendingTransactions: [], processedEventIds: [] })

function isPendingGameTransaction(value: unknown): value is PendingGameTransaction {
  if (!value || typeof value !== 'object') return false
  const transaction = value as Partial<PendingGameTransaction>
  return typeof transaction.id === 'string'
    && (transaction.channel === 'LIVE' || transaction.channel === 'PTU')
    && (transaction.kind === 'buy' || transaction.kind === 'sell')
    && typeof transaction.itemName === 'string'
    && typeof transaction.itemClassGuid === 'string'
    && Number.isInteger(transaction.quantity) && (transaction.quantity ?? 0) > 0
    && Number.isFinite(transaction.unitPrice) && (transaction.unitPrice ?? 0) > 0
    && Number.isFinite(transaction.total) && (transaction.total ?? 0) > 0
    && typeof transaction.currency === 'string'
    && typeof transaction.shopName === 'string'
    && typeof transaction.recordedAt === 'string'
    && typeof transaction.confirmedAt === 'string'
}

export function loadGameLogState(): GameLogState {
  try {
    const stored = window.localStorage.getItem(storageKey)
    if (!stored) return emptyState()
    const parsed: unknown = JSON.parse(stored)
    if (!parsed || typeof parsed !== 'object') return emptyState()
    const value = parsed as Partial<GameLogState>
    return {
      pendingTransactions: Array.isArray(value.pendingTransactions) ? value.pendingTransactions.filter(isPendingGameTransaction) : [],
      processedEventIds: Array.isArray(value.processedEventIds)
        ? value.processedEventIds.filter((id): id is string => typeof id === 'string').slice(-2000)
        : [],
      resolvedEventIds: Array.isArray(value.resolvedEventIds)
        ? value.resolvedEventIds.filter((id): id is string => typeof id === 'string').slice(-2000)
        : [],
    }
  } catch {
    return emptyState()
  }
}

export function saveGameLogState(state: GameLogState) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

export function queueGameLogTransaction(state: GameLogState, transaction: PendingGameTransaction): GameLogState {
  if (state.processedEventIds.includes(transaction.id) || state.resolvedEventIds?.includes(transaction.id)) return state
  return {
    pendingTransactions: [...state.pendingTransactions, transaction].slice(-250),
    processedEventIds: [...state.processedEventIds, transaction.id].slice(-2000),
  }
}

export function removePendingGameTransaction(state: GameLogState, transactionId: string): GameLogState {
  return {
    ...state,
    pendingTransactions: state.pendingTransactions.filter((transaction) => transaction.id !== transactionId),
    resolvedEventIds: [...new Set([...(state.resolvedEventIds ?? []), transactionId])].slice(-2000),
  }
}

export function getProcessedGameEventIds(state: GameLogState) {
  return new Set(state.processedEventIds)
}
