import type { CrewState } from './crew'
import type { BankAccount, FinanceState, LedgerEntry } from './finance'
import type { HangarState } from './hangar'
import type { GameLogState, PendingGameTransaction } from './gameLog'
import type { MiningOpsState } from './miningOps'
import type { PlannedRoute } from './routePlanner'

export type SyncSnapshot = {
  schemaVersion: 1
  exportedAt: string
  data: {
    finance: FinanceState
    hangar: HangarState
    crew: CrewState
    routes: PlannedRoute[]
    miningOps: MiningOpsState
    gameLog: GameLogState
    marketPriceHistory: MarketPriceSnapshot[]
    systemIndexSnapshot: { locationKeys: string[]; newLocationKeys: string[] } | null
    preferences: {
      theme: 'field' | 'amber' | 'ice' | 'night' | 'redshift'
      gameChannel: 'LIVE' | 'PTU'
      workspaceMode: 'personal' | 'organization' | null
    }
  }
}

export type SyncProposal = {
  id: string
  clientName: string
  receivedAt: string
  snapshot: SyncSnapshot
}

type MergeCategory = 'accounts' | 'ledger' | 'ships' | 'ship cargo' | 'crew members' | 'crew roles' | 'routes' | 'mining scans' | 'pending Game.log events' | 'market history'
export type MarketPriceSnapshot = { capturedAt: number; prices: { commodityId: string; commodityName: string; buyPrice: number | null; sellPrice: number | null }[] }
type MergeStats = Record<MergeCategory, { added: number; duplicates: number; conflicts: number }>

export type SyncMergePreview = {
  snapshot: SyncSnapshot
  stats: MergeStats
  conflicts: string[]
  accountBalanceChanges: { accountId: string; accountName: string; previousBalance: number | null; nextBalance: number }[]
}

const categories: MergeCategory[] = ['accounts', 'ledger', 'ships', 'ship cargo', 'crew members', 'crew roles', 'routes', 'mining scans', 'pending Game.log events', 'market history']

function emptyStats(): MergeStats {
  return Object.fromEntries(categories.map((category) => [category, { added: 0, duplicates: 0, conflicts: 0 }])) as MergeStats
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function mergeRecords<T>(primary: T[], incoming: T[], getId: (item: T) => string, category: MergeCategory, stats: MergeStats, conflicts: string[]) {
  const merged = [...primary]
  const indices = new Map(merged.map((item, index) => [getId(item), index]))
  for (const item of incoming) {
    const id = getId(item)
    const existingIndex = indices.get(id)
    if (existingIndex === undefined) {
      indices.set(id, merged.length)
      merged.push(item)
      stats[category].added += 1
    } else if (sameValue(merged[existingIndex], item)) {
      stats[category].duplicates += 1
    } else {
      stats[category].conflicts += 1
      conflicts.push(`${category}: matching ID ${id}; kept the primary record.`)
    }
  }
  return merged
}

function getGameTransactionEventId(entry: LedgerEntry) {
  return entry.sourceEventId || entry.id
}

function mergeAccounts(primary: BankAccount[], incoming: BankAccount[], stats: MergeStats, conflicts: string[]) {
  const accounts = [...primary]
  const accountMap = new Map<string, BankAccount>()
  for (const account of incoming) {
    const idMatch = primary.find((item) => item.id === account.id)
    if (idMatch) {
      accountMap.set(account.id, idMatch)
      if (sameValue(idMatch, account)) stats.accounts.duplicates += 1
      else {
        stats.accounts.conflicts += 1
        conflicts.push(`accounts: ${account.name} has a different balance or metadata; kept the primary account.`)
      }
      continue
    }

    const nameMatch = primary.find((item) => item.name.trim().toLocaleLowerCase() === account.name.trim().toLocaleLowerCase())
    if (nameMatch) {
      accountMap.set(account.id, nameMatch)
      stats.accounts.conflicts += 1
      conflicts.push(`accounts: ${account.name} has different IDs on each device; linked incoming activity to the primary account.`)
      continue
    }

    accountMap.set(account.id, account)
    accounts.push(account)
    stats.accounts.added += 1
  }
  return { accounts, accountMap }
}

function getLogEventsFromConfirmedClientTransactions(entries: LedgerEntry[]): PendingGameTransaction[] {
  return entries.flatMap((entry) => {
    if (entry.side !== 'game_purchase' && entry.side !== 'game_sale') return []
    if (!entry.sourceEventId) return []
    const channel = /Game\.log\s+(LIVE|PTU)/.exec(entry.note)?.[1]
    if (channel !== 'LIVE' && channel !== 'PTU') return []
    const itemClassGuid = /·\s*([^·]+)$/.exec(entry.note)?.[1]?.trim() ?? 'unknown'
    return [{
      id: entry.sourceEventId,
      channel,
      kind: entry.side === 'game_purchase' ? 'buy' : 'sell',
      itemName: entry.commodity,
      itemClassGuid,
      quantity: entry.quantity,
      unitPrice: entry.unitPrice,
      total: entry.total,
      currency: 'UEC',
      shopName: entry.terminal,
      recordedAt: entry.recordedAt,
      confirmedAt: entry.recordedAt,
    }]
  })
}

export function validateSyncSnapshot(value: unknown): value is SyncSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<SyncSnapshot>
  const data = snapshot.data
  if (snapshot.schemaVersion !== 1 || typeof snapshot.exportedAt !== 'string' || !data || typeof data !== 'object') return false
  if (!data.finance || !Array.isArray(data.finance.accounts) || !Array.isArray(data.finance.transactions)) return false
  if (!data.hangar || !Array.isArray(data.hangar.ships) || !data.hangar.cargoByShip || typeof data.hangar.cargoByShip !== 'object') return false
  if (!data.crew || !Array.isArray(data.crew.members) || !Array.isArray(data.crew.roles)) return false
  if (!Array.isArray(data.routes) || !data.miningOps || !Array.isArray(data.miningOps.scans)) return false
  if (!data.gameLog || !Array.isArray(data.gameLog.pendingTransactions) || !Array.isArray(data.gameLog.processedEventIds)) return false
  if (data.gameLog.resolvedEventIds !== undefined && !Array.isArray(data.gameLog.resolvedEventIds)) return false
  if (!Array.isArray(data.marketPriceHistory) || data.marketPriceHistory.length > 300) return false
  if (data.marketPriceHistory.some((snapshot) => !Number.isFinite(snapshot.capturedAt) || !Array.isArray(snapshot.prices) || snapshot.prices.length > 1000)) return false
  if (data.systemIndexSnapshot !== null && (!data.systemIndexSnapshot || !Array.isArray(data.systemIndexSnapshot.locationKeys) || !Array.isArray(data.systemIndexSnapshot.newLocationKeys))) return false
  if (data.finance.accounts.length > 500 || data.finance.transactions.length > 10000 || data.hangar.ships.length > 1000) return false
  if (data.crew.members.length > 1000 || data.crew.roles.length > 500 || data.routes.length > 2000) return false
  if (data.miningOps.scans.length > 5000 || data.gameLog.pendingTransactions.length > 2000 || data.gameLog.processedEventIds.length > 20000) return false
  const isObject = (item: unknown): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item))
  const hasId = (item: unknown) => isObject(item) && typeof item.id === 'string' && Boolean(item.id)
  if (!data.finance.accounts.every((account) => hasId(account) && typeof account.name === 'string' && Number.isFinite(account.balance))) return false
  if (!data.finance.transactions.every((entry) => hasId(entry) && typeof entry.accountId === 'string' && typeof entry.accountName === 'string' && typeof entry.commodity === 'string' && typeof entry.terminal === 'string' && typeof entry.note === 'string' && typeof entry.recordedAt === 'string' && Number.isFinite(entry.total) && Number.isFinite(entry.quantity) && Number.isFinite(entry.unitPrice))) return false
  if (!data.hangar.ships.every((ship) => hasId(ship) && typeof ship.vehicleId === 'string' && typeof ship.name === 'string' && typeof ship.manufacturer === 'string' && Number.isFinite(ship.cargoCapacity))) return false
  if (!Object.entries(data.hangar.cargoByShip).every(([shipId, cargo]) => typeof shipId === 'string' && isObject(cargo) && Object.values(cargo).every((quantity) => typeof quantity === 'number' && Number.isFinite(quantity) && quantity >= 0))) return false
  if (!data.crew.members.every((member) => hasId(member) && typeof member.name === 'string' && typeof member.sharePercent === 'number' && Number.isFinite(member.sharePercent) && member.sharePercent >= 0 && member.sharePercent <= 100)) return false
  if (!data.crew.roles.every((role) => hasId(role) && typeof role.name === 'string' && typeof role.defaultSharePercent === 'number' && Number.isFinite(role.defaultSharePercent) && role.defaultSharePercent >= 0 && role.defaultSharePercent <= 100)) return false
  if (!data.routes.every((route) => hasId(route) && typeof route.commodity === 'string' && typeof route.buyTerminalId === 'string' && typeof route.sellTerminalId === 'string' && typeof route.quantity === 'number' && Number.isFinite(route.quantity))) return false
  if (!data.miningOps.scans.every((scan) => hasId(scan) && typeof scan.label === 'string' && typeof scan.location === 'string' && typeof scan.massKg === 'number' && Number.isFinite(scan.massKg) && Array.isArray(scan.composition))) return false
  if (!data.gameLog.pendingTransactions.every((event) => hasId(event) && (event.channel === 'LIVE' || event.channel === 'PTU') && (event.kind === 'buy' || event.kind === 'sell') && typeof event.itemName === 'string' && typeof event.itemClassGuid === 'string' && typeof event.quantity === 'number' && Number.isInteger(event.quantity) && event.quantity > 0 && typeof event.total === 'number' && Number.isFinite(event.total) && event.total > 0)) return false
  if (!data.gameLog.processedEventIds.every((id) => typeof id === 'string')) return false
  if (data.gameLog.resolvedEventIds !== undefined && (!Array.isArray(data.gameLog.resolvedEventIds) || !data.gameLog.resolvedEventIds.every((id) => typeof id === 'string'))) return false
  if (data.marketPriceHistory.some((snapshot) => snapshot.prices.some((price) => typeof price.commodityId !== 'string' || typeof price.commodityName !== 'string' || (price.buyPrice !== null && (typeof price.buyPrice !== 'number' || !Number.isFinite(price.buyPrice) || price.buyPrice <= 0)) || (price.sellPrice !== null && (typeof price.sellPrice !== 'number' || !Number.isFinite(price.sellPrice) || price.sellPrice <= 0))))) return false
  if (data.systemIndexSnapshot !== null && (!data.systemIndexSnapshot.locationKeys.every((key) => typeof key === 'string') || !data.systemIndexSnapshot.newLocationKeys.every((key) => typeof key === 'string'))) return false
  if (!data.preferences || !['field', 'amber', 'ice', 'night', 'redshift'].includes(data.preferences.theme)) return false
  if (data.preferences.gameChannel !== 'LIVE' && data.preferences.gameChannel !== 'PTU') return false
  return true
}

export function previewSyncMerge(primary: SyncSnapshot, incoming: SyncSnapshot): SyncMergePreview {
  const stats = emptyStats()
  const conflicts: string[] = []
  const { accounts, accountMap } = mergeAccounts(primary.data.finance.accounts, incoming.data.finance.accounts, stats, conflicts)
  const incomingLedgerTransactions = incoming.data.finance.transactions
    .filter((entry) => entry.side !== 'game_purchase' && entry.side !== 'game_sale')
    .flatMap((entry) => {
      const sourceAccount = accountMap.get(entry.accountId)
      if (!sourceAccount) {
        stats.ledger.conflicts += 1
        conflicts.push(`ledger: ${entry.commodity} refers to a missing client account; skipped.`)
        return []
      }
      const remapAccountId = (id: string | undefined) => id ? accountMap.get(id)?.id ?? id : id
      const remapAccountName = (id: string | undefined, fallback: string | undefined) => id ? accountMap.get(id)?.name ?? fallback : fallback
      return [{
        ...entry,
        accountId: sourceAccount.id,
        accountName: sourceAccount.name,
        ...(entry.transferToAccountId ? {
          transferToAccountId: remapAccountId(entry.transferToAccountId),
          transferToAccountName: remapAccountName(entry.transferToAccountId, entry.transferToAccountName),
        } : {}),
        ...(entry.crewShares ? { crewShares: entry.crewShares.map((share) => ({
          ...share,
          accountId: remapAccountId(share.accountId),
          accountName: remapAccountName(share.accountId, share.accountName),
        })) } : {}),
      }]
    })
  const primaryLedgerIds = new Set(primary.data.finance.transactions.map(getGameTransactionEventId))
  const newIncomingTransactions = incomingLedgerTransactions.filter((entry) => !primaryLedgerIds.has(getGameTransactionEventId(entry)))
  const financeTransactions = mergeRecords(primary.data.finance.transactions, incomingLedgerTransactions, getGameTransactionEventId, 'ledger', stats, conflicts)
  const ledgerIdMap = new Map<string, string>()
  for (const entry of incoming.data.finance.transactions) {
    const mergedEntry = financeTransactions.find((item) => getGameTransactionEventId(item) === getGameTransactionEventId(entry))
    if (mergedEntry) {
      ledgerIdMap.set(entry.id, mergedEntry.id)
      if (entry.sourceEventId) ledgerIdMap.set(entry.sourceEventId, mergedEntry.id)
    }
  }
  const primaryAccountIds = new Set(primary.data.finance.accounts.map((account) => account.id))
  const accountDeltas = new Map<string, number>()
  const addAccountDelta = (accountId: string | undefined, amount: number) => {
    if (!accountId || !Number.isFinite(amount)) return
    accountDeltas.set(accountId, (accountDeltas.get(accountId) ?? 0) + amount)
  }
  for (const entry of newIncomingTransactions) {
    if (entry.side === 'buy' || entry.side === 'withdrawal' || entry.side === 'vehicle_purchase') {
      addAccountDelta(entry.accountId, -entry.total)
    } else if (entry.side === 'deposit') {
      addAccountDelta(entry.accountId, entry.total)
    } else if (entry.side === 'transfer') {
      addAccountDelta(entry.accountId, -entry.total)
      addAccountDelta(entry.transferToAccountId, entry.total)
    } else if (entry.side === 'sell') {
      const ownCrewPayout = (entry.crewShares ?? []).filter((share) => share.accountId === entry.accountId).reduce((sum, share) => sum + share.amount, 0)
      addAccountDelta(entry.accountId, entry.total - (entry.crewShareTotal ?? 0) + ownCrewPayout)
      for (const share of entry.crewShares ?? []) {
        if (share.accountId !== entry.accountId) addAccountDelta(share.accountId, share.amount)
      }
    }
  }
  const accountsWithTransactions = accounts.map((account) => {
    if (!primaryAccountIds.has(account.id)) return account
    const delta = accountDeltas.get(account.id) ?? 0
    return delta ? { ...account, balance: Math.round((account.balance + delta) * 100) / 100 } : account
  })
  const primaryAccountsById = new Map(primary.data.finance.accounts.map((account) => [account.id, account]))
  const accountBalanceChanges = accountsWithTransactions.flatMap((account) => {
    const previousBalance = primaryAccountsById.get(account.id)?.balance ?? null
    if (previousBalance === account.balance) return []
    return [{ accountId: account.id, accountName: account.name, previousBalance, nextBalance: account.balance }]
  })
  const incomingConfirmedGameEvents = getLogEventsFromConfirmedClientTransactions(incoming.data.finance.transactions)
  const resolvedEventIds = [...new Set(primary.data.gameLog.resolvedEventIds ?? [])].slice(-2000)
  const resolvedSet = new Set(resolvedEventIds)
  const clientDismissedIds = new Set(incoming.data.gameLog.resolvedEventIds ?? [])
  const pendingCandidates = [
    ...incoming.data.gameLog.pendingTransactions.filter((event) => !clientDismissedIds.has(event.id)),
    ...incomingConfirmedGameEvents,
  ].filter((event) => !resolvedSet.has(event.id))
  const pendingGameTransactions = mergeRecords(primary.data.gameLog.pendingTransactions, pendingCandidates, (item) => item.id, 'pending Game.log events', stats, conflicts)
  const confirmedIds = new Set(financeTransactions.map((entry) => entry.sourceEventId).filter((id): id is string => Boolean(id)))
  const usablePendingTransactions = pendingGameTransactions.filter((event) => !confirmedIds.has(event.id) && !resolvedSet.has(event.id))

  const ships = mergeRecords(primary.data.hangar.ships, incoming.data.hangar.ships, (ship) => ship.vehicleId || ship.id, 'ships', stats, conflicts)
  const mergedShipByIdentity = new Map(ships.map((ship) => [ship.vehicleId || ship.id, ship.id]))
  const incomingShipIds = new Map(incoming.data.hangar.ships.map((ship) => [ship.id, mergedShipByIdentity.get(ship.vehicleId || ship.id) ?? ship.id]))
  const cargoByShip = { ...primary.data.hangar.cargoByShip }
  for (const incomingShip of incoming.data.hangar.ships) {
    const incomingCargo = incoming.data.hangar.cargoByShip[incomingShip.id]
    if (!incomingCargo) continue
    const identity = incomingShip.vehicleId || incomingShip.id
    const targetShipId = mergedShipByIdentity.get(identity) ?? incomingShipIds.get(incomingShip.id) ?? incomingShip.id
    if (!ships.some((ship) => ship.id === targetShipId)) continue
    const primaryCargo = cargoByShip[targetShipId] ?? {}
    const mergedCargo = { ...primaryCargo }
    for (const [commodity, quantity] of Object.entries(incomingCargo)) {
      if (mergedCargo[commodity] === undefined) {
        mergedCargo[commodity] = quantity
        stats['ship cargo'].added += 1
      } else if (mergedCargo[commodity] === quantity) {
        stats['ship cargo'].duplicates += 1
      } else {
        stats['ship cargo'].conflicts += 1
        conflicts.push(`ship cargo: ${commodity} differs for ship ${targetShipId}; kept the primary quantity.`)
      }
    }
    cargoByShip[targetShipId] = mergedCargo
  }
  const primaryActiveShipExists = ships.some((ship) => ship.id === primary.data.hangar.activeShipId)
  const incomingActiveShipId = incoming.data.hangar.activeShipId ? incomingShipIds.get(incoming.data.hangar.activeShipId) ?? incoming.data.hangar.activeShipId : null
  const incomingActiveShipExists = ships.some((ship) => ship.id === incomingActiveShipId)
  const activeShipId = primaryActiveShipExists ? primary.data.hangar.activeShipId : incomingActiveShipExists ? incomingActiveShipId : null

  const incomingCrewMembers = incoming.data.crew.members.map((member) => {
    const payoutAccountId = member.payoutAccountId ? accountMap.get(member.payoutAccountId)?.id ?? member.payoutAccountId : member.payoutAccountId
    return { ...member, payoutAccountId }
  })
  const crewMembers = mergeRecords(primary.data.crew.members, incomingCrewMembers, (item) => item.id, 'crew members', stats, conflicts)
  const crewRoles = mergeRecords(primary.data.crew.roles, incoming.data.crew.roles, (item) => item.id, 'crew roles', stats, conflicts)
  const incomingRoutes = incoming.data.routes.map((route) => ({
    ...route,
    buyShipId: route.buyShipId ? incomingShipIds.get(route.buyShipId) ?? route.buyShipId : route.buyShipId,
    buyLedgerEntryId: route.buyLedgerEntryId ? ledgerIdMap.get(route.buyLedgerEntryId) ?? route.buyLedgerEntryId : route.buyLedgerEntryId,
    sellLedgerEntryId: route.sellLedgerEntryId ? ledgerIdMap.get(route.sellLedgerEntryId) ?? route.sellLedgerEntryId : route.sellLedgerEntryId,
  }))
  const routes = mergeRecords(primary.data.routes, incomingRoutes, (item) => item.id, 'routes', stats, conflicts)
  const scans = mergeRecords(primary.data.miningOps.scans, incoming.data.miningOps.scans, (item) => item.id, 'mining scans', stats, conflicts)
  const marketPriceHistory = mergeRecords(primary.data.marketPriceHistory, incoming.data.marketPriceHistory, (snapshot) => String(snapshot.capturedAt), 'market history', stats, conflicts)
    .sort((left, right) => left.capturedAt - right.capturedAt)
    .slice(-300)
  const primaryIndex = primary.data.systemIndexSnapshot
  const incomingIndex = incoming.data.systemIndexSnapshot
  const systemIndexSnapshot = primaryIndex || incomingIndex ? {
    locationKeys: [...new Set([...(primaryIndex?.locationKeys ?? []), ...(incomingIndex?.locationKeys ?? [])])],
    newLocationKeys: [...new Set([...(primaryIndex?.newLocationKeys ?? []), ...(incomingIndex?.newLocationKeys ?? [])])],
  } : null
  const incomingPreferences = incoming.data.preferences
  if (!sameValue(primary.data.preferences, incomingPreferences)) {
    conflicts.push('Preferences differ; kept the primary device preferences.')
  }

  return {
    snapshot: {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      data: {
        finance: { accounts: accountsWithTransactions, transactions: financeTransactions },
        hangar: { ships, activeShipId, cargoByShip },
        crew: { members: crewMembers, roles: crewRoles },
        routes,
        miningOps: { scans },
        gameLog: {
          pendingTransactions: usablePendingTransactions,
          processedEventIds: [...new Set([...primary.data.gameLog.processedEventIds, ...incoming.data.gameLog.processedEventIds])].slice(-20000),
          resolvedEventIds,
        },
        marketPriceHistory,
        systemIndexSnapshot,
        preferences: primary.data.preferences,
      },
    },
    stats,
    conflicts,
    accountBalanceChanges,
  }
}

export function persistSyncSnapshot(snapshot: SyncSnapshot) {
  const profile = snapshot.data.preferences.workspaceMode
    ? { mode: snapshot.data.preferences.workspaceMode, completedAt: new Date().toISOString() }
    : { skipped: true, completedAt: new Date().toISOString() }
  const writes: [string, string][] = [
    ['sc-command-hub.finance-v1', JSON.stringify(snapshot.data.finance)],
    ['sc-command-hub.hangar-v1', JSON.stringify(snapshot.data.hangar)],
    ['sc-command-hub.crew-v1', JSON.stringify(snapshot.data.crew)],
    ['sc-command-hub.route-plans-v1', JSON.stringify(snapshot.data.routes)],
    ['sc-command-hub.mining-ops-v1', JSON.stringify(snapshot.data.miningOps)],
    ['sc-command-hub.game-log-v1', JSON.stringify(snapshot.data.gameLog)],
    ['sc-command-hub.market-price-history-v1', JSON.stringify(snapshot.data.marketPriceHistory.slice(-300))],
    ['sc-command-hub.system-index-v1', JSON.stringify(snapshot.data.systemIndexSnapshot)],
    ['sc-command-hub.theme-v1', snapshot.data.preferences.theme],
    ['sc-command-hub.game-channel-v1', snapshot.data.preferences.gameChannel],
    ['sc-command-hub.setup-profile-v1', JSON.stringify(profile)],
  ]
  let previous: readonly (readonly [string, string | null])[] = []
  try {
    previous = writes.map(([key]) => [key, window.localStorage.getItem(key)] as const)
    for (const [key, value] of writes) window.localStorage.setItem(key, value)
    return true
  } catch {
    for (const [key, value] of previous) {
      try {
        if (value === null) window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, value)
      } catch {}
    }
    return false
  }
}
