import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'
import packageMetadata from '../package.json'
import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { previewSyncMerge, persistSyncSnapshot, validateSyncSnapshot, type SyncMergePreview, type SyncProposal, type SyncSnapshot } from './appSync'
import { disconnectSyncClient, getSyncClientPairing, pairSyncClient, uploadSyncSnapshot, type SyncClientPairing } from './syncClient'
import { SyncSettings } from './SyncSettings'
import './App.css'
import { clearUexCache, getUexData, readNumber, readText, type UexRow } from './uex'
import { captureMarketPriceSnapshot, getMarketTickerEntries, getMarketTickerHistoryStatus, loadMarketPriceHistory, MARKET_SNAPSHOT_INTERVAL_MS, saveMarketPriceHistory, type MarketPriceSnapshot, type PriceChange } from './marketTicker'
import { CONTAINER_SIZES, getContainerSelection, isContainerSizedQuantity } from './containerSizes'
import { createBankAccount, getAccountHeldQuantity, getCommodityHoldings, getRealizedProfitLoss, loadFinanceState, previewCrewPayouts, recordAccountAdjustment, recordGameStoreTransaction, recordTrade, recordVehiclePurchase, saveFinanceState, transferFunds, type AccountTransactionKind, type BankAccount, type FinanceState, type GameStoreTransaction, type LedgerEntry, type NewTrade, type TradeSide } from './finance'
import { addDetectedShip, addShip, clearHangarCargo, getAssignedQuantity, getShipCargoQuantity, getShipCargoUsed, getUnassignedQuantity, loadCargo, loadHangarState, removeShip, saveHangarState, setActiveShip, unloadCargo, type HangarShip, type HangarState } from './hangar'
import { addCrewMember, addCrewRole, assignCrewRole, getCrewSharePercent, loadCrewState, removeCrewMember, removeCrewRole, saveCrewState, updateCrewMemberPayoutAccount, updateCrewMemberShare, updateCrewRoleDefault, type CrewMember, type CrewRole, type CrewState } from './crew'
import { clearRoutePlans, createPlannedRoute, loadRoutePlans, saveRoutePlans, type NewPlannedRoute, type PlannedRoute } from './routePlanner'
import { addRockScan, loadMiningOpsState, removeRockScan, saveMiningOpsState, type MiningOpsState, type NewRockScan, type RockScan } from './miningOps'
import { loadGameLogState, queueGameLogTransaction, removePendingGameTransaction, saveGameLogState, type GameLogState, type PendingGameTransaction } from './gameLog'

const tokenKey = 'sc-command-hub.uex-token'
const themeKey = 'sc-command-hub.theme-v1'
const systemIndexKey = 'sc-command-hub.system-index-v1'
const setupProfileKey = 'sc-command-hub.setup-profile-v1'
const gameChannelKey = 'sc-command-hub.game-channel-v1'
const gameRootsKey = 'sc-command-hub.game-roots-v1'

type AppTheme = 'field' | 'amber' | 'ice' | 'night' | 'redshift'
type WorkspaceMode = 'personal' | 'organization'
type Section = 'dashboard' | 'settings' | 'trade' | 'finance' | 'holdings' | 'hangar' | 'crew' | 'routePlanner' | 'commodities' | 'ships' | 'systems' | 'mining' | 'inventory' | 'fuelPrices'
type DatasetKey = 'commodities' | 'terminals' | 'vehicles' | 'star_systems' | 'commodities_prices_all' | 'vehicles_purchases_prices_all' | 'fuel_prices_all' | 'refineries_methods' | 'refineries_yields' | 'refineries_capacities'
type DatasetState = { rows: UexRow[]; status: 'idle' | 'loading' | 'ready' | 'error'; error?: string }
type TradePreset = { side: TradeSide; commodity: string; terminal: string; unitPrice: number; quantity: number; accountId?: string; shipId?: string; note?: string; routePlanId?: string; routeAction?: 'buy' | 'sell' }
type RouteMarketOffer = { terminalId: string; terminalName: string; location: string; buyPrice: number; buyQuantity: number; sellPrice: number; sellStock: number }
type VehiclePurchaseSelection = { vehicle: UexRow; offers: UexRow[] }
type GameChannel = 'LIVE' | 'PTU'
type GameInstallation = { channel: GameChannel; path: string }
type GameScanStatus = 'checking' | 'ready' | 'unavailable' | 'error'
type GameLogStatus = 'idle' | 'watching' | 'waiting' | 'waiting-for-log' | 'installation-not-found' | 'invalid-channel' | 'error' | 'unavailable'
type GameLogEvent = ({ type: 'transaction' } & PendingGameTransaction) | { type: 'ship'; id: string; channel: GameChannel; modelSlug: string; recordedAt: string }
type SyncHostStatus = 'stopped' | 'listening' | 'tailscale-cli-not-found' | 'tailscale-dns-unavailable' | 'serve-error' | 'port-in-use' | 'start-error'
type SyncClientStatus = 'idle' | 'pairing' | 'paired' | 'syncing' | 'uploaded' | 'error'
type SyncHostInfo = { status: SyncHostStatus; address?: string; publicUrl?: string; port?: number; code?: string; expiresAt?: string; detail?: string }
type SyncMergeReview = { proposal: SyncProposal; preview: SyncMergePreview }
type SyncPairRequest = { requestId: string; clientName: string; sourceAddress: string; expiresAt: string }
type SyncPairedClient = { clientId: string; clientName: string; sourceAddress: string; expiresAt: string }

declare global {
  interface Window {
    starCitizenBridge?: {
      detectInstallations?: (customRoots: string[]) => Promise<GameInstallation[]>
      chooseInstallRoot?: () => Promise<string | null>
      watchGameLog?: (channel: GameChannel, customRoots: string[]) => Promise<{ status: GameLogStatus }>
      stopGameLog?: () => Promise<boolean>
      onGameLogEvent?: (callback: (event: GameLogEvent) => void) => () => void
      onGameLogStatus?: (callback: (status: GameLogStatus) => void) => () => void
      startSyncHost?: () => Promise<SyncHostInfo>
      rotateSyncPairingCode?: () => Promise<{ code: string; expiresAt: string } | null>
      stopSyncHost?: () => Promise<boolean>
      listSyncClients?: () => Promise<SyncPairedClient[]>
      revokeSyncClient?: (clientId: string) => Promise<boolean>
      requestSync?: (url: string, data: unknown, token?: string) => Promise<{ status: number; data: unknown }>
      approveSyncPairing?: (requestId: string) => Promise<boolean>
      rejectSyncPairing?: (requestId: string) => Promise<boolean>
      onSyncPairRequest?: (callback: (request: SyncPairRequest) => void) => () => void
      onSyncProposal?: (callback: (proposal: SyncProposal) => void) => () => void
    }
  }
}

function getStoredGameChannel(): GameChannel {
  try {
    return window.localStorage.getItem(gameChannelKey) === 'PTU' ? 'PTU' : 'LIVE'
  } catch {
    return 'LIVE'
  }
}

function getStoredGameRoots() {
  try {
    const roots: unknown = JSON.parse(window.localStorage.getItem(gameRootsKey) || '[]')
    return Array.isArray(roots) ? roots.filter((root): root is string => typeof root === 'string' && root.length < 1024) : []
  } catch {
    return []
  }
}

function findVehicleForGameModel(modelSlug: string, vehicles: UexRow[]) {
  const modelTokens = modelSlug.split('_').slice(1).map((part) => part.toLowerCase())
  return vehicles
    .map((vehicle) => ({ vehicle, tokens: (readText(vehicle, 'name', 'vehicle_name').toLowerCase().match(/[a-z0-9]+/g) ?? []) }))
    .filter(({ tokens }) => tokens.length > 0 && tokens.every((token) => modelTokens.includes(token)))
    .sort((left, right) => right.tokens.length - left.tokens.length)[0]?.vehicle
}

function csvCell(value: string | number | null | undefined) {
  const text = value === null || value === undefined ? '' : String(value)
  const safeText = typeof value === 'string' && /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text
  return `"${safeText.replace(/"/g, '""')}"`
}

function createLedgerCsv(entries: LedgerEntry[], realizedProfitLoss: Map<string, number | null>) {
  const headers = [
    'Recorded At (ISO)', 'Type', 'Commodity / Description', 'Location', 'Quantity (SCU or items)', 'Container Size (SCU)', 'Container Count',
    'Unit Price (aUEC)', 'Account', 'Destination Account', 'Gross (aUEC)', 'Crew Share (aUEC)', 'Crew Payouts',
    'Account Net (aUEC)', 'Realized P&L (aUEC)', 'Note', 'Entry ID',
  ]
  const rows = entries.map((entry) => {
    const isTrade = entry.side === 'buy' || entry.side === 'sell'
    const isGameTransaction = entry.side === 'game_purchase' || entry.side === 'game_sale'
    const accountNet = entry.side === 'sell'
      ? entry.total - (entry.crewShareTotal ?? 0) + (entry.crewShares ?? []).filter((share) => share.accountId === entry.accountId).reduce((sum, share) => sum + share.amount, 0)
      : entry.total
    const description = entry.side === 'transfer' ? 'Account transfer' : entry.side === 'deposit' ? 'Account deposit' : entry.side === 'withdrawal' ? 'Account withdrawal' : entry.side === 'vehicle_purchase' ? `Ship purchase · ${entry.commodity}` : entry.side === 'game_purchase' ? `In-game purchase · ${entry.commodity}` : entry.side === 'game_sale' ? `In-game sale · ${entry.commodity}` : entry.commodity
    const payouts = (entry.crewShares ?? []).map((share) => `${share.memberName} (${share.sharePercent}%): ${share.amount} → ${share.accountName || 'Unassigned'}`).join('; ')
    const realized = entry.side === 'sell'
      ? realizedProfitLoss.get(entry.id) ?? 'Basis unavailable'
      : entry.side === 'buy' ? 'Unrealized' : ''
    return [
      entry.recordedAt,
      entry.side === 'vehicle_purchase' ? 'SHIP' : entry.side.toUpperCase(),
      description,
      entry.terminal,
      isTrade || isGameTransaction ? entry.quantity : '',
      isTrade ? entry.containerSize : '',
      isTrade ? entry.containerCount : '',
      isTrade || isGameTransaction ? entry.unitPrice : '',
      entry.accountName,
      entry.transferToAccountName ?? '',
      entry.side === 'transfer' ? '' : entry.total,
      entry.crewShareTotal,
      payouts,
      accountNet,
      realized,
      entry.note,
      entry.id,
    ]
  })
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}

function getStoredWorkspaceMode(): WorkspaceMode | null {
  try {
    const stored = window.localStorage.getItem(setupProfileKey)
    if (!stored) return null
    const profile = JSON.parse(stored) as { mode?: unknown }
    return profile.mode === 'personal' || profile.mode === 'organization' ? profile.mode : null
  } catch {
    return null
  }
}

function shouldShowFirstRunSetup() {
  if (getStoredWorkspaceMode()) return false
  try {
    const profile = JSON.parse(window.localStorage.getItem(setupProfileKey) || 'null') as { skipped?: unknown } | null
    if (profile?.skipped === true) return false
    const existingDataKeys = [
      tokenKey,
      themeKey,
      'sc-command-hub.finance-v1',
      'sc-command-hub.hangar-v1',
      'sc-command-hub.crew-v1',
      'sc-command-hub.route-plans-v1',
    ]
    return !existingDataKeys.some((key) => window.localStorage.getItem(key) !== null)
  } catch {
    return false
  }
}

const vehicleTypeFlags: [string, string][] = [
  ['Spaceship', 'is_spaceship'], ['Ground vehicle', 'is_ground_vehicle'], ['Civilian', 'is_civilian'], ['Military', 'is_military'], ['Starter', 'is_starter'],
  ['Cargo', 'is_cargo'], ['Carrier', 'is_carrier'], ['Passenger', 'is_passenger'], ['Bomber', 'is_bomber'], ['Interdiction', 'is_interdiction'],
  ['Exploration', 'is_exploration'], ['Racing', 'is_racing'], ['Industrial', 'is_industrial'], ['Construction', 'is_construction'], ['Mining', 'is_mining'],
  ['Refinery', 'is_refinery'], ['Salvage', 'is_salvage'], ['Repair', 'is_repair'], ['Refuel', 'is_refuel'], ['Medical', 'is_medical'],
  ['Research', 'is_research'], ['Science', 'is_science'], ['Datarunner', 'is_datarunner'], ['Scanning', 'is_scanning'], ['Tractor beam', 'is_tractor_beam'],
  ['EMP', 'is_emp'], ['QED', 'is_qed'], ['Stealth', 'is_stealth'], ['Boarding', 'is_boarding'], ['Docking', 'is_docking'], ['Loading dock', 'is_loading_dock'], ['Add-on', 'is_addon'],
]
const vehicleAdditionalFlags: [string, string][] = [['Concept', 'is_concept'], ['Hangar stored', 'is_hangar'], ['Showdown winner', 'is_showdown_winner'], ['Quantum capable', 'is_quantum_capable']]

const datasets: { key: DatasetKey; label: string }[] = [
  { key: 'commodities_prices_all', label: 'Trade prices' },
  { key: 'commodities', label: 'Commodities' },
  { key: 'terminals', label: 'Terminals' },
  { key: 'vehicles', label: 'Vehicles' },
  { key: 'vehicles_purchases_prices_all', label: 'In-game vehicle prices' },
  { key: 'fuel_prices_all', label: 'Fuel prices' },
  { key: 'refineries_methods', label: 'Refinery methods' },
  { key: 'refineries_yields', label: 'Refinery yields' },
  { key: 'refineries_capacities', label: 'Refinery capacities' },
  { key: 'star_systems', label: 'Star systems' },
]

const emptyState = (): Record<DatasetKey, DatasetState> => ({
  commodities: { rows: [], status: 'loading' },
  terminals: { rows: [], status: 'loading' },
  vehicles: { rows: [], status: 'loading' },
  star_systems: { rows: [], status: 'loading' },
  commodities_prices_all: { rows: [], status: 'loading' },
  vehicles_purchases_prices_all: { rows: [], status: 'loading' },
  fuel_prices_all: { rows: [], status: 'loading' },
  refineries_methods: { rows: [], status: 'loading' },
  refineries_yields: { rows: [], status: 'loading' },
  refineries_capacities: { rows: [], status: 'loading' },
})

function loadingState(previous: Record<DatasetKey, DatasetState>) {
  return Object.fromEntries(
    Object.entries(previous).map(([key, value]) => [key, { ...value, status: 'loading', error: undefined }]),
  ) as Record<DatasetKey, DatasetState>
}

function getStoredToken() {
  try {
    return window.localStorage.getItem(tokenKey) ?? ''
  } catch {
    return ''
  }
}

function getStoredTheme(): AppTheme {
  try {
    const value = window.localStorage.getItem(themeKey)
    return value === 'amber' || value === 'ice' || value === 'night' || value === 'redshift' ? value : 'field'
  } catch {
    return 'field'
  }
}

type SystemIndexSnapshot = { locationKeys: string[]; newLocationKeys: string[] }

function getStoredSystemIndexSnapshot(): SystemIndexSnapshot | null {
  try {
    const stored = window.localStorage.getItem(systemIndexKey)
    if (!stored) return null
    const value = JSON.parse(stored) as Partial<SystemIndexSnapshot>
    if (!Array.isArray(value.locationKeys) || !Array.isArray(value.newLocationKeys)) return null
    return {
      locationKeys: value.locationKeys.filter((key): key is string => typeof key === 'string'),
      newLocationKeys: value.newLocationKeys.filter((key): key is string => typeof key === 'string'),
    }
  } catch {
    return null
  }
}

function getTerminalLocationKey(row: UexRow) {
  const id = readText(row, 'id')
  if (id) return `id:${id}`
  const name = readText(row, 'name') || readText(row, 'terminal_name')
  const parts = [
    readText(row, 'id_star_system') || readText(row, 'star_system_name', 'system_name'),
    readText(row, 'planet_name'),
    readText(row, 'moon_name'),
    readText(row, 'orbit_name'),
    name,
    readText(row, 'type', 'terminal_type'),
  ].map((part) => part.trim().toLocaleLowerCase())
  return parts.some(Boolean) ? `location:${parts.join('|')}` : ''
}

function snapshotNewTerminalLocations(rows: UexRow[], isRefresh: boolean): SystemIndexSnapshot {
  const locationKeys = [...new Set(rows.map(getTerminalLocationKey).filter(Boolean))]
  const previous = getStoredSystemIndexSnapshot()
  const knownKeys = new Set(previous?.locationKeys ?? [])
  const newlyAdded = previous ? locationKeys.filter((key) => !knownKeys.has(key)) : []
  const newLocationKeys = isRefresh
    ? newlyAdded
    : [...new Set([...(previous?.newLocationKeys ?? []), ...newlyAdded])]
  return { locationKeys, newLocationKeys }
}

function getRouteMarketOffers(prices: UexRow[], terminals: UexRow[], commodity: string): RouteMarketOffer[] {
  const terminalById = new Map(terminals.map((terminal) => [readText(terminal, 'id'), terminal]))
  const offersById = new Map<string, RouteMarketOffer>()
  for (const row of prices) {
    if (readText(row, 'commodity_name') !== commodity) continue
    const terminalId = readText(row, 'id_terminal')
    if (!terminalId) continue
    const terminal = terminalById.get(terminalId)
    const terminalName = readText(row, 'terminal_name') || readText(terminal ?? {}, 'name', 'terminal_name')
    if (!terminalName) continue
    const current = offersById.get(terminalId) ?? {
      terminalId,
      terminalName,
      location: [readText(terminal ?? {}, 'star_system_name'), readText(terminal ?? {}, 'planet_name'), readText(terminal ?? {}, 'moon_name')].filter(Boolean).join(' · '),
      buyPrice: 0,
      buyQuantity: 0,
      sellPrice: 0,
      sellStock: 0,
    }
    const buyPrice = readNumber(row, 'price_buy')
    const buyQuantity = readNumber(row, 'scu_buy')
    const sellPrice = readNumber(row, 'price_sell')
    const sellStock = readNumber(row, 'scu_sell_stock')
    if (buyPrice > 0 && buyQuantity > 0) {
      current.buyPrice = buyPrice
      current.buyQuantity = buyQuantity
    }
    if (sellPrice > 0 && sellStock > 0) {
      current.sellPrice = sellPrice
      current.sellStock = sellStock
    }
    offersById.set(terminalId, current)
  }
  return [...offersById.values()].sort((left, right) => left.terminalName.localeCompare(right.terminalName, undefined, { sensitivity: 'base' }))
}

function getVehicleOfferLocation(offer: UexRow, terminals: UexRow[]) {
  const terminal = terminals.find((row) => readText(row, 'id') === readText(offer, 'id_terminal'))
  const planet = readText(offer, 'planet_name') || readText(terminal ?? {}, 'planet_name')
  const moon = readText(offer, 'moon_name') || readText(terminal ?? {}, 'moon_name')
  const station = readText(offer, 'space_station_name') || readText(terminal ?? {}, 'space_station_name')
  const orbit = readText(offer, 'orbit_name') || readText(terminal ?? {}, 'orbit_name')
  const terminalName = readText(terminal ?? {}, 'name', 'terminal_name') || readText(offer, 'terminal_name')
  const settlement = readText(offer, 'city_name') || readText(terminal ?? {}, 'city_name') || readText(offer, 'outpost_name') || readText(terminal ?? {}, 'outpost_name')
  return [
    readText(offer, 'star_system_name') || readText(terminal ?? {}, 'star_system_name', 'system_name'),
    planet,
    moon,
    station || (!planet && !moon ? orbit : ''),
    settlement && !terminalName.toLocaleLowerCase().includes(settlement.toLocaleLowerCase()) ? settlement : '',
  ].filter(Boolean).join(' · ')
}

function App() {
  const [section, setSection] = useState<Section>('dashboard')
  const [theme, setTheme] = useState<AppTheme>(getStoredTheme)
  const [token, setToken] = useState(getStoredToken)
  const [tokenInput, setTokenInput] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [datasetsState, setDatasetsState] = useState(emptyState)
  const [marketHistory, setMarketHistory] = useState<MarketPriceSnapshot[]>(loadMarketPriceHistory)
  const [refreshKey, setRefreshKey] = useState(0)
  const [newLocationKeys, setNewLocationKeys] = useState<Set<string>>(() => new Set(getStoredSystemIndexSnapshot()?.newLocationKeys ?? []))
  const [search, setSearch] = useState('')
  const [selectedCommodity, setSelectedCommodity] = useState('')
  const [cargo, setCargo] = useState(100)
  const [notice, setNotice] = useState('')
  const [financeState, setFinanceState] = useState<FinanceState>(loadFinanceState)
  const [hangarState, setHangarState] = useState<HangarState>(loadHangarState)
  const [crewState, setCrewState] = useState<CrewState>(loadCrewState)
  const [miningOpsState, setMiningOpsState] = useState<MiningOpsState>(loadMiningOpsState)
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode | null>(getStoredWorkspaceMode)
  const [setupOpen, setSetupOpen] = useState(shouldShowFirstRunSetup)
  const [routePlans, setRoutePlans] = useState<PlannedRoute[]>(loadRoutePlans)
  const [financeTab, setFinanceTab] = useState<'ledger' | 'accounts'>('ledger')
  const [selectedVehicleId, setSelectedVehicleId] = useState('')
  const [tradePreset, setTradePreset] = useState<TradePreset | null>(null)
  const [vehiclePurchase, setVehiclePurchase] = useState<VehiclePurchaseSelection | null>(null)
  const [gameChannel, setGameChannel] = useState<GameChannel>(getStoredGameChannel)
  const [customGameRoots, setCustomGameRoots] = useState<string[]>(getStoredGameRoots)
  const [gameInstallations, setGameInstallations] = useState<GameInstallation[]>([])
  const [gameScanStatus, setGameScanStatus] = useState<GameScanStatus>(() => window.starCitizenBridge?.detectInstallations ? 'checking' : 'unavailable')
  const [gameScanRevision, setGameScanRevision] = useState(0)
  const [gameLogStatus, setGameLogStatus] = useState<GameLogStatus>(() => window.starCitizenBridge ? 'idle' : 'unavailable')
  const gameLogSupported = Boolean(window.starCitizenBridge?.watchGameLog && window.starCitizenBridge.onGameLogEvent)
  const [gameLogState, setGameLogState] = useState<GameLogState>(loadGameLogState)
  const [syncHostInfo, setSyncHostInfo] = useState<SyncHostInfo>({ status: 'stopped' })
  const [syncPairedClients, setSyncPairedClients] = useState<SyncPairedClient[]>([])
  const [syncPairRequests, setSyncPairRequests] = useState<SyncPairRequest[]>([])
  const [syncProposals, setSyncProposals] = useState<SyncProposal[]>([])
  const [syncMergeReview, setSyncMergeReview] = useState<SyncMergeReview | null>(null)
  const [syncClientPairing, setSyncClientPairing] = useState<SyncClientPairing | null>(getSyncClientPairing)
  const [syncClientStatus, setSyncClientStatus] = useState<SyncClientStatus>(() => getSyncClientPairing() ? 'paired' : 'idle')
  const [syncLastUploadedAt, setSyncLastUploadedAt] = useState('')
  const [syncError, setSyncError] = useState('')
  const gameLogStateRef = useRef(gameLogState)
  const hangarStateRef = useRef(hangarState)
  const financeStateRef = useRef(financeState)

  function createSyncSnapshot(): SyncSnapshot {
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      data: {
        finance: financeState,
        hangar: hangarState,
        crew: crewState,
        routes: routePlans,
        miningOps: miningOpsState,
        gameLog: gameLogState,
        marketPriceHistory: marketHistory,
        systemIndexSnapshot: getStoredSystemIndexSnapshot(),
        preferences: { theme, gameChannel, workspaceMode },
      },
    }
  }

  const captureSyncSnapshot = useEffectEvent(createSyncSnapshot)

  useEffect(() => {
    const bridge = window.starCitizenBridge
    if (!bridge?.onSyncPairRequest) return
    return bridge.onSyncPairRequest((request) => {
      setSyncPairRequests((previous) => [request, ...previous.filter((item) => item.requestId !== request.requestId)].slice(0, 10))
    })
  }, [])

  useEffect(() => {
    const bridge = window.starCitizenBridge
    if (!bridge?.onSyncProposal) return
    return bridge.onSyncProposal((proposal) => {
      if (!validateSyncSnapshot(proposal.snapshot)) {
        setSyncError(`Rejected an invalid sync snapshot from ${proposal.clientName}.`)
        return
      }
      setSyncError('')
      setSyncProposals((previous) => [proposal, ...previous.filter((item) => item.id !== proposal.id)].slice(0, 10))
    })
  }, [])

  useEffect(() => {
    if (!syncClientPairing) return
    const timer = window.setTimeout(() => {
      setSyncClientStatus('syncing')
      void uploadSyncSnapshot(captureSyncSnapshot(), syncClientPairing).then(() => {
        setSyncClientStatus('uploaded')
        setSyncLastUploadedAt(new Date().toISOString())
        setSyncError('')
      }).catch((error) => {
        setSyncClientStatus('error')
        setSyncError(error instanceof Error ? error.message : 'Unable to upload app data.')
      })
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [syncClientPairing, financeState, hangarState, crewState, routePlans, miningOpsState, gameLogState, marketHistory, newLocationKeys, theme, gameChannel, workspaceMode])

  async function startSyncHost() {
    try {
      const result = await window.starCitizenBridge?.startSyncHost?.()
      if (!result) return
      setSyncHostInfo(result)
      setSyncPairedClients(result.status === 'listening' ? await window.starCitizenBridge?.listSyncClients?.() ?? [] : [])
      setSyncError(result.status === 'listening' ? '' : result.status === 'tailscale-cli-not-found' ? 'Install and sign in to Tailscale before hosting.' : result.status === 'tailscale-dns-unavailable' ? 'Tailscale Serve could not obtain a MagicDNS certificate.' : result.status === 'serve-error' ? result.detail || 'Tailscale Serve could not start.' : 'Unable to start the sync listener.')
    } catch {
      setSyncHostInfo({ status: 'start-error' })
      setSyncError('Unable to start the sync listener.')
    }
  }

  async function rotateSyncCode() {
    const result = await window.starCitizenBridge?.rotateSyncPairingCode?.()
    if (result && syncHostInfo.address && syncHostInfo.port) setSyncHostInfo({ ...syncHostInfo, code: result.code, expiresAt: result.expiresAt })
  }

  async function approveSyncPairRequest(requestId: string) {
    const accepted = await window.starCitizenBridge?.approveSyncPairing?.(requestId)
    if (!accepted) return
    setSyncPairRequests((previous) => previous.filter((request) => request.requestId !== requestId))
    setSyncPairedClients(await window.starCitizenBridge?.listSyncClients?.() ?? [])
    setSyncError('')
  }

  async function rejectSyncPairRequest(requestId: string) {
    await window.starCitizenBridge?.rejectSyncPairing?.(requestId)
    setSyncPairRequests((previous) => previous.filter((request) => request.requestId !== requestId))
  }

  async function stopSyncHost() {
    await window.starCitizenBridge?.stopSyncHost?.()
    setSyncHostInfo({ status: 'stopped' })
    setSyncProposals([])
    setSyncPairRequests([])
    setSyncPairedClients([])
    setSyncMergeReview(null)
  }

  async function revokeSyncClient(clientId: string) {
    const revoked = await window.starCitizenBridge?.revokeSyncClient?.(clientId)
    if (revoked) setSyncPairedClients((previous) => previous.filter((client) => client.clientId !== clientId))
  }

  async function connectSyncClient(primaryUrl: string, code: string, clientName: string) {
    setSyncClientStatus('pairing')
    setSyncError('')
    try {
      const pairing = await pairSyncClient(primaryUrl, code, clientName)
      setSyncClientPairing(pairing)
      setSyncClientStatus('paired')
      setSyncError('')
    } catch (error) {
      setSyncClientStatus('error')
      setSyncError(error instanceof Error ? error.message : 'Unable to pair with the primary.')
    }
  }

  async function disconnectSync() {
    await disconnectSyncClient(syncClientPairing ?? undefined)
    setSyncClientPairing(null)
    setSyncClientStatus('idle')
    setSyncLastUploadedAt('')
    setSyncError('')
  }

  async function uploadNow() {
    if (!syncClientPairing) return
    setSyncClientStatus('syncing')
    setSyncError('')
    try {
      await uploadSyncSnapshot(createSyncSnapshot(), syncClientPairing)
      setSyncClientStatus('uploaded')
      setSyncLastUploadedAt(new Date().toISOString())
    } catch (error) {
      setSyncClientStatus('error')
      setSyncError(error instanceof Error ? error.message : 'Unable to upload app data.')
    }
  }

  function openSyncMergeReview(proposal: SyncProposal) {
    if (!validateSyncSnapshot(proposal.snapshot)) {
      setSyncError('This sync snapshot is invalid and cannot be previewed.')
      return
    }
    setSyncMergeReview({ proposal, preview: previewSyncMerge(createSyncSnapshot(), proposal.snapshot) })
  }

  function dismissSyncProposal(proposalId: string) {
    setSyncProposals((previous) => previous.filter((proposal) => proposal.id !== proposalId))
    if (syncMergeReview?.proposal.id === proposalId) setSyncMergeReview(null)
  }

  function applySyncMerge() {
    if (!syncMergeReview) return
    const merged = syncMergeReview.preview.snapshot
    if (!persistSyncSnapshot(merged)) {
      setSyncError('Could not save the merged snapshot. No sync changes were applied.')
      return
    }

    financeStateRef.current = merged.data.finance
    hangarStateRef.current = merged.data.hangar
    setFinanceState(merged.data.finance)
    setHangarState(merged.data.hangar)
    setCrewState(merged.data.crew)
    setRoutePlans(merged.data.routes)
    setMiningOpsState(merged.data.miningOps)
    gameLogStateRef.current = merged.data.gameLog
    setGameLogState(merged.data.gameLog)
    setMarketHistory(merged.data.marketPriceHistory)
    saveMarketPriceHistory(merged.data.marketPriceHistory)
    setNewLocationKeys(new Set(merged.data.systemIndexSnapshot?.newLocationKeys ?? []))
    setTheme(merged.data.preferences.theme)
    setGameChannel(merged.data.preferences.gameChannel)
    setWorkspaceMode(merged.data.preferences.workspaceMode)
    setSetupOpen(false)
    setGameScanRevision((revision) => revision + 1)
    dismissSyncProposal(syncMergeReview.proposal.id)
    setSyncError('')
    setNotice('Approved sync merge applied on the primary device.')
  }

  const capturePriceSnapshot = useEffectEvent((rows: UexRow[]) => {
    const next = captureMarketPriceSnapshot(marketHistory, rows)
    if (next.length === marketHistory.length && next.at(-1)?.capturedAt === marketHistory.at(-1)?.capturedAt) return
    setMarketHistory(next)
    saveMarketPriceHistory(next)
  })

  useEffect(() => {
    let active = true

    Promise.all(datasets.map(async ({ key }) => {
      try {
        const rows = await getUexData<UexRow[]>(key, token)
        if (key === 'terminals' && active) {
          const snapshot = snapshotNewTerminalLocations(rows, refreshKey > 0)
          setNewLocationKeys(new Set(snapshot.newLocationKeys))
          try {
            window.localStorage.setItem(systemIndexKey, JSON.stringify(snapshot))
          } catch {}
        }
        if (key === 'commodities_prices_all' && active) capturePriceSnapshot(rows)
        if (active) setDatasetsState((previous) => ({ ...previous, [key]: { rows, status: 'ready' } }))
      } catch (error) {
        if (active) {
          const message = error instanceof Error ? error.message : 'Unable to load this resource.'
          setDatasetsState((previous) => ({ ...previous, [key]: { rows: [], status: 'error', error: message } }))
        }
      }
    }))

    return () => { active = false }
  }, [token, refreshKey])

  useEffect(() => {
    let active = true
    const timer = window.setInterval(async () => {
      try {
        const rows = await getUexData<UexRow[]>('commodities_prices_all', token)
        if (!active) return
        capturePriceSnapshot(rows)
        setDatasetsState((previous) => ({ ...previous, commodities_prices_all: { rows, status: 'ready' } }))
      } catch (error) {
        if (!active) return
        const message = error instanceof Error ? error.message : 'Unable to load this resource.'
        setDatasetsState((previous) => ({ ...previous, commodities_prices_all: { ...previous.commodities_prices_all, status: 'error', error: message } }))
      }
    }, MARKET_SNAPSHOT_INTERVAL_MS)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [token])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    const bridge = window.starCitizenBridge
    if (!bridge?.detectInstallations) return
    let active = true
    bridge.detectInstallations(customGameRoots).then((installations) => {
      if (!active) return
      setGameInstallations(installations)
      setGameScanStatus('ready')
    }).catch(() => {
      if (active) setGameScanStatus('error')
    })
    return () => { active = false }
  }, [customGameRoots, gameScanRevision])

  useEffect(() => { gameLogStateRef.current = gameLogState }, [gameLogState])
  useEffect(() => { hangarStateRef.current = hangarState }, [hangarState])
  useEffect(() => { financeStateRef.current = financeState }, [financeState])

  const prices = datasetsState.commodities_prices_all.rows
  const commodities = datasetsState.commodities.rows
  const terminals = datasetsState.terminals.rows
  const vehicles = datasetsState.vehicles.rows
  const fuelPrices = datasetsState.fuel_prices_all.rows
  const refineryMethods = datasetsState.refineries_methods.rows
  const refineryYields = datasetsState.refineries_yields.rows
  const refineryCapacities = datasetsState.refineries_capacities.rows
  const systems = datasetsState.star_systems.rows
  const hangarCandidates = vehicles.filter((vehicle) => readNumber(vehicle, 'is_spaceship') === 1 && readNumber(vehicle, 'is_addon') !== 1 && readNumber(vehicle, 'is_concept') !== 1)
  const handleGameLogEvent = useEffectEvent((event: GameLogEvent) => {
    if (event.type === 'transaction') {
      const current = gameLogStateRef.current
      const next = queueGameLogTransaction(current, event)
      if (next === current) return
      gameLogStateRef.current = next
      setGameLogState(next)
      const saved = saveGameLogState(next)
      setNotice(`${event.itemName} ${event.kind === 'buy' ? 'purchase' : 'sale'} detected from Game.log. Confirm the account in Money & ledger.${saved ? '' : ' It is only saved for this session.'}`)
      return
    }

    const current = hangarStateRef.current
    const vehicle = findVehicleForGameModel(event.modelSlug, vehicles)
    if (current.ships.some((ship) => ship.gameModelSlug === event.modelSlug || (vehicle && ship.vehicleId === readText(vehicle, 'id')))) return
    const result = addDetectedShip(current, event.modelSlug, vehicle)
    if (!result.state) return
    hangarStateRef.current = result.state
    setHangarState(result.state)
    const saved = saveHangarState(result.state)
    const name = result.state.ships.find((ship) => ship.gameModelSlug === event.modelSlug)?.name ?? event.modelSlug
    setNotice(`${name} observed in Game.log and added to your hangar.${saved ? '' : ' It is only saved for this session.'}`)
  })

  useEffect(() => {
    const bridge = window.starCitizenBridge
    if (!bridge?.onGameLogEvent) return
    const removeEventListener = bridge.onGameLogEvent(handleGameLogEvent)
    const removeStatusListener = bridge.onGameLogStatus?.(setGameLogStatus)
    return () => {
      removeEventListener()
      removeStatusListener?.()
    }
  }, [])

  useEffect(() => {
    const bridge = window.starCitizenBridge
    if (!bridge?.watchGameLog || !bridge.onGameLogEvent || gameScanStatus !== 'ready') return
    let active = true
    bridge.watchGameLog(gameChannel, customGameRoots).then((result) => {
      if (active) setGameLogStatus(result.status)
    }).catch(() => {
      if (active) setGameLogStatus('error')
    })
    return () => {
      active = false
      void bridge.stopGameLog?.()
    }
  }, [gameChannel, customGameRoots, gameScanStatus, gameScanRevision])
  const activeShip = hangarState.ships.find((ship) => ship.id === hangarState.activeShipId)
  const activeShipUsed = activeShip ? getShipCargoUsed(hangarState, activeShip.id) : 0
  const activeShipFree = activeShip ? Math.max(0, activeShip.cargoCapacity - activeShipUsed) : 0
  const routeCargo = activeShip ? Math.min(cargo, activeShipFree) : cargo
  const readyCount = datasets.filter(({ key }) => datasetsState[key].status === 'ready').length
  const allReady = readyCount === datasets.length
  const anyReady = readyCount > 0
  const anyLoading = datasets.some(({ key }) => datasetsState[key].status === 'loading')
  const commodityNames = [...new Set(prices.map((row) => readText(row, 'commodity_name')).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  const activeCommodity = selectedCommodity || commodityNames[0] || ''
  const filteredPrices = prices.filter((row) => readText(row, 'commodity_name') === activeCommodity)
  const buyers = filteredPrices.filter((row) => readNumber(row, 'price_buy') > 0 && readNumber(row, 'scu_buy') > 0)
  const sellers = filteredPrices.filter((row) => readNumber(row, 'price_sell') > 0 && readNumber(row, 'scu_sell_stock') > 0)
  const routes = buyers.flatMap((buyer) => sellers
    .filter((seller) => readNumber(buyer, 'id_terminal') !== readNumber(seller, 'id_terminal'))
    .map((seller) => {
      const quantity = Math.floor(Math.max(0, Math.min(routeCargo, readNumber(buyer, 'scu_buy'), readNumber(seller, 'scu_sell_stock'))))
      const unitMargin = readNumber(seller, 'price_sell') - readNumber(buyer, 'price_buy')
      return { buyer, seller, quantity, unitMargin, grossMargin: unitMargin * quantity }
    })
    .filter((route) => route.quantity > 0 && route.unitMargin > 0))
    .sort((a, b) => b.grossMargin - a.grossMargin)
    .slice(0, 8)

  const filteredRows = (rows: UexRow[], keys: string[]) => rows.filter((row) =>
    keys.some((key) => readText(row, key).toLowerCase().includes(search.trim().toLowerCase())),
  )

  function saveToken() {
    const nextToken = tokenInput.trim()
    try {
      if (nextToken) window.localStorage.setItem(tokenKey, nextToken)
      else window.localStorage.removeItem(tokenKey)
      setToken(nextToken)
      setTokenInput('')
      setSettingsOpen(false)
      setNotice(nextToken ? 'Token saved in this browser.' : 'Token removed from this browser.')
      setDatasetsState((previous) => loadingState(previous))
      setRefreshKey((value) => value + 1)
    } catch {
      setNotice('Browser storage is unavailable. The token was not saved.')
    }
  }

  function refreshData() {
    clearUexCache()
    setNotice('Refreshing UEX data...')
    setDatasetsState((previous) => loadingState(previous))
    setRefreshKey((value) => value + 1)
  }

  function updateTheme(nextTheme: AppTheme) {
    setTheme(nextTheme)
    try {
      window.localStorage.setItem(themeKey, nextTheme)
    } catch {
      setNotice('Theme changed for this session, but browser storage is unavailable.')
    }
  }

  function updateGameChannel(channel: GameChannel) {
    setGameChannel(channel)
    try { window.localStorage.setItem(gameChannelKey, channel) } catch {}
  }

  function rescanGameInstallations() {
    setGameScanStatus('checking')
    setGameScanRevision((revision) => revision + 1)
  }

  async function chooseGameInstallRoot() {
    const bridge = window.starCitizenBridge
    if (!bridge?.chooseInstallRoot) return
    try {
      const root = await bridge.chooseInstallRoot()
      if (!root) return
      const nextRoots = [...new Set([...customGameRoots, root])]
      setGameScanStatus('checking')
      setCustomGameRoots(nextRoots)
      try { window.localStorage.setItem(gameRootsKey, JSON.stringify(nextRoots)) } catch {}
    } catch {
      setGameScanStatus('error')
    }
  }

  function openTradeRecord(side: TradeSide, row?: UexRow, commodity = activeCommodity, quantity = routeCargo, requestedShipId?: string | null, routeContext?: { planId: string; action: 'buy' | 'sell' }) {
    const priceKey = side === 'buy' ? 'price_buy' : 'price_sell'
    const quote = row ?? prices
        .filter((item) => readText(item, 'commodity_name') === commodity
        && readNumber(item, priceKey) > 0
        && readNumber(item, side === 'buy' ? 'scu_buy' : 'scu_sell_stock') > 0)
      .sort((left, right) => readNumber(right, priceKey) - readNumber(left, priceKey))[0]
    setTradePreset({
      side,
      commodity,
      terminal: quote ? readText(quote, 'terminal_name') : '',
      unitPrice: quote ? readNumber(quote, priceKey) : 0,
      quantity,
      accountId: side === 'sell' ? financeState.accounts.find((account) => getAccountHeldQuantity(financeState, account.id, commodity) > 0)?.id : undefined,
      shipId: requestedShipId === null ? undefined : requestedShipId ?? (side === 'buy' ? activeShip?.id : activeShip && getShipCargoQuantity(hangarState, activeShip.id, commodity) > 0 ? activeShip.id : undefined),
      note: routeContext ? `Route plan ${routeContext.action} confirmation` : '',
      routePlanId: routeContext?.planId,
      routeAction: routeContext?.action,
    })
  }

  function commitTrade(trade: NewTrade, shipId?: string) {
    if (trade.side === 'buy' && shipId) {
      const ship = hangarState.ships.find((item) => item.id === shipId)
      if (!ship) return 'The selected ship is no longer in your hangar.'
      const freeCapacity = Math.max(0, ship.cargoCapacity - getShipCargoUsed(hangarState, shipId))
      if (trade.quantity > freeCapacity) return `Only ${freeCapacity} SCU of cargo capacity remains on ${ship.name}.`
    }
    if (trade.side === 'sell' && shipId && getShipCargoQuantity(hangarState, shipId, trade.commodity) < trade.quantity) {
      return `There is not enough ${trade.commodity} loaded on the active ship.`
    }
    if (trade.side === 'sell' && !shipId && getUnassignedQuantity(financeState, hangarState, trade.commodity) < trade.quantity) {
      return `Load ${trade.commodity} onto an active ship before recording this sale.`
    }
    const result = recordTrade(financeState, trade, crewState.members)
    if (!result.state) return result.error || 'Unable to record this trade.'
    let nextHangar = hangarState
    if (trade.side === 'buy' && shipId) {
      const loaded = loadCargo(result.state, hangarState, shipId, trade.commodity, trade.quantity)
      if (!loaded.state) return loaded.error || 'Unable to load the purchase onto your ship.'
      nextHangar = loaded.state
    } else if (trade.side === 'sell' && shipId) {
      const unloaded = unloadCargo(hangarState, shipId, trade.commodity, trade.quantity)
      if (!unloaded.state) return unloaded.error || 'Unable to remove sold cargo from your ship.'
      nextHangar = unloaded.state
    }
    setFinanceState(result.state)
    if (nextHangar !== hangarState) {
      setHangarState(nextHangar)
      saveHangarState(nextHangar)
    }
    const saved = saveFinanceState(result.state)
    let routeSaved = true
    if (tradePreset?.routePlanId && tradePreset.routeAction) {
      const entry = result.state.transactions[0]
      const nextPlans = routePlans.map((plan) => plan.id !== tradePreset.routePlanId ? plan : tradePreset.routeAction === 'buy'
        ? { ...plan, status: 'purchased' as const, purchasedQuantity: trade.quantity, buyShipId: shipId ?? null, buyLedgerEntryId: entry.id }
        : { ...plan, status: 'completed' as const, sellLedgerEntryId: entry.id })
      setRoutePlans(nextPlans)
      routeSaved = saveRoutePlans(nextPlans)
    }
    setTradePreset(null)
    const confirmationMessage = tradePreset?.routeAction === 'buy' ? 'Route purchase confirmed. The planned sale is ready.' : tradePreset?.routeAction === 'sell' ? 'Route sale confirmed and linked to the ledger.' : `${trade.side === 'buy' ? 'Buy' : 'Sale'} recorded in your ledger.`
    setNotice(saved && routeSaved ? confirmationMessage : 'Transaction recorded for this session, but browser storage could not save all changes.')
    return ''
  }

  function addAccount(name: string, balance: number) {
    const next = { ...financeState, accounts: [...financeState.accounts, createBankAccount(name, balance)] }
    setFinanceState(next)
    setNotice(saveFinanceState(next) ? 'Bank account added.' : 'Account added for this session, but browser storage is unavailable.')
  }

  function moveFunds(fromAccountId: string, toAccountId: string, amount: number, note: string) {
    const result = transferFunds(financeState, fromAccountId, toAccountId, amount, note)
    if (!result.state) return result.error || 'Unable to transfer funds.'
    setFinanceState(result.state)
    setNotice(saveFinanceState(result.state) ? 'Transfer recorded in your ledger.' : 'Transfer recorded for this session, but browser storage is unavailable.')
    return ''
  }

  function makeAccountTransaction(kind: AccountTransactionKind, accountId: string, destinationId: string, amount: number, note: string) {
    if (kind === 'transfer') return moveFunds(accountId, destinationId, amount, note)
    const result = recordAccountAdjustment(financeState, kind, accountId, amount, note)
    if (!result.state) return result.error || `Unable to record ${kind}.`
    setFinanceState(result.state)
    setNotice(saveFinanceState(result.state) ? `${kind === 'deposit' ? 'Deposit' : 'Withdrawal'} recorded in your ledger.` : 'Transaction recorded for this session, but browser storage is unavailable.')
    return ''
  }

  function confirmGameLogTransaction(eventId: string, accountId: string) {
    const pending = gameLogStateRef.current.pendingTransactions.find((transaction) => transaction.id === eventId)
    if (!pending) return false
    const gameTransaction: GameStoreTransaction = {
      eventId: pending.id,
      accountId,
      kind: pending.kind,
      itemName: pending.itemName,
      itemClassGuid: pending.itemClassGuid,
      shopName: pending.shopName,
      quantity: pending.quantity,
      unitPrice: pending.unitPrice,
      total: pending.total,
      recordedAt: pending.recordedAt,
      channel: pending.channel,
    }
    const result = recordGameStoreTransaction(financeStateRef.current, gameTransaction)
    if (!result.state) {
      setNotice(result.error || 'Unable to confirm this Game.log transaction.')
      return false
    }

    financeStateRef.current = result.state
    setFinanceState(result.state)
    const nextGameLogState = removePendingGameTransaction(gameLogStateRef.current, eventId)
    gameLogStateRef.current = nextGameLogState
    setGameLogState(nextGameLogState)
    const financeSaved = saveFinanceState(result.state)
    const gameLogSaved = saveGameLogState(nextGameLogState)
    const accountName = result.state.accounts.find((account) => account.id === accountId)?.name ?? 'account'
    setNotice(`${pending.itemName} ${pending.kind === 'buy' ? 'purchase' : 'sale'} recorded to ${accountName}.${financeSaved && gameLogSaved ? '' : ' Some changes are only saved for this session.'}`)
    return true
  }

  function dismissGameLogTransaction(eventId: string) {
    const nextGameLogState = removePendingGameTransaction(gameLogStateRef.current, eventId)
    gameLogStateRef.current = nextGameLogState
    setGameLogState(nextGameLogState)
    saveGameLogState(nextGameLogState)
  }

  function addMiningScan(scan: NewRockScan) {
    const result = addRockScan(miningOpsState, scan)
    if (!result.state) return result.error || 'Unable to save rock scan.'
    setMiningOpsState(result.state)
    return saveMiningOpsState(result.state) ? '' : 'Scan saved for this session, but browser storage is unavailable.'
  }

  function removeMiningScan(scanId: string) {
    const next = removeRockScan(miningOpsState, scanId)
    setMiningOpsState(next)
    saveMiningOpsState(next)
  }

  function confirmRouteBuy(plan: PlannedRoute) {
    const quote = prices.find((row) => readText(row, 'commodity_name') === plan.commodity
      && readText(row, 'id_terminal') === plan.buyTerminalId
      && readNumber(row, 'price_buy') > 0
      && readNumber(row, 'scu_buy') > 0)
    if (!quote) {
      setNotice('The planned buy quote is no longer available. Refresh UEX data and review the route.')
      return
    }
    openTradeRecord('buy', quote, plan.commodity, plan.quantity, undefined, { planId: plan.id, action: 'buy' })
  }

  function confirmRouteSale(plan: PlannedRoute) {
    const quote = prices.find((row) => readText(row, 'commodity_name') === plan.commodity
      && readText(row, 'id_terminal') === plan.sellTerminalId
      && readNumber(row, 'price_sell') > 0
      && readNumber(row, 'scu_sell_stock') > 0)
    if (!quote) {
      setNotice('The planned sell quote is no longer available. Refresh UEX data and review the route.')
      return
    }
      const shipId = plan.buyShipId && hangarState.ships.some((ship) => ship.id === plan.buyShipId) ? plan.buyShipId : null
      openTradeRecord('sell', quote, plan.commodity, plan.purchasedQuantity ?? plan.quantity, shipId, { planId: plan.id, action: 'sell' })
  }

  function openLedgerEntry(entryId: string) {
    setFinanceTab('ledger')
    setSearch(entryId)
    setSection('finance')
  }

  function clearLedger() {
    const next = { ...financeState, transactions: [] }
    const nextHangar = clearHangarCargo(hangarState)
    const nextRoutePlans: PlannedRoute[] = routePlans.map((plan) => ({
      id: plan.id,
      commodity: plan.commodity,
      buyTerminalId: plan.buyTerminalId,
      buyTerminalName: plan.buyTerminalName,
      sellTerminalId: plan.sellTerminalId,
      sellTerminalName: plan.sellTerminalName,
      quantity: plan.quantity,
      createdAt: plan.createdAt,
      status: 'planned',
    }))
    setFinanceState(next)
    setHangarState(nextHangar)
    setRoutePlans(nextRoutePlans)
    const saved = [saveHangarState(nextHangar), saveFinanceState(next), saveRoutePlans(nextRoutePlans)].every(Boolean)
    setNotice(saved ? 'Ledger cleared. Accounts and balances remain; route plans need new confirmations.' : 'Ledger cleared for this session, but browser storage is unavailable.')
    return saved
  }

  function factoryReset() {
    const nextFinance: FinanceState = { accounts: [], transactions: [] }
    const nextHangar: HangarState = { ships: [], activeShipId: null, cargoByShip: {} }
    const nextCrew: CrewState = { members: [], roles: [] }
    const nextGameLogState: GameLogState = { ...gameLogStateRef.current, pendingTransactions: [] }
    const saved = [
      saveFinanceState(nextFinance),
      saveHangarState(nextHangar),
      saveCrewState(nextCrew),
      clearRoutePlans(),
      saveGameLogState(nextGameLogState),
    ].every(Boolean)
    financeStateRef.current = nextFinance
    hangarStateRef.current = nextHangar
    gameLogStateRef.current = nextGameLogState
    setFinanceState(nextFinance)
    setHangarState(nextHangar)
    setCrewState(nextCrew)
    setGameLogState(nextGameLogState)
    setRoutePlans([])
    setFinanceTab('ledger')
    setSelectedVehicleId('')
    setTradePreset(null)
    setNotice(saved
      ? 'Factory reset complete. Hangar, crew, accounts, ledger, pending Game.log activity, and route plans were cleared.'
      : 'Factory reset applied for this session, but browser storage could not be updated.')
    return saved
  }

  function finishFirstRunSetup(mode: WorkspaceMode, nextCrewState: CrewState) {
    let profileSaved = true
    try {
      window.localStorage.setItem(setupProfileKey, JSON.stringify({ mode, completedAt: new Date().toISOString() }))
    } catch {
      profileSaved = false
    }
    const crewSaved = saveCrewState(nextCrewState)
    setWorkspaceMode(mode)
    setCrewState(nextCrewState)
    setSetupOpen(false)
    setNotice(profileSaved && crewSaved
      ? `${mode === 'organization' ? 'Organization' : 'Personal'} workspace setup complete.`
      : 'Workspace setup is complete for this session, but browser storage is unavailable.')
  }

  function skipFirstRunSetup() {
    let saved = true
    try {
      window.localStorage.setItem(setupProfileKey, JSON.stringify({ skipped: true, completedAt: new Date().toISOString() }))
    } catch {
      saved = false
    }
    setSetupOpen(false)
    setNotice(saved
      ? 'Workspace setup skipped. You can add roles and crew later in Crew manager.'
      : 'Workspace setup skipped for this session, but browser storage is unavailable.')
  }

  function removeAccount(accountId: string) {
    const next = { ...financeState, accounts: financeState.accounts.filter((account) => account.id !== accountId) }
    setFinanceState(next)
    const crewUsesAccount = crewState.members.some((member) => member.payoutAccountId === accountId)
    if (crewUsesAccount) {
      const nextCrew = { ...crewState, members: crewState.members.map((member) => member.payoutAccountId === accountId ? { ...member, payoutAccountId: null } : member) }
      setCrewState(nextCrew)
      saveCrewState(nextCrew)
    }
    const message = crewUsesAccount ? 'Bank account removed. Assign new payout accounts to affected crew before recording sales.' : 'Bank account removed. Its ledger history was retained.'
    setNotice(saveFinanceState(next) ? message : `${message} Browser storage is unavailable.`)
  }

  function persistCrew(next: CrewState, message: string) {
    setCrewState(next)
    setNotice(saveCrewState(next) ? message : `${message} Browser storage is unavailable.`)
  }

  function addRoutePlan(route: NewPlannedRoute) {
    const next = [...routePlans, createPlannedRoute(route)]
    setRoutePlans(next)
    setNotice(saveRoutePlans(next) ? 'Route plan saved locally.' : 'Route plan saved for this session, but browser storage is unavailable.')
  }

  function removeRoutePlan(routeId: string) {
    const next = routePlans.filter((route) => route.id !== routeId)
    setRoutePlans(next)
    setNotice(saveRoutePlans(next) ? 'Route plan removed.' : 'Route plan removed for this session, but browser storage is unavailable.')
  }

  function createCrewMember(name: string, roleId: string | null, sharePercent: number, payoutAccountId: string | null) {
    if (payoutAccountId && !financeState.accounts.some((account) => account.id === payoutAccountId)) return 'Choose a valid payout account.'
    const result = addCrewMember(crewState, name, sharePercent, roleId, payoutAccountId)
    if (!result.state) return result.error || 'Unable to add crew member.'
    persistCrew(result.state, `${name.trim()} added to your crew.`)
    return ''
  }

  function createCrewRole(name: string, defaultSharePercent: number) {
    const result = addCrewRole(crewState, name, defaultSharePercent)
    if (!result.state) return result.error || 'Unable to add crew role.'
    persistCrew(result.state, `${name.trim()} role added.`)
    return ''
  }

  function changeCrewRoleDefault(roleId: string, defaultSharePercent: number) {
    const result = updateCrewRoleDefault(crewState, roleId, defaultSharePercent)
    if (!result.state) return result.error || 'Unable to update this role default.'
    persistCrew(result.state, 'Role default updated for all assigned crew members.')
    return ''
  }

  function assignMemberRole(memberId: string, roleId: string | null) {
    const result = assignCrewRole(crewState, memberId, roleId)
    if (!result.state) return result.error || 'Unable to assign this crew role.'
    persistCrew(result.state, roleId ? 'Role assigned and its default share applied.' : 'Role removed. The current share is now manual.')
    return ''
  }

  function updateCrewShare(memberId: string, sharePercent: number) {
    const result = updateCrewMemberShare(crewState, memberId, sharePercent)
    if (!result.state) return result.error || 'Unable to update this crew share.'
    persistCrew(result.state, 'Crew share updated. This applies to future sales.')
    return ''
  }

  function updateCrewPayoutAccount(memberId: string, payoutAccountId: string | null) {
    if (payoutAccountId && !financeState.accounts.some((account) => account.id === payoutAccountId)) return 'Choose a valid payout account.'
    const result = updateCrewMemberPayoutAccount(crewState, memberId, payoutAccountId)
    if (!result.state) return result.error || 'Unable to update this payout account.'
    persistCrew(result.state, 'Crew payout account updated.')
    return ''
  }

  function deleteCrewMember(member: CrewMember) {
    persistCrew(removeCrewMember(crewState, member.id), `${member.name} removed from future sale splits.`)
  }

  function deleteCrewRole(role: CrewRole) {
    persistCrew(removeCrewRole(crewState, role.id), `${role.name} role removed. Assigned crew keep their current shares.`)
  }

  function persistHangar(next: HangarState, message: string) {
    setHangarState(next)
    setNotice(saveHangarState(next) ? message : `${message} Browser storage is unavailable.`)
  }

  function addHangarShip() {
    const vehicle = hangarCandidates.find((item) => readText(item, 'id') === selectedVehicleId)
    if (!vehicle) return
    const result = addShip(hangarState, vehicle)
    if (!result.state) {
      setNotice(result.error || 'Unable to add this ship.')
      return
    }
    persistHangar(result.state, `${readText(vehicle, 'name')} added to your personal hangar.`)
    setSelectedVehicleId('')
  }

  function confirmVehiclePurchase(vehicle: UexRow, offer: UexRow, accountId: string) {
    const vehicleId = readText(vehicle, 'id')
    const vehicleName = readText(vehicle, 'name', 'vehicle_name')
    if (hangarState.ships.some((ship) => ship.vehicleId === vehicleId)) return `${vehicleName} is already in your hangar.`

    const terminal = readText(offer, 'terminal_name')
    const hangarResult = addShip(hangarState, vehicle)
    if (!hangarResult.state) return hangarResult.error || 'Unable to add this vehicle to your hangar.'
    const financeResult = recordVehiclePurchase(financeState, {
      accountId,
      vehicleId,
      vehicleName,
      terminal,
      price: readNumber(offer, 'price_buy'),
    })
    if (!financeResult.state) return financeResult.error || 'Unable to record this vehicle purchase.'

    setFinanceState(financeResult.state)
    setHangarState(hangarResult.state)
    const financeSaved = saveFinanceState(financeResult.state)
    const hangarSaved = saveHangarState(hangarResult.state)
    setNotice(`${vehicleName} purchased at ${terminal} and added to your hangar.${financeSaved && hangarSaved ? '' : ' Browser storage is unavailable.'}`)
    return ''
  }

  function updateActiveShip(shipId: string | null) {
    persistHangar(setActiveShip(hangarState, shipId), shipId ? 'Active ship updated.' : 'No active ship selected.')
  }

  function removeHangarShip(ship: HangarShip) {
    persistHangar(removeShip(hangarState, ship.id), `${ship.name} removed. Its cargo is now unassigned.`)
  }

  function changeCargoAllocation(action: 'load' | 'unload', shipId: string, commodity: string, quantity: number) {
    const result = action === 'load'
      ? loadCargo(financeState, hangarState, shipId, commodity, quantity)
      : unloadCargo(hangarState, shipId, commodity, quantity)
    if (!result.state) {
      setNotice(result.error || `Unable to ${action} cargo.`)
      return
    }
    persistHangar(result.state, `${formatQuantity(quantity)} SCU ${commodity} ${action === 'load' ? 'loaded onto' : 'unloaded from'} the ship.`)
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#home" onClick={(event) => { event.preventDefault(); setSection('dashboard') }}>
          <span className="brand-mark" aria-hidden="true">SC</span>
          <span><strong>COMMAND</strong><small>UEX OPERATIONS</small></span>
        </a>
        <nav className="primary-nav" aria-label="Main navigation">
          <NavButton active={section === 'dashboard'} onClick={() => setSection('dashboard')} icon="▦" label="Dashboard" />
          <NavButton active={section === 'settings'} onClick={() => setSection('settings')} icon="⚙" label="Settings" />
          <div className="nav-caption">OPERATIONS</div>
          <NavButton active={section === 'routePlanner'} onClick={() => setSection('routePlanner')} icon="↗" label="Route planner" count={routePlans.length || undefined} />
          <NavButton active={section === 'finance'} onClick={() => setSection('finance')} icon="$" label="Money & ledger" count={financeState.transactions.length || undefined} />
          <NavButton active={section === 'hangar'} onClick={() => setSection('hangar')} icon="▰" label="Personal hangar" count={hangarState.ships.length || undefined} />
          <NavButton active={section === 'crew'} onClick={() => setSection('crew')} icon="♙" label="Crew manager" count={crewState.members.length || undefined} />
          <NavButton active={section === 'holdings'} onClick={() => setSection('holdings')} icon="▤" label="Cargo holdings" count={getCommodityHoldings(financeState).length || undefined} />
          <div className="nav-caption nav-caption-spaced">INTEL</div>
          <NavButton active={section === 'commodities'} onClick={() => setSection('commodities')} icon="◈" label="Commodities" count={commodityNames.length || undefined} />
          <NavButton active={section === 'systems'} onClick={() => setSection('systems')} icon="◎" label="Star systems" count={systems.length || undefined} />
          <NavButton active={section === 'ships'} onClick={() => setSection('ships')} icon="▱" label="Ships & vehicles" count={vehicles.length || undefined} />
          <NavButton active={section === 'inventory'} onClick={() => setSection('inventory')} icon="◇" label="Items & equipment" />
          <NavButton active={section === 'fuelPrices'} onClick={() => setSection('fuelPrices')} icon="⛽" label="Fuel prices" count={fuelPrices.length || undefined} />
          <div className="nav-caption nav-caption-spaced">FIELD WORK</div>
          <NavButton active={section === 'trade'} onClick={() => setSection('trade')} icon="↗" label="Trade routes" />
          <NavButton active={section === 'mining'} onClick={() => setSection('mining')} icon="⌁" label="Mining & refining" />
        </nav>
        <div className="sidebar-bottom">
          <div className="api-status">
            <span className={`status-dot ${allReady ? 'is-live' : anyLoading ? 'is-loading' : ''}`} />
            <div><strong>{allReady ? 'UEX DATA LINK' : anyLoading ? 'CONNECTING' : anyReady ? 'PARTIAL DATA' : 'DATA LINK IDLE'}</strong><small>{allReady ? 'Community data · live' : anyReady ? `${readyCount} of ${datasets.length} resources loaded` : 'Check API settings'}</small></div>
          </div>
          <div className="sidebar-foot"><span>{workspaceMode ? `${workspaceMode.toUpperCase()} WORKSPACE` : 'STAR CITIZEN'}</span><span>UEX API 2.0</span><span>v{packageMetadata.version}</span></div>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <div className="breadcrumb"><span>COMMAND HUB</span><span className="crumb-separator">/</span><strong>{sectionTitle(section).toUpperCase()}</strong></div>
          <div className="top-actions">
            <div className={`connection-label ${allReady ? 'connected' : ''}`}><span className="status-dot" />{allReady ? 'CONNECTED' : anyLoading ? 'SYNCING' : anyReady ? 'PARTIAL' : 'OFFLINE'}</div>
            <button className="icon-button refresh-button" type="button" onClick={refreshData} aria-label="Refresh UEX data" title="Refresh UEX data">↻</button>
            <div className="settings-wrap">
              <button className={`settings-button ${settingsOpen ? 'selected' : ''}`} type="button" onClick={() => setSettingsOpen((value) => !value)} aria-expanded={settingsOpen}>
                <span className="settings-icon">⚙</span><span>API settings</span>
                {token && <span className="configured-dot" aria-label="Token configured" />}
              </button>
              {settingsOpen && <div className="settings-popover">
                <div className="popover-heading"><div><span className="eyebrow">CONNECTION</span><h2>UEX API token</h2></div><button className="close-button" onClick={() => setSettingsOpen(false)} aria-label="Close settings">×</button></div>
                <p>Enter your personal token here. It is saved in this browser's local storage and sent directly to UEX.</p>
                <label className="field-label" htmlFor="uex-token">Bearer token</label>
                <input id="uex-token" type="password" autoComplete="off" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} placeholder={token ? 'Saved token is set' : 'Paste token locally'} />
                <div className="popover-actions"><button className="text-button" onClick={() => { setTokenInput(''); if (token) { setTokenInput(''); try { window.localStorage.removeItem(tokenKey) } catch {} setToken(''); setNotice('Token removed from this browser.') } }}>Remove token</button><button className="primary-button" onClick={saveToken}>Save token</button></div>
                <div className="privacy-note">Never share your token. Browser scripts and extensions may be able to access local storage.</div>
              </div>}
            </div>
          </div>
        </header>

        <main className="workspace">
          {notice && <div className="toast" role="status"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss notice">×</button></div>}
          {!token && <div className="token-banner"><span className="banner-symbol">i</span><div><strong>Public UEX data is available</strong><p>A personal bearer token is optional for the verified public resources. Add one in API settings if your UEX access requires authentication.</p></div><button className="banner-action" onClick={() => setSettingsOpen(true)}>Add token <span>↗</span></button></div>}

          {section !== 'dashboard' && <div className="page-heading">
            <div><div className="eyebrow">UEX CORP · STANTON / PYRO / NYX</div><h1>{sectionTitle(section)}</h1><p>{sectionDescription(section)}</p></div>
            {section !== 'trade' && section !== 'inventory' && section !== 'settings' && <div className="search-field"><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${sectionTitle(section).toLowerCase()}`} aria-label={`Search ${sectionTitle(section).toLowerCase()}`} /><kbd>/</kbd></div>}
          </div>}

          {section === 'dashboard' && <DashboardView financeState={financeState} hangarState={hangarState} activeShip={activeShip} crewState={crewState} routePlans={routePlans} prices={prices} priceState={datasetsState.commodities_prices_all} marketHistory={marketHistory} onNavigate={setSection} />}
          {section === 'settings' && <ThemeSettingsView
            theme={theme}
            onChange={updateTheme}
            onFactoryReset={factoryReset}
            gameChannel={gameChannel}
            gameInstallations={gameInstallations}
            gameScanStatus={gameScanStatus}
            gameLogStatus={gameLogStatus}
            gameLogSupported={gameLogSupported}
            onGameChannelChange={updateGameChannel}
            onRescanGameInstallations={rescanGameInstallations}
            onChooseGameRoot={chooseGameInstallRoot}
            syncSettings={<SyncSettings
              desktopAvailable={Boolean(window.starCitizenBridge?.startSyncHost)}
              hostInfo={syncHostInfo}
              pairRequests={syncPairRequests}
              pairedClients={syncPairedClients}
              proposals={syncProposals}
              mergeReview={syncMergeReview}
              clientPairing={syncClientPairing}
              clientStatus={syncClientStatus}
              lastUploadedAt={syncLastUploadedAt}
              error={syncError}
              onStartHost={() => { void startSyncHost() }}
              onRotateCode={() => { void rotateSyncCode() }}
              onStopHost={() => { void stopSyncHost() }}
              onApprovePair={(requestId) => { void approveSyncPairRequest(requestId) }}
              onRejectPair={(requestId) => { void rejectSyncPairRequest(requestId) }}
              onRevokeClient={(clientId) => { void revokeSyncClient(clientId) }}
              onReviewProposal={openSyncMergeReview}
              onDismissProposal={dismissSyncProposal}
              onApplyMerge={applySyncMerge}
              onCloseMergeReview={() => setSyncMergeReview(null)}
              onConnectClient={(primaryUrl, code, clientName) => { void connectSyncClient(primaryUrl, code, clientName) }}
              onDisconnectClient={() => { void disconnectSync() }}
              onUploadNow={() => { void uploadNow() }}
            />}
          />}
          {section === 'trade' && <TradeView
            prices={prices}
            priceState={datasetsState.commodities_prices_all}
            commodities={commodityNames}
            selectedCommodity={activeCommodity}
            setSelectedCommodity={setSelectedCommodity}
            cargo={cargo}
            setCargo={setCargo}
            routes={routes}
            onRefresh={refreshData}
            onRecordTrade={openTradeRecord}
          />}
          {section === 'routePlanner' && <RoutePlannerView plans={routePlans} prices={prices} priceState={datasetsState.commodities_prices_all} terminals={terminals} search={search} onAdd={addRoutePlan} onRemove={removeRoutePlan} onConfirmBuy={confirmRouteBuy} onConfirmSale={confirmRouteSale} onViewLedger={openLedgerEntry} />}
          {section === 'finance' && <FinanceView
            state={financeState}
            pendingGameTransactions={gameLogState.pendingTransactions}
            search={search}
            initialTab={financeTab}
            onAddAccount={addAccount}
            onRemoveAccount={removeAccount}
            onRecordTrade={() => openTradeRecord('buy', undefined, activeCommodity, cargo)}
            onMakeTransaction={makeAccountTransaction}
            onClearLedger={clearLedger}
            onNotice={setNotice}
            onConfirmGameTransaction={confirmGameLogTransaction}
            onDismissGameTransaction={dismissGameLogTransaction}
          />}
          {section === 'holdings' && <HoldingsView holdings={getCommodityHoldings(financeState)} prices={prices} state={datasetsState.commodities_prices_all} search={search} activeShip={activeShip} hangarState={hangarState} financeState={financeState} activeShipFree={activeShipFree} onAllocate={changeCargoAllocation} onSell={(commodity, quantity) => openTradeRecord('sell', undefined, commodity, quantity)} />}
          {section === 'hangar' && <HangarView hangarState={hangarState} candidates={hangarCandidates} vehicles={vehicles} purchaseRows={datasetsState.vehicles_purchases_prices_all.rows} terminals={terminals} selectedVehicleId={selectedVehicleId} setSelectedVehicleId={setSelectedVehicleId} onAdd={addHangarShip} onSetActive={updateActiveShip} onRemove={removeHangarShip} />}
          {section === 'crew' && <CrewManagerView crewState={crewState} transactions={financeState.transactions} accounts={financeState.accounts} search={search} onAdd={createCrewMember} onAssignRole={assignMemberRole} onUpdateShare={updateCrewShare} onUpdatePayoutAccount={updateCrewPayoutAccount} onRemove={deleteCrewMember} onAddRole={createCrewRole} onUpdateRoleDefault={changeCrewRoleDefault} onRemoveRole={deleteCrewRole} />}
          {section === 'commodities' && <CommodityView rows={commodities.length ? commodities : prices} state={datasetsState.commodities.status === 'ready' ? datasetsState.commodities : datasetsState.commodities_prices_all} search={search} />}
          {section === 'ships' && <VehicleView
            rows={filteredRows(vehicles, ['name', 'vehicle_name', 'manufacturer_name', 'company_name', 'type_name'])}
            state={datasetsState.vehicles}
            purchaseRows={datasetsState.vehicles_purchases_prices_all.rows}
            purchaseState={datasetsState.vehicles_purchases_prices_all}
            terminals={terminals}
            accounts={financeState.accounts}
            hangarState={hangarState}
            onBuy={(vehicle, offers) => setVehiclePurchase({ vehicle, offers })}
          />}
          {section === 'systems' && <SystemsView rows={systems} terminals={terminals} prices={prices} newLocationKeys={newLocationKeys} state={datasetsState.star_systems} terminalState={datasetsState.terminals} priceState={datasetsState.commodities_prices_all} search={search} />}
          {section === 'mining' && <MiningView prices={prices} commodities={commodities} state={datasetsState.commodities_prices_all} methods={refineryMethods} methodsState={datasetsState.refineries_methods} yields={refineryYields} yieldsState={datasetsState.refineries_yields} capacities={refineryCapacities} capacitiesState={datasetsState.refineries_capacities} search={search} miningOpsState={miningOpsState} onAddScan={addMiningScan} onRemoveScan={removeMiningScan} />}
          {section === 'fuelPrices' && <FuelPricesView rows={filteredRows(fuelPrices, ['commodity_name', 'terminal_name', 'star_system_name', 'planet_name', 'city_name'])} terminals={terminals} state={datasetsState.fuel_prices_all} />}
          {section === 'inventory' && <ItemCatalogView key={token} token={token} />}

          <footer className="data-footer"><span>UEX data is community-maintained and may be incomplete or outdated.</span><span><span className="footer-dot" /> {allReady ? `${prices.length.toLocaleString()} PRICE RECORDS` : 'AWAITING DATA'}</span></footer>
        </main>
        {tradePreset && <RecordTradeDialog
          key={`${tradePreset.side}-${tradePreset.commodity}-${tradePreset.terminal}-${tradePreset.unitPrice}-${tradePreset.routePlanId ?? 'manual'}-${tradePreset.routeAction ?? ''}`}
          preset={tradePreset}
          prices={prices}
          accounts={financeState.accounts}
          crewMembers={crewState.members}
          hangarState={hangarState}
          onClose={() => setTradePreset(null)}
          onSubmit={commitTrade}
          onAddAccount={() => { setTradePreset(null); setFinanceTab('accounts'); setSection('finance') }}
        />}
        {vehiclePurchase && <VehiclePurchaseDialog
          key={readText(vehiclePurchase.vehicle, 'id')}
          vehicle={vehiclePurchase.vehicle}
          offers={vehiclePurchase.offers}
          terminals={terminals}
          accounts={financeState.accounts}
          onClose={() => setVehiclePurchase(null)}
          onSubmit={confirmVehiclePurchase}
          onAddAccount={() => { setVehiclePurchase(null); setFinanceTab('accounts'); setSection('finance') }}
        />}
        {setupOpen && <FirstRunSetupDialog initialCrewState={crewState} onComplete={finishFirstRunSetup} onSkip={skipFirstRunSetup} />}
      </div>
    </div>
  )
}

function FirstRunSetupDialog({ initialCrewState, onComplete, onSkip }: { initialCrewState: CrewState; onComplete: (mode: WorkspaceMode, crewState: CrewState) => void; onSkip: () => void }) {
  const [step, setStep] = useState(0)
  const [skipConfirmOpen, setSkipConfirmOpen] = useState(false)
  const [mode, setMode] = useState<WorkspaceMode | null>(null)
  const [crewState, setCrewState] = useState(initialCrewState)
  const [roleName, setRoleName] = useState('')
  const [roleShare, setRoleShare] = useState('0')
  const [memberName, setMemberName] = useState('')
  const [memberRoleId, setMemberRoleId] = useState('')
  const [memberShare, setMemberShare] = useState('0')
  const [error, setError] = useState('')
  const sortedRoles = [...crewState.roles].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))

  function submitRole(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const result = addCrewRole(crewState, roleName, Number(roleShare))
    if (!result.state) {
      setError(result.error || 'Unable to add this role.')
      return
    }
    setCrewState(result.state)
    setRoleName('')
    setRoleShare('0')
    setError('')
  }

  function submitMember(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const result = addCrewMember(crewState, memberName, Number(memberShare), memberRoleId || null, null)
    if (!result.state) {
      setError(result.error || 'Unable to add this crew member.')
      return
    }
    setCrewState(result.state)
    setMemberName('')
    setMemberRoleId('')
    setMemberShare('0')
    setError('')
  }

  const stepTitle = ['Choose your workspace', 'Set up crew roles', 'Add crew members'][step]
  const stepDescription = step === 0
    ? 'Choose how you want to organize this local workspace.'
    : step === 1
      ? mode === 'organization' ? 'Create shared roles and default payout shares for your organization.' : 'Crew roles are optional in a personal workspace.'
      : 'Add your crew now, or finish setup and add them later.'

  return <div className="modal-backdrop setup-backdrop">
    <section className="record-modal setup-modal" role="dialog" aria-modal="true" aria-labelledby="first-run-title">
      <div className="record-modal-head setup-modal-head"><div><span className="eyebrow">FIRST-RUN SETUP · STEP {step + 1} OF 3</span><h2 id="first-run-title">{stepTitle}</h2><p>{stepDescription}</p></div></div>
      <div className="setup-progress" aria-label={`Setup step ${step + 1} of 3`}><i className={step >= 0 ? 'complete' : ''} /><i className={step >= 1 ? 'complete' : ''} /><i className={step >= 2 ? 'complete' : ''} /></div>
      {step === 0 && <div className="setup-step-content">
        <div className="setup-mode-options" role="radiogroup" aria-label="Workspace type">
          <button className={`setup-mode-option ${mode === 'personal' ? 'selected' : ''}`} type="button" role="radio" aria-checked={mode === 'personal'} onClick={() => setMode('personal')}><strong>Personal</strong><span>Track your own ships, cargo, and trade activity.</span></button>
          <button className={`setup-mode-option ${mode === 'organization' ? 'selected' : ''}`} type="button" role="radio" aria-checked={mode === 'organization'} onClick={() => setMode('organization')}><strong>Organization</strong><span>Set up crew roles and coordinate shared payouts.</span></button>
        </div>
        <div className="setup-actions"><button className="secondary-button" type="button" onClick={() => setSkipConfirmOpen(true)}>Skip setup</button><button className="primary-button" type="button" disabled={!mode} onClick={() => setStep(1)}>Continue</button></div>
      </div>}
      {step === 1 && <div className="setup-step-content">
        <form className="setup-inline-form" onSubmit={submitRole}>
          <label><span>ROLE NAME</span><input value={roleName} onChange={(event) => setRoleName(event.target.value)} maxLength={40} placeholder="e.g. Pilot" required /></label>
          <label><span>DEFAULT SALE SHARE</span><div className="number-input"><input type="number" min="0" max="100" step="0.01" value={roleShare} onChange={(event) => setRoleShare(event.target.value)} required /><span>%</span></div></label>
          <button className="secondary-button" type="submit">Add role</button>
        </form>
        <div className="setup-draft-list">{sortedRoles.map((role) => <div className="setup-draft-row" key={role.id}><div><strong>{role.name}</strong><small>{role.defaultSharePercent}% default share</small></div><button className="remove-account" type="button" aria-label={`Remove ${role.name} role`} onClick={() => { setCrewState(removeCrewRole(crewState, role.id)); setError('') }}>×</button></div>)}{!sortedRoles.length && <p className="setup-empty-copy">No roles added. You can create them later in Crew manager.</p>}</div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="setup-actions"><button className="secondary-button" type="button" onClick={() => { setStep(0); setError('') }}>Back</button><button className="primary-button" type="button" onClick={() => { setStep(2); setError('') }}>Continue</button></div>
      </div>}
      {step === 2 && <div className="setup-step-content">
        <form className="setup-inline-form setup-member-form" onSubmit={submitMember}>
          <label><span>CREW MEMBER</span><input value={memberName} onChange={(event) => setMemberName(event.target.value)} maxLength={40} placeholder="Name" required /></label>
          <label><span>ROLE</span><select value={memberRoleId} onChange={(event) => { setMemberRoleId(event.target.value); setMemberShare(String(crewState.roles.find((role) => role.id === event.target.value)?.defaultSharePercent ?? 0)) }}><option value="">Manual share</option>{sortedRoles.map((role) => <option key={role.id} value={role.id}>{role.name} · {role.defaultSharePercent}%</option>)}</select></label>
          <label><span>{memberRoleId ? 'ROLE DEFAULT' : 'SALE SHARE'}</span><div className="number-input"><input type="number" min="0" max="100" step="0.01" value={memberShare} onChange={(event) => setMemberShare(event.target.value)} disabled={Boolean(memberRoleId)} required /><span>%</span></div></label>
          <button className="secondary-button" type="submit">Add crew</button>
        </form>
        <div className="setup-draft-list">{crewState.members.map((member) => <div className="setup-draft-row" key={member.id}><div><strong>{member.name}</strong><small>{sortedRoles.find((role) => role.id === member.roleId)?.name ?? 'Manual share'} · {member.sharePercent}%</small></div><button className="remove-account" type="button" aria-label={`Remove ${member.name}`} onClick={() => { setCrewState(removeCrewMember(crewState, member.id)); setError('') }}>×</button></div>)}{!crewState.members.length && <p className="setup-empty-copy">No crew added. You can add members later in Crew manager.</p>}</div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <p className="setup-footnote">Payout accounts can be assigned later. Combined crew shares cannot exceed 100%.</p>
        <div className="setup-actions"><button className="secondary-button" type="button" onClick={() => { setStep(1); setError('') }}>Back</button><button className="primary-button" type="button" onClick={() => mode && onComplete(mode, crewState)} disabled={!mode}>Finish setup</button></div>
      </div>}
    </section>
    {skipConfirmOpen && <div className="modal-backdrop setup-confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSkipConfirmOpen(false) }}>
      <section className="record-modal setup-skip-modal" role="alertdialog" aria-modal="true" aria-labelledby="skip-setup-title">
        <div className="record-modal-head"><div><span className="eyebrow">CONFIRM SKIP</span><h2 id="skip-setup-title">Skip workspace setup?</h2></div></div>
        <div className="clear-ledger-content"><p>Workspace type will remain unset, and this setup screen will not appear again. You can still add roles and crew later in Crew manager.</p></div>
        <div className="record-actions"><button className="secondary-button" type="button" onClick={() => setSkipConfirmOpen(false)}>Keep setting up</button><button className="primary-button" type="button" onClick={onSkip}>Skip setup</button></div>
      </section>
    </div>}
  </div>
}

function formatTickerChange(change: PriceChange | null, historyStatus: 'ready' | 'collecting' | 'stale') {
  if (!change) return <span className="ticker-change unavailable">{getTickerChangeLabel(change, historyStatus)}</span>
  const direction = change.amount > 0 ? 'up' : change.amount < 0 ? 'down' : 'flat'
  const prefix = change.amount > 0 ? '+' : change.amount < 0 ? '−' : ''
  return <span className={`ticker-change ${direction}`}>{prefix}{formatCredits(Math.abs(change.amount))} · {prefix}{Math.abs(change.percent).toFixed(2)}%</span>
}

function getTickerChangeLabel(change: PriceChange | null, historyStatus: 'ready' | 'collecting' | 'stale') {
  if (!change) return historyStatus === 'stale' ? '24-hour baseline stale' : historyStatus === 'collecting' ? 'collecting 24-hour history' : '24-hour change unavailable'
  const direction = change.amount > 0 ? 'up' : change.amount < 0 ? 'down' : 'unchanged'
  return `${direction} ${formatCredits(Math.abs(change.amount))}, ${Math.abs(change.percent).toFixed(2)} percent`
}

function DashboardTicker({ prices, priceState, history }: { prices: UexRow[]; priceState: DatasetState; history: MarketPriceSnapshot[] }) {
  const historyStatus = getMarketTickerHistoryStatus(history)
  const entries = getMarketTickerEntries(prices, history)
  const hasQuotes = priceState.status === 'ready' && entries.length > 0
  const statusMessage = priceState.status === 'loading' || priceState.status === 'idle'
    ? 'Loading commodity quotes…'
    : priceState.status === 'error'
      ? 'Commodity quotes are currently unavailable.'
      : !entries.length ? 'No current commodity quotes.'
        : historyStatus === 'collecting' ? 'Collecting 24-hour history; changes will appear after a full baseline is available.'
          : historyStatus === 'stale' ? '24-hour history is stale. New snapshots are being collected.'
            : ''
  const repeatedEntries = entries.length > 1 ? [...entries, ...entries] : entries

  return <section className="dashboard-ticker" aria-label="Commodity market ticker">
    <div className="dashboard-ticker-heading"><strong>COMMODITY MARKET</strong><span>MEDIAN TERMINAL QUOTES</span><span className="dashboard-ticker-window">24H CHANGE</span></div>
    {hasQuotes ? <div className="dashboard-ticker-viewport" role="region" aria-label="Commodity prices, horizontally scrollable" tabIndex={0}>
      <div className={`dashboard-ticker-track ${entries.length > 1 ? 'is-moving' : ''}`} role="list" style={entries.length > 1 ? { animationDuration: `${Math.max(24, entries.length * 3)}s` } : undefined}>
        {repeatedEntries.map((entry, index) => <div className="dashboard-ticker-item" role="listitem" key={`${entry.commodityId}-${index}`} aria-hidden={index >= entries.length} aria-label={`${entry.commodityName}: buy ${entry.buyPrice === null ? 'unavailable' : formatCredits(entry.buyPrice)}, ${getTickerChangeLabel(entry.buyChange, historyStatus)}; sell ${entry.sellPrice === null ? 'unavailable' : formatCredits(entry.sellPrice)}, ${getTickerChangeLabel(entry.sellChange, historyStatus)}`}>
          <strong className="dashboard-ticker-commodity">{entry.commodityName}</strong>
          <span className="dashboard-ticker-side"><small>BUY</small><b>{entry.buyPrice === null ? '—' : formatCredits(entry.buyPrice)}</b>{formatTickerChange(entry.buyChange, historyStatus)}</span>
          <span className="dashboard-ticker-side"><small>SELL</small><b>{entry.sellPrice === null ? '—' : formatCredits(entry.sellPrice)}</b>{formatTickerChange(entry.sellChange, historyStatus)}</span>
        </div>)}
      </div>
    </div> : <div className="dashboard-ticker-message" role="status">{statusMessage}</div>}
  </section>
}

function DashboardView({ financeState, hangarState, activeShip, crewState, routePlans, prices, priceState, marketHistory, onNavigate }: {
  financeState: FinanceState
  hangarState: HangarState
  activeShip?: HangarShip
  crewState: CrewState
  routePlans: PlannedRoute[]
  prices: UexRow[]
  priceState: DatasetState
  marketHistory: MarketPriceSnapshot[]
  onNavigate: (section: Section) => void
}) {
  const holdings = getCommodityHoldings(financeState)
  const totalBalance = financeState.accounts.reduce((sum, account) => sum + account.balance, 0)
  const ownedCargo = holdings.reduce((sum, holding) => sum + holding.quantity, 0)
  const recentEntries = financeState.transactions.slice(0, 5)
  const openRoutes = routePlans.filter((plan) => plan.status !== 'completed').sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const currentRoute = openRoutes.find((plan) => plan.status === 'purchased') ?? openRoutes[0]

  return <>
    <div className="dashboard-overview">
      <div className="dashboard-metric"><span>ACCOUNT BALANCE</span><strong>{formatCredits(totalBalance)}</strong><small>Across {financeState.accounts.length} accounts</small></div>
      <div className="dashboard-metric"><span>COMMODITY HOLDINGS</span><strong>{formatQuantity(ownedCargo)} SCU</strong><small>{holdings.length} tracked commodities</small></div>
      <div className="dashboard-metric"><span>ACTIVE SHIP</span><strong>{activeShip?.name ?? 'None selected'}</strong><small>{activeShip ? `${formatQuantity(getShipCargoUsed(hangarState, activeShip.id))} / ${formatQuantity(activeShip.cargoCapacity)} SCU used` : 'Choose a ship in your hangar'}</small></div>
      <div className="dashboard-metric"><span>CREW SHARE</span><strong>{getCrewSharePercent(crewState).toFixed(2)}%</strong><small>{crewState.members.length} members · future sales</small></div>
    </div>
    <DashboardTicker prices={prices} priceState={priceState} history={marketHistory} />
    <div className="dashboard-data-status"><span className={`status-dot ${priceState.status === 'ready' ? 'is-live' : priceState.status === 'loading' ? 'is-loading' : ''}`} /><span>{priceState.status === 'ready' ? `${prices.length.toLocaleString()} UEX price records loaded` : priceState.status === 'loading' ? 'Loading UEX market data' : priceState.status === 'error' ? 'UEX price data unavailable' : 'UEX price data idle'}</span><button type="button" onClick={() => onNavigate('commodities')}>Browse market data <span>↗</span></button></div>
    <div className="dashboard-columns">
      <section className="data-section dashboard-panel dashboard-activity-panel">
        <div className="section-toolbar"><div><h2>Recent activity</h2><span>Latest local account and trade records</span></div><button className="text-button" type="button" onClick={() => onNavigate('finance')}>Open ledger ↗</button></div>
        <div className="dashboard-activity-list">
          {recentEntries.map((entry) => {
            const routedToSource = (entry.crewShares ?? []).filter((share) => share.accountId === entry.accountId).reduce((sum, share) => sum + share.amount, 0)
            const accountChange = entry.side === 'buy' || entry.side === 'game_purchase'
              ? -entry.total
              : entry.side === 'sell'
                ? entry.total - (entry.crewShareTotal ?? 0) + routedToSource
                : entry.side === 'withdrawal' || entry.side === 'transfer' || entry.side === 'vehicle_purchase'
                  ? -entry.total
                  : entry.total
            const activityTitle = entry.side === 'transfer' ? 'Account transfer' : entry.side === 'deposit' ? 'Account deposit' : entry.side === 'withdrawal' ? 'Account withdrawal' : entry.side === 'vehicle_purchase' ? `Ship purchase · ${entry.commodity}` : entry.side === 'game_purchase' ? `In-game purchase · ${entry.commodity}` : entry.side === 'game_sale' ? `In-game sale · ${entry.commodity}` : entry.commodity
            return <div className="dashboard-activity-row" key={entry.id}>
              <span className={`trade-type ${entry.side === 'game_purchase' ? 'buy' : entry.side === 'game_sale' ? 'sell' : entry.side}`}>{entry.side === 'transfer' ? 'MOVE' : entry.side === 'vehicle_purchase' ? 'SHIP' : entry.side === 'game_purchase' ? 'GAME BUY' : entry.side === 'game_sale' ? 'GAME SALE' : entry.side.toUpperCase()}</span>
              <div className="dashboard-activity-copy"><strong>{activityTitle}</strong><small>{entry.accountName} · {formatDate(entry.recordedAt)}</small></div>
              <strong className={accountChange < 0 ? 'ledger-debit' : entry.side === 'transfer' ? 'ledger-transfer' : 'ledger-credit'}>{entry.side === 'transfer' ? '↔ ' : accountChange < 0 ? '−' : '+'}{formatCredits(Math.abs(accountChange))}</strong>
            </div>
          })}
          {!recentEntries.length && <div className="dashboard-empty"><strong>No recent activity</strong><span>Recorded trades and transfers will appear here.</span></div>}
        </div>
      </section>
      <section className="data-section dashboard-panel dashboard-route-panel">
        <div className="section-toolbar"><div><h2>Current route</h2><span>{currentRoute ? 'From your route planner' : 'No active route plan'}</span></div><button className="text-button" type="button" onClick={() => onNavigate('routePlanner')}>Open planner ↗</button></div>
        {currentRoute ? <div className="dashboard-route-content">
          <div className="dashboard-route-heading"><div><span className="dashboard-route-kicker">{currentRoute.commodity}</span><strong>{formatQuantity(currentRoute.status === 'purchased' ? currentRoute.purchasedQuantity ?? currentRoute.quantity : currentRoute.quantity)} SCU</strong></div><span className={`route-plan-status ${currentRoute.status === 'purchased' ? 'ready' : 'warning'}`}>{currentRoute.status === 'purchased' ? 'IN PROGRESS' : 'PLANNED'}</span></div>
          <div className="dashboard-route-legs"><div><small>BUY AT</small><strong title={currentRoute.buyTerminalName}>{currentRoute.buyTerminalName}</strong></div><span aria-hidden="true">→</span><div><small>SELL AT</small><strong title={currentRoute.sellTerminalName}>{currentRoute.sellTerminalName}</strong></div></div>
        </div> : <div className="dashboard-empty"><strong>No current route</strong><span>Plan a commodity run to see its pickup and drop-off here.</span><button className="text-button" type="button" onClick={() => onNavigate('routePlanner')}>Plan a route ↗</button></div>}
      </section>
      <section className="data-section dashboard-panel dashboard-accounts-panel">
        <div className="section-toolbar"><div><h2>All accounts</h2><span>{financeState.accounts.length} {financeState.accounts.length === 1 ? 'account' : 'accounts'} · {formatCredits(totalBalance)} total</span></div><span className="table-label">LOCAL</span></div>
        <div className="dashboard-account-list">
          {financeState.accounts.map((account) => <div className="dashboard-account-row" key={account.id}><div className="dashboard-account-copy"><strong>{account.name}</strong><small>Bank account</small></div><strong className="dashboard-account-balance">{formatCredits(account.balance)}</strong></div>)}
          {!financeState.accounts.length && <div className="dashboard-empty"><strong>No accounts yet</strong><span>Add a bank account in Money &amp; ledger to see balances here.</span></div>}
        </div>
      </section>
    </div>
  </>
}

function NavButton({ active, onClick, icon, label, count }: { active: boolean; onClick: () => void; icon: string; label: string; count?: number }) {
  return <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick} type="button"><span className="nav-icon" aria-hidden="true">{icon}</span><span>{label}</span>{count !== undefined && <span className="nav-count">{count.toLocaleString()}</span>}</button>
}

function ThemeSettingsView({ theme, onChange, onFactoryReset, gameChannel, gameInstallations, gameScanStatus, gameLogStatus, gameLogSupported, onGameChannelChange, onRescanGameInstallations, onChooseGameRoot, syncSettings }: {
  theme: AppTheme
  onChange: (theme: AppTheme) => void
  onFactoryReset: () => boolean
  gameChannel: GameChannel
  gameInstallations: GameInstallation[]
  gameScanStatus: GameScanStatus
  gameLogStatus: GameLogStatus
  gameLogSupported: boolean
  onGameChannelChange: (channel: GameChannel) => void
  onRescanGameInstallations: () => void
  onChooseGameRoot: () => void
  syncSettings: ReactNode
}) {
  const [resetOpen, setResetOpen] = useState(false)
  const [appearanceExpanded, setAppearanceExpanded] = useState(false)
  const [shutdownOpen, setShutdownOpen] = useState(false)
  const themes: { id: AppTheme; name: string; description: string; swatches: string[] }[] = [
    { id: 'field', name: 'UEX Field', description: 'The original green operations palette.', swatches: ['#202923', '#d9f76b', '#f4f6f3'] },
    { id: 'amber', name: 'Industrial Amber', description: 'Warm amber accents on a graphite workspace.', swatches: ['#29261f', '#efc36d', '#f6f2e9'] },
    { id: 'ice', name: 'Arctic Signal', description: 'Cool cyan accents with a pale blue workspace.', swatches: ['#202b33', '#7bd3d0', '#f1f5f7'] },
    { id: 'night', name: 'Night Ops', description: 'Deep teal surfaces with luminous cyan accents.', swatches: ['#080e11', '#61d4cf', '#152023'] },
    { id: 'redshift', name: 'Redshift', description: 'Near-black surfaces with warm coral signal accents.', swatches: ['#0d080b', '#ff8b77', '#211819'] },
  ]

  const selectedGameInstallation = gameInstallations.find((installation) => installation.channel === gameChannel)
  const gameScanLabel = gameScanStatus === 'checking' ? 'SCANNING' : gameScanStatus === 'unavailable' ? 'DESKTOP ONLY' : gameScanStatus === 'error' ? 'SCAN ERROR' : `${gameInstallations.length} FOUND`
  const gameLogMessage = gameScanStatus === 'unavailable'
    ? 'This standalone browser/mobile build works without Star Citizen.'
    : gameScanStatus === 'checking' ? 'Searching common install locations…'
      : gameScanStatus === 'error' ? 'Scan failed. Choose a folder or try scanning again.'
        : !selectedGameInstallation ? 'No installation detected. The app remains usable standalone.'
          : !gameLogSupported ? 'This app shell can detect installs, but live Game.log monitoring requires the desktop build.'
          : gameLogStatus === 'watching' ? 'Monitoring Game.log for shop transactions and flown ships.'
            : gameLogStatus === 'waiting' || gameLogStatus === 'waiting-for-log' ? 'Waiting for Game.log in this channel.'
              : gameLogStatus === 'error' ? 'Unable to read Game.log. Check that the install folder is accessible.'
                : 'Starting Game.log monitoring…'

  return <>
    <section className="data-section theme-settings-section">
      <div className="section-toolbar"><div><h2>Appearance</h2><span>Choose a color theme for this browser.</span></div><button className="secondary-button" type="button" aria-controls="appearance-options" aria-expanded={appearanceExpanded} onClick={() => setAppearanceExpanded((expanded) => !expanded)}>{appearanceExpanded ? 'Hide options' : 'Show options'}</button></div>
      <div id="appearance-options" hidden={!appearanceExpanded}>
        <div className="theme-choice-list" role="radiogroup" aria-label="App theme">
          {themes.map((option) => <button className={`theme-choice ${theme === option.id ? 'selected' : ''}`} type="button" role="radio" aria-checked={theme === option.id} key={option.id} onClick={() => onChange(option.id)}>
            <span className="theme-swatches" aria-hidden="true">{option.swatches.map((color) => <i key={color} style={{ backgroundColor: color }} />)}</span>
            <span className="theme-choice-copy"><strong>{option.name}</strong><small>{option.description}</small></span>
            <span className="theme-radio" aria-hidden="true" />
          </button>)}
        </div>
        <div className="table-note"><span>Your selection is saved in this browser.</span><span>Theme applies immediately.</span></div>
      </div>
    </section>
    <section className="data-section game-install-section">
      <div className="section-toolbar"><div><h2>Star Citizen</h2><span>Detect local installs and select an environment.</span></div><span className="table-label">{gameScanLabel}</span></div>
      <div className="game-install-content">
        <div className="game-channel-switch" role="radiogroup" aria-label="Star Citizen environment">
          {(['LIVE', 'PTU'] as const).map((channel) => {
            const installed = gameInstallations.some((installation) => installation.channel === channel)
            return <button className={`game-channel-choice ${gameChannel === channel ? 'selected' : ''}`} type="button" role="radio" aria-checked={gameChannel === channel} key={channel} onClick={() => onGameChannelChange(channel)}>
              <span>{channel}</span><small>{installed ? 'INSTALLED' : 'NOT DETECTED'}</small>
            </button>
          })}
        </div>
        <div className="game-install-summary">
          <strong>{selectedGameInstallation ? `${gameChannel} installation detected` : gameScanStatus === 'ready' ? `${gameChannel} installation not found` : 'Installation status'}</strong>
          <span className="game-install-path">{selectedGameInstallation?.path ?? gameLogMessage}</span>
          {selectedGameInstallation && <span className="game-install-path">{gameLogMessage}</span>}
          {gameScanStatus !== 'unavailable' && <div className="game-install-actions">
            <button className="secondary-button" type="button" disabled={gameScanStatus === 'checking'} onClick={onRescanGameInstallations}>Scan again</button>
            <button className="secondary-button" type="button" onClick={onChooseGameRoot}>Choose folder</button>
          </div>}
        </div>
      </div>
      <div className="table-note"><span>Channel selection is saved on this device.</span><span>Ship detection may appear after you leave the ship.</span></div>
    </section>
    {syncSettings}
    <section className="data-section settings-reset-section">
      <div className="section-toolbar"><div><h2>Factory reset</h2><span>Permanently clear personal operating data from this browser.</span></div><span className="table-label">DESTRUCTIVE ACTION</span></div>
      <div className="settings-reset-row"><div><strong>Reset local data</strong><span>Deletes ships and cargo, crew and roles, bank accounts, ledger history, pending Game.log activity, and saved route plans. Your UEX token and theme are kept.</span></div><button className="danger-button" type="button" onClick={() => setResetOpen(true)}>Factory reset</button></div>
    </section>
    {import.meta.env.DEV && <section className="data-section settings-reset-section">
      <div className="section-toolbar"><div><h2>Development server</h2><span>Stopping it disconnects this app until the server is restarted.</span></div><button className="danger-button" type="button" onClick={() => setShutdownOpen(true)}>Shutdown server</button></div>
    </section>}
    {resetOpen && <FactoryResetDialog onClose={() => setResetOpen(false)} onConfirm={() => { onFactoryReset(); setResetOpen(false) }} />}
    {shutdownOpen && <ShutdownDevServerDialog onClose={() => setShutdownOpen(false)} onConfirm={() => { setShutdownOpen(false); void fetch('/__shutdown', { method: 'POST' }).catch(() => undefined) }} />}
  </>
}

function ShutdownDevServerDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="record-modal clear-ledger-modal" role="alertdialog" aria-modal="true" aria-labelledby="shutdown-server-title">
      <div className="record-modal-head"><div><span className="eyebrow">DEVELOPMENT SERVER</span><h2 id="shutdown-server-title">Shut down the local server?</h2></div><button className="close-button" type="button" onClick={onClose} aria-label="Close confirmation">×</button></div>
      <div className="clear-ledger-content"><p>This stops Vite and disconnects this app.</p><p>Restart it from the project terminal with <code>npm run dev</code>.</p></div>
      <div className="record-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="danger-button" type="button" onClick={onConfirm}>Shutdown server</button></div>
    </section>
  </div>
}

function FactoryResetDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
  const [confirmation, setConfirmation] = useState('')
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="record-modal clear-ledger-modal factory-reset-modal" role="alertdialog" aria-modal="true" aria-labelledby="factory-reset-title">
      <div className="record-modal-head"><div><span className="eyebrow">PERMANENT ACTION</span><h2 id="factory-reset-title">Reset all personal data?</h2></div><button className="close-button" type="button" onClick={onClose} aria-label="Close confirmation">×</button></div>
      <div className="clear-ledger-content factory-reset-copy"><p>This deletes all ships, cargo allocations, crew members and roles, bank accounts, ledger entries, pending Game.log activity, and saved route plans. This cannot be undone.</p><p>Your UEX API token, theme, and UEX data are not affected.</p></div>
      <label className="factory-reset-confirmation"><span>Type RESET to confirm</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>
      <div className="record-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="danger-button confirm-clear-button" type="button" disabled={confirmation !== 'RESET'} onClick={onConfirm}>Reset everything</button></div>
    </section>
  </div>
}

function TradeView({ prices, priceState, commodities, selectedCommodity, setSelectedCommodity, cargo, setCargo, routes, onRefresh, onRecordTrade }: {
  prices: UexRow[]; priceState: DatasetState; commodities: string[]; selectedCommodity: string; setSelectedCommodity: (value: string) => void; cargo: number; setCargo: (value: number) => void; routes: { buyer: UexRow; seller: UexRow; quantity: number; unitMargin: number; grossMargin: number }[]; onRefresh: () => void; onRecordTrade: (side: TradeSide, row: UexRow, commodity: string, quantity: number) => void
}) {
  const top = routes[0]
  return <>
    <div className="trade-controls">
      <label className="control-group"><span>COMMODITY</span><select value={selectedCommodity} onChange={(event) => setSelectedCommodity(event.target.value)} disabled={!commodities.length}><option value="">{commodities.length ? 'Select commodity' : 'Waiting for price data'}</option>{commodities.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
      <label className="control-group cargo-control"><span>CARGO CAPACITY</span><div className="number-input"><input type="number" min="1" max="100000" value={cargo} onChange={(event) => setCargo(Math.max(1, Number(event.target.value) || 1))} /><span>SCU</span></div></label>
      <div className="trade-metric"><span>LOCATIONS MATCHED</span><strong>{new Set(prices.map((row) => readText(row, 'terminal_name')).filter(Boolean)).size.toLocaleString()}</strong></div>
      <div className="trade-metric"><span>POSITIVE SPREADS</span><strong>{routes.length ? routes.length.toString().padStart(2, '0') : '00'}</strong></div>
      <button className="icon-button control-refresh" type="button" onClick={onRefresh} title="Refresh market data" aria-label="Refresh market data">↻</button>
    </div>

    {priceState.status === 'error' && <ErrorPanel resource="Trade prices" message={priceState.error} />}
    {priceState.status === 'loading' && <LoadingPanel label="Loading terminal market data" />}
    {priceState.status === 'ready' && <>
      <section className="trade-summary">
        <div className="summary-copy"><div className="eyebrow">MARKET SPREAD SCAN</div><h2>{top ? `${selectedCommodity} · best gross spread` : 'No positive spread found'}</h2><p>{top ? `Buy at ${readText(top.buyer, 'terminal_name')} and sell at ${readText(top.seller, 'terminal_name')}.` : `No buy/sell combination with available stock for ${selectedCommodity || 'this commodity'}.`}</p></div>
        <div className="summary-number"><span>EST. GROSS PROFIT</span><strong>{top ? formatCredits(top.grossMargin) : '—'}</strong><small>{top ? `${top.quantity} SCU · before travel costs` : 'Select another commodity'}</small></div>
        <div className="summary-watermark" aria-hidden="true">UEX</div>
      </section>
      <section className="data-section">
        <div className="section-toolbar"><div><h2>Trade opportunities</h2><span>Sorted by estimated gross margin</span></div><span className="live-tag"><i /> LIVE MARKET</span></div>
        <div className="table-scroll"><table className="data-table route-table"><thead><tr><th>#</th><th>BUY AT</th><th>BUY PRICE</th><th>SELL AT</th><th>SELL PRICE</th><th>CAPACITY</th><th>UNIT SPREAD</th><th>GROSS PROFIT</th><th>ACTIONS</th></tr></thead><tbody>
          {routes.map((route, index) => <tr key={`${readText(route.buyer, 'id_terminal')}-${readText(route.seller, 'id_terminal')}`}>
            <td className="rank-cell">{String(index + 1).padStart(2, '0')}</td><td><strong>{readText(route.buyer, 'terminal_name')}</strong><small>{readText(route.buyer, 'id_terminal') ? `UEX #${readText(route.buyer, 'id_terminal')}` : 'Market location'}</small></td><td>{formatCredits(readNumber(route.buyer, 'price_buy'))}</td><td><strong>{readText(route.seller, 'terminal_name')}</strong><small>{readText(route.seller, 'id_terminal') ? `UEX #${readText(route.seller, 'id_terminal')}` : 'Market location'}</small></td><td>{formatCredits(readNumber(route.seller, 'price_sell'))}</td><td>{route.quantity.toLocaleString()} SCU</td><td className="positive">+{formatCredits(route.unitMargin)}</td><td className="profit-cell">{formatCredits(route.grossMargin)}</td><td className="route-actions"><button type="button" onClick={() => onRecordTrade('buy', route.buyer, selectedCommodity, route.quantity)}>Buy</button><button type="button" onClick={() => onRecordTrade('sell', route.seller, selectedCommodity, route.quantity)}>Sell</button></td>
          </tr>)}
          {!routes.length && <tr><td colSpan={9} className="empty-cell">No currently profitable spreads with reported stock.</td></tr>}
        </tbody></table></div>
        <div className="table-note"><span>Spread uses current listed prices × available SCU.</span><span>Travel time, fuel, and demand are not included.</span></div>
      </section>
    </>}
    <div className="disclaimer-strip"><span className="disclaimer-icon">i</span><span>UEX prices are community-reported estimates. Verify in-game before committing cargo.</span><span className="record-count">{prices.length.toLocaleString()} RECORDS</span></div>
  </>
}

function RoutePlannerView({ plans, prices, priceState, terminals, search, onAdd, onRemove, onConfirmBuy, onConfirmSale, onViewLedger }: {
  plans: PlannedRoute[]
  prices: UexRow[]
  priceState: DatasetState
  terminals: UexRow[]
  search: string
  onAdd: (route: NewPlannedRoute) => void
  onRemove: (routeId: string) => void
  onConfirmBuy: (plan: PlannedRoute) => void
  onConfirmSale: (plan: PlannedRoute) => void
  onViewLedger: (entryId: string) => void
}) {
  const [commodityChoice, setCommodityChoice] = useState('')
  const [buyChoice, setBuyChoice] = useState('')
  const [sellChoice, setSellChoice] = useState('')
  const initialContainers = getContainerSelection(100)
  const [containerSize, setContainerSize] = useState(String(initialContainers.size))
  const [containerCount, setContainerCount] = useState(String(initialContainers.count))
  const [formError, setFormError] = useState('')
  const commodityNames = [...new Set(prices.map((row) => readText(row, 'commodity_name')).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
  const commodity = commodityNames.includes(commodityChoice) ? commodityChoice : commodityNames[0] ?? ''
  const offers = getRouteMarketOffers(prices, terminals, commodity)
  const buyOffers = offers.filter((offer) => offer.buyPrice > 0 && offer.buyQuantity > 0)
  const buyTerminalId = buyOffers.some((offer) => offer.terminalId === buyChoice) ? buyChoice : buyOffers[0]?.terminalId ?? ''
  const buyOffer = buyOffers.find((offer) => offer.terminalId === buyTerminalId)
  const sellOffers = offers.filter((offer) => offer.sellPrice > 0 && offer.sellStock > 0 && offer.terminalId !== buyTerminalId)
  const sellTerminalId = sellOffers.some((offer) => offer.terminalId === sellChoice) ? sellChoice : sellOffers[0]?.terminalId ?? ''
  const sellOffer = sellOffers.find((offer) => offer.terminalId === sellTerminalId)
  const plannedQuantity = Number(containerSize) * Number(containerCount)
  const validQuantity = isContainerSizedQuantity(plannedQuantity) && Number.isInteger(Number(containerCount))
  const currentCapacity = buyOffer && sellOffer ? Math.min(buyOffer.buyQuantity, sellOffer.sellStock) : 0
  const estimatedCost = buyOffer && validQuantity ? buyOffer.buyPrice * plannedQuantity : 0
  const estimatedRevenue = sellOffer && validQuantity ? sellOffer.sellPrice * plannedQuantity : 0
  const estimatedProfit = buyOffer && sellOffer && validQuantity ? (sellOffer.sellPrice - buyOffer.buyPrice) * plannedQuantity : 0
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const visiblePlans = plans.filter((plan) => !normalizedSearch || `${plan.commodity} ${plan.buyTerminalName} ${plan.sellTerminalName}`.toLocaleLowerCase().includes(normalizedSearch))
  const quoteCache = new Map<string, RouteMarketOffer[]>()
  for (const plan of visiblePlans) {
    if (!quoteCache.has(plan.commodity)) quoteCache.set(plan.commodity, getRouteMarketOffers(prices, terminals, plan.commodity))
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!buyOffer || !sellOffer) {
      setFormError('Choose a terminal with a current buy quote and another with sell stock.')
      return
    }
    if (!validQuantity) {
      setFormError('Enter a planned quantity greater than zero.')
      return
    }
    onAdd({ commodity, buyTerminalId: buyOffer.terminalId, buyTerminalName: buyOffer.terminalName, sellTerminalId: sellOffer.terminalId, sellTerminalName: sellOffer.terminalName, quantity: plannedQuantity })
    setFormError('')
  }

  function changeContainerSize(nextSize: string) {
    const nextSizeNumber = Number(nextSize)
    setContainerCount(String(Math.floor(plannedQuantity / nextSizeNumber)))
    setContainerSize(nextSize)
  }

  return <>
    <section className="data-section route-planner-build">
      <div className="section-toolbar"><div><h2>Plan a route</h2><span>Choose a commodity, pickup, drop-off, and target quantity.</span></div><span className="table-label">LIVE UEX QUOTES</span></div>
      {priceState.status === 'loading' && <LoadingPanel label="Loading current terminal quotes" />}
      {priceState.status === 'error' && <ErrorPanel resource="Trade prices" message={priceState.error} />}
      {priceState.status === 'ready' && <form className="route-plan-form" onSubmit={submit}>
        <label className="route-plan-field"><span>COMMODITY</span><select value={commodity} onChange={(event) => { setCommodityChoice(event.target.value); setBuyChoice(''); setSellChoice('') }} disabled={!commodityNames.length}><option value="">Choose commodity</option>{commodityNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        <label className="route-plan-field"><span>BUY AT</span><select value={buyTerminalId} onChange={(event) => { setBuyChoice(event.target.value); setSellChoice('') }} disabled={!buyOffers.length}><option value="">No buy quote available</option>{buyOffers.map((offer) => <option key={offer.terminalId} value={offer.terminalId}>{offer.terminalName}{offer.location ? ` · ${offer.location}` : ''} · {formatQuantity(offer.buyQuantity)} SCU</option>)}</select></label>
        <label className="route-plan-field"><span>SELL AT</span><select value={sellTerminalId} onChange={(event) => setSellChoice(event.target.value)} disabled={!sellOffers.length}><option value="">No sell stock available</option>{sellOffers.map((offer) => <option key={offer.terminalId} value={offer.terminalId}>{offer.terminalName}{offer.location ? ` · ${offer.location}` : ''} · {formatQuantity(offer.sellStock)} SCU</option>)}</select></label>
        <label className="route-plan-field"><span>CONTAINER SIZE</span><select value={containerSize} onChange={(event) => changeContainerSize(event.target.value)}>{CONTAINER_SIZES.map((size) => <option key={size} value={size}>{size} SCU</option>)}</select></label>
        <label className="route-plan-field"><span>NUMBER OF CONTAINERS</span><div className="number-input"><input type="number" min="1" step="1" value={containerCount} onChange={(event) => setContainerCount(event.target.value)} required /><span>BOXES</span></div></label>
        {buyOffer && sellOffer && validQuantity && <div className={`route-plan-estimate ${plannedQuantity > currentCapacity ? 'warning' : estimatedProfit > 0 ? 'profitable' : 'unprofitable'}`}>
          <div><span>EST. BUY COST</span><strong>{formatCredits(estimatedCost)}</strong></div>
          <div><span>EST. SALE VALUE</span><strong>{formatCredits(estimatedRevenue)}</strong></div>
          <div><span>EST. GROSS MARGIN</span><strong>{estimatedProfit < 0 ? '−' : '+'}{formatCredits(Math.abs(estimatedProfit))}</strong></div>
          <div><span>MAX CURRENT VOLUME</span><strong>{formatQuantity(currentCapacity)} SCU</strong></div>
          <p>{plannedQuantity > currentCapacity ? `Planned amount exceeds the current ${formatQuantity(currentCapacity)} SCU available across these quotes.` : estimatedProfit > 0 ? 'This quantity fits the current reported market volume.' : 'Current sell price does not exceed the buy price.'}</p>
        </div>}
        {formError && <div className="form-error route-plan-error" role="alert">{formError}</div>}
        {!commodityNames.length && <div className="accounts-empty route-plan-empty"><strong>No commodity price records</strong><span>Refresh UEX data to load current terminal offers.</span></div>}
        <div className="route-plan-actions"><button className="primary-button" type="submit" disabled={!buyOffer || !sellOffer || !validQuantity}>Save route plan</button></div>
      </form>}
    </section>
    <section className="data-section route-plans-section">
      <div className="section-toolbar"><div><h2>Saved routes</h2><span>{plans.length} saved {plans.length === 1 ? 'route' : 'routes'} · quotes update with UEX data</span></div><span className="table-label">SAVED LOCALLY</span></div>
      <div className="table-scroll"><table className="data-table route-plan-table"><thead><tr><th>COMMODITY / QUANTITY</th><th>BUY AT</th><th>SELL AT</th><th>EST. GROSS MARGIN</th><th>STATUS</th><th>ORDERS</th><th>LEDGER</th><th></th></tr></thead><tbody>
        {visiblePlans.map((plan) => {
          const planOffers = quoteCache.get(plan.commodity) ?? []
          const currentBuy = planOffers.find((offer) => offer.terminalId === plan.buyTerminalId)
          const currentSell = planOffers.find((offer) => offer.terminalId === plan.sellTerminalId)
          const capacity = currentBuy && currentSell ? Math.min(currentBuy.buyQuantity, currentSell.sellStock) : 0
          const hasQuotes = Boolean(currentBuy && currentSell && priceState.status === 'ready')
          const estimateQuantity = plan.purchasedQuantity ?? plan.quantity
          const profit = hasQuotes && currentBuy && currentSell ? (currentSell.sellPrice - currentBuy.buyPrice) * estimateQuantity : 0
          const exceedsVolume = hasQuotes && plan.quantity > capacity
          const marketStatus = priceState.status === 'loading' || priceState.status === 'idle' ? 'Quotes updating' : priceState.status === 'error' || !hasQuotes ? 'Quote unavailable' : exceedsVolume ? `Above ${formatQuantity(capacity)} SCU` : profit > 0 ? 'Fits current quotes' : 'No positive margin'
          const status = plan.status === 'completed' ? 'Route completed' : plan.status === 'purchased' ? `Bought ${formatQuantity(plan.purchasedQuantity ?? plan.quantity)} SCU` : marketStatus
          const statusClass = plan.status !== 'planned' ? 'ready' : !hasQuotes ? 'unavailable' : exceedsVolume || profit <= 0 ? 'warning' : 'ready'
          return <tr key={plan.id}>
            <td><strong>{plan.commodity}</strong><small>{formatQuantity(plan.quantity)} SCU planned{plan.purchasedQuantity ? ` · ${formatQuantity(plan.purchasedQuantity)} SCU bought` : ''}</small></td>
            <td><strong>{plan.buyTerminalName}</strong><small>{currentBuy ? `${currentBuy.location ? `${currentBuy.location} · ` : ''}${formatCredits(currentBuy.buyPrice)} · ${formatQuantity(currentBuy.buyQuantity)} SCU available` : 'Current quote unavailable'}</small></td>
            <td><strong>{plan.sellTerminalName}</strong><small>{currentSell ? `${currentSell.location ? `${currentSell.location} · ` : ''}${formatCredits(currentSell.sellPrice)} · ${formatQuantity(currentSell.sellStock)} SCU stock` : 'Current quote unavailable'}</small></td>
            <td className={profit > 0 ? 'route-plan-profit' : profit < 0 ? 'ledger-debit' : ''}>{hasQuotes ? `${profit < 0 ? '−' : '+'}${formatCredits(Math.abs(profit))}` : '—'}</td>
            <td><span className={`route-plan-status ${statusClass}`}>{status}</span></td>
            <td className="route-plan-order-actions">{plan.status === 'planned' ? <button className="secondary-button" type="button" disabled={!hasQuotes} onClick={() => onConfirmBuy(plan)}>Confirm buy</button> : plan.status === 'purchased' ? <button className="primary-button" type="button" onClick={() => onConfirmSale(plan)}>Confirm sale</button> : <span>Complete</span>}</td>
            <td className="route-plan-ledger-links">{plan.buyLedgerEntryId && <button className="text-button" type="button" onClick={() => onViewLedger(plan.buyLedgerEntryId!)}>Buy ↗</button>}{plan.sellLedgerEntryId && <button className="text-button" type="button" onClick={() => onViewLedger(plan.sellLedgerEntryId!)}>Sale ↗</button>}</td>
            <td><button className="remove-account" type="button" onClick={() => onRemove(plan.id)} aria-label={`Remove ${plan.commodity} route plan`} title="Remove route plan">×</button></td>
          </tr>
        })}
        {!visiblePlans.length && <tr><td colSpan={8} className="empty-cell">{plans.length ? 'No saved routes match this search.' : 'No routes planned yet. Build a route above to save your first plan.'}</td></tr>}
      </tbody></table></div>
      <div className="table-note"><span>Saving a plan does not record a trade; confirmed orders create ledger entries.</span><span>Estimates exclude travel costs and fees.</span></div>
    </section>
  </>
}

function FinanceView({ state, pendingGameTransactions, search, initialTab, onAddAccount, onRemoveAccount, onRecordTrade, onMakeTransaction, onClearLedger, onNotice, onConfirmGameTransaction, onDismissGameTransaction }: {
  state: FinanceState
  pendingGameTransactions: PendingGameTransaction[]
  search: string
  initialTab: 'ledger' | 'accounts'
  onAddAccount: (name: string, balance: number) => void
  onRemoveAccount: (id: string) => void
  onRecordTrade: () => void
  onMakeTransaction: (kind: AccountTransactionKind, accountId: string, destinationId: string, amount: number, note: string) => string
  onClearLedger: () => boolean
  onNotice: (message: string) => void
  onConfirmGameTransaction: (eventId: string, accountId: string) => boolean
  onDismissGameTransaction: (eventId: string) => void
}) {
  const [tab, setTab] = useState<'ledger' | 'accounts'>(initialTab)
  const [addingAccount, setAddingAccount] = useState(false)
  const [accountName, setAccountName] = useState('')
  const [openingBalance, setOpeningBalance] = useState('0')
  const [confirmRemove, setConfirmRemove] = useState('')
  const [transactionOpen, setTransactionOpen] = useState(false)
  const [clearLedgerOpen, setClearLedgerOpen] = useState(false)
  const [pendingAccountIds, setPendingAccountIds] = useState<Record<string, string>>({})
  const totalBalance = state.accounts.reduce((sum, account) => sum + account.balance, 0)
  const totalVolume = state.transactions.reduce((sum, entry) => sum + (entry.side === 'buy' || entry.side === 'sell' ? entry.total : 0), 0)
  const realizedProfitLoss = getRealizedProfitLoss(state)
  const entries = state.transactions.filter((entry) => !search || [entry.id, entry.commodity, entry.terminal, entry.accountName, entry.transferToAccountName ?? '', entry.note, entry.side].some((value) => value.toLowerCase().includes(search.toLowerCase())))

  async function exportLedger() {
    const csv = createLedgerCsv(entries, realizedProfitLoss)
    const fileName = `sc-command-hub-ledger-${new Date().toISOString().slice(0, 10)}.csv`

    try {
      if (Capacitor.isNativePlatform()) {
        const file = await Filesystem.writeFile({ path: fileName, data: csv, directory: Directory.Cache, encoding: Encoding.UTF8 })
        await Share.share({ title: 'SC Command Hub ledger', text: `${entries.length} ledger entries`, url: file.uri, dialogTitle: 'Export ledger CSV' })
        onNotice('Ledger CSV ready to share.')
        return
      }

      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = fileName
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      onNotice('Ledger CSV downloaded.')
    } catch {
      onNotice('Unable to export the ledger CSV.')
    }
  }

  function submitAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const balance = Number(openingBalance)
    if (!accountName.trim()) return
    if (!Number.isFinite(balance) || balance < 0) return
    onAddAccount(accountName, balance)
    setAccountName('')
    setOpeningBalance('0')
    setAddingAccount(false)
  }

  return <>
    <div className="finance-overview">
      <div><span>TOTAL aUEC BALANCE</span><strong>{formatCredits(totalBalance)}</strong><small>Across {state.accounts.length} {state.accounts.length === 1 ? 'account' : 'accounts'}</small></div>
      <div><span>LEDGER ENTRIES</span><strong>{state.transactions.length.toLocaleString()}</strong><small>Locally recorded activity</small></div>
      <div><span>RECORDED TRADE VOLUME</span><strong>{formatCredits(totalVolume)}</strong><small>Buy + sell transaction value</small></div>
      <div className="finance-overview-actions"><button className="secondary-button" type="button" onClick={() => setTransactionOpen(true)}>+ Make transaction</button><button className="primary-button" type="button" onClick={onRecordTrade}>+ Record trade</button></div>
    </div>
    <div className="finance-tabs" role="tablist" aria-label="Money workspace">
      <button type="button" role="tab" aria-selected={tab === 'ledger'} className={tab === 'ledger' ? 'selected' : ''} onClick={() => setTab('ledger')}>Ledger <span>{state.transactions.length}</span></button>
      <button type="button" role="tab" aria-selected={tab === 'accounts'} className={tab === 'accounts' ? 'selected' : ''} onClick={() => setTab('accounts')}>Bank accounts <span>{state.accounts.length}</span></button>
    </div>
    {tab === 'ledger' && pendingGameTransactions.length > 0 && <section className="data-section pending-game-section">
      <div className="section-toolbar"><div><h2>Pending Game.log activity</h2><span>{pendingGameTransactions.length} successful in-game {pendingGameTransactions.length === 1 ? 'transaction' : 'transactions'} awaiting account assignment</span></div><span className="table-label">NOT POSTED</span></div>
      <div className="pending-game-list">{pendingGameTransactions.map((pending) => {
        const selectedAccountId = pendingAccountIds[pending.id] ?? ''
        const itemDescription = pending.itemName.replace(/_/g, ' ')
        const shopDescription = pending.shopName.replace(/^SCShop_/, '').replace(/_/g, ' ')
        return <div className="pending-game-row" key={pending.id}>
          <div className="pending-game-item"><span className={`trade-type ${pending.kind}`}>{pending.kind === 'buy' ? 'BUY' : 'SELL'}</span><div><strong>{itemDescription}</strong><small>{shopDescription} · {pending.channel} · {formatDate(pending.recordedAt)}</small></div></div>
          <div className="pending-game-amount"><strong className={pending.kind === 'buy' ? 'ledger-debit' : 'ledger-credit'}>{pending.kind === 'buy' ? '−' : '+'}{formatCredits(pending.total)}</strong><small>{pending.quantity} × {formatCredits(pending.unitPrice)} aUEC</small></div>
          <label className="pending-game-account"><span>ACCOUNT</span><select value={selectedAccountId} onChange={(event) => setPendingAccountIds((previous) => ({ ...previous, [pending.id]: event.target.value }))} aria-label={`Account for ${itemDescription}`}>
            <option value="">Choose account</option>
            {state.accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}
          </select></label>
          <div className="pending-game-actions"><button className="primary-button" type="button" disabled={!selectedAccountId} onClick={() => {
            if (onConfirmGameTransaction(pending.id, selectedAccountId)) setPendingAccountIds((previous) => { const next = { ...previous }; delete next[pending.id]; return next })
          }}>Confirm</button><button className="text-button" type="button" onClick={() => { onDismissGameTransaction(pending.id); setPendingAccountIds((previous) => { const next = { ...previous }; delete next[pending.id]; return next }) }}>Dismiss</button></div>
        </div>
      })}</div>
      <div className="table-note"><span>Detected values come from successful Game.log shop responses.</span><span>Balances update only after confirmation.</span></div>
    </section>}
    {tab === 'ledger' && <section className="data-section finance-ledger">
      <div className="section-toolbar"><div><h2>Transaction ledger</h2><span>Sale shares are routed to each member’s payout account.</span></div><div className="ledger-toolbar-actions"><span className="table-label">LOCAL RECORDS</span><button className="secondary-button" type="button" disabled={!entries.length} onClick={() => { void exportLedger() }}>Export CSV</button><button className="danger-button" type="button" disabled={!state.transactions.length} onClick={() => setClearLedgerOpen(true)}>⌫ Clear ledger</button></div></div>
      <div className="table-scroll"><table className="data-table ledger-table"><thead><tr><th>DATE / TIME</th><th>TYPE</th><th>COMMODITY</th><th>LOCATION</th><th>QUANTITY</th><th>UNIT PRICE</th><th>ACCOUNT</th><th>GROSS</th><th>CREW SHARE</th><th>ACCOUNT NET</th><th>REALIZED P&amp;L</th></tr></thead><tbody>
        {entries.map((entry) => {
          const isTrade = entry.side === 'buy' || entry.side === 'sell'
          const isGameTransaction = entry.side === 'game_purchase' || entry.side === 'game_sale'
          const accountNet = entry.side === 'sell'
            ? entry.total - (entry.crewShareTotal ?? 0) + (entry.crewShares ?? []).filter((share) => share.accountId === entry.accountId).reduce((sum, share) => sum + share.amount, 0)
            : entry.total
          const netClass = entry.side === 'buy' || entry.side === 'withdrawal' || entry.side === 'vehicle_purchase' || entry.side === 'game_purchase' ? 'ledger-debit' : entry.side === 'sell' || entry.side === 'deposit' || entry.side === 'game_sale' ? 'ledger-credit' : 'ledger-transfer'
          const netPrefix = entry.side === 'transfer' ? '↔ ' : entry.side === 'buy' || entry.side === 'withdrawal' || entry.side === 'vehicle_purchase' || entry.side === 'game_purchase' ? '−' : '+'
          const entryName = entry.side === 'transfer' ? 'Account transfer' : entry.side === 'deposit' ? 'Account deposit' : entry.side === 'withdrawal' ? 'Account withdrawal' : entry.side === 'vehicle_purchase' ? `Ship purchase · ${entry.commodity}` : entry.side === 'game_purchase' ? `In-game purchase · ${entry.commodity}` : entry.side === 'game_sale' ? `In-game sale · ${entry.commodity}` : entry.commodity
          const typeLabel = entry.side === 'vehicle_purchase' ? 'SHIP' : entry.side === 'game_purchase' ? 'GAME BUY' : entry.side === 'game_sale' ? 'GAME SALE' : entry.side.toUpperCase()
          const realized = realizedProfitLoss.get(entry.id)
          return <tr key={entry.id}>
            <td>{formatDate(entry.recordedAt)}</td>
            <td><span className={`trade-type ${entry.side === 'game_purchase' ? 'buy' : entry.side === 'game_sale' ? 'sell' : entry.side}`}>{typeLabel}</span></td>
            <td className="primary-cell">{entryName}</td>
            <td>{entry.terminal}</td>
            <td>{isTrade ? <>{entry.quantity.toLocaleString()} SCU{entry.containerSize && entry.containerCount ? <small>{entry.containerCount} × {entry.containerSize} SCU {entry.containerCount === 1 ? 'container' : 'containers'}</small> : null}</> : isGameTransaction ? `${entry.quantity.toLocaleString()} ${entry.quantity === 1 ? 'item' : 'items'}` : '—'}</td>
            <td>{isTrade || isGameTransaction ? formatCredits(entry.unitPrice) : '—'}</td>
            <td>{entry.side === 'transfer' ? `${entry.accountName} → ${entry.transferToAccountName || 'Removed account'}` : entry.accountName}</td>
            <td>{entry.side === 'transfer' ? '—' : formatCredits(entry.total)}</td>
            <td className="crew-share-cell">{entry.crewShares?.length ? <><span>-{formatCredits(entry.crewShareTotal ?? 0)}</span><small>{entry.crewShares.map((share) => `${share.memberName} ${share.sharePercent}% · ${formatCredits(share.amount)} → ${share.accountName || 'Unassigned'}`).join(' | ')}</small></> : '—'}</td>
            <td className={netClass}>{netPrefix}{formatCredits(accountNet)}</td>
            <td className={realized === undefined || realized === null ? 'ledger-pnl-unavailable' : realized > 0 ? 'ledger-pnl-positive' : realized < 0 ? 'ledger-pnl-negative' : 'ledger-pnl-neutral'}>{entry.side === 'sell' ? realized === undefined || realized === null ? 'Basis unavailable' : `${realized > 0 ? '+' : realized < 0 ? '−' : ''}${formatCredits(Math.abs(realized))}` : entry.side === 'buy' ? 'Unrealized' : '—'}</td>
          </tr>
        })}
        {!entries.length && <tr><td colSpan={11} className="empty-cell">{state.transactions.length ? 'No transactions match this search.' : 'No transactions recorded yet. Start from a trade route or record one directly.'}</td></tr>}
      </tbody></table></div>
      <div className="table-note"><span>Realized P&amp;L uses FIFO purchase cost and deducts crew shares.</span><span>Transactions are stored in this browser only.</span></div>
    </section>}
    {tab === 'accounts' && <section className="data-section accounts-section">
      <div className="section-toolbar"><div><h2>Bank accounts</h2><span>Separate aUEC balances for your own tracking</span></div><div className="account-toolbar-actions"><button className="secondary-button" type="button" onClick={() => setTransactionOpen(true)}>+ Make transaction</button><button className="secondary-button" type="button" onClick={() => setAddingAccount((value) => !value)}>{addingAccount ? 'Cancel' : '+ Add account'}</button></div></div>
      {addingAccount && <form className="account-form" onSubmit={submitAccount}>
        <label><span>ACCOUNT NAME</span><input autoFocus value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder="e.g. Main wallet" maxLength={40} required /></label>
        <label><span>OPENING BALANCE</span><div className="number-input"><input type="number" min="0" step="0.01" value={openingBalance} onChange={(event) => setOpeningBalance(event.target.value)} required /><span>aUEC</span></div></label>
        <button className="primary-button" type="submit">Create account</button>
      </form>}
      <div className="account-list">
        {state.accounts.map((account) => <div className="account-row" key={account.id}>
          <span className="account-mark">◉</span><div className="account-copy"><strong>{account.name}</strong><small>Created {formatDate(account.createdAt)}</small></div><strong className="account-balance">{formatCredits(account.balance)}</strong>
          {confirmRemove === account.id ? <div className="remove-confirm"><span>Remove?</span><button type="button" onClick={() => { onRemoveAccount(account.id); setConfirmRemove('') }}>Confirm</button><button type="button" onClick={() => setConfirmRemove('')}>Cancel</button></div> : <button className="remove-account" type="button" onClick={() => setConfirmRemove(account.id)} aria-label={`Remove ${account.name}`} title={`Remove ${account.name}`}>×</button>}
        </div>)}
        {!state.accounts.length && <div className="accounts-empty"><strong>No accounts yet</strong><span>Create an account with an opening aUEC balance to start recording trades.</span><button className="secondary-button" type="button" onClick={() => setAddingAccount(true)}>+ Add your first account</button></div>}
      </div>
      <div className="table-note"><span>Removing an account does not delete its ledger entries.</span><span>Account balances update when trades are recorded.</span></div>
    </section>}
    <div className="disclaimer-strip"><span className="disclaimer-icon">i</span><span>Money and trade records are local tracking tools, not connected to in-game bank balances.</span></div>
    {transactionOpen && <MoneyTransactionDialog accounts={state.accounts} onClose={() => setTransactionOpen(false)} onSubmit={onMakeTransaction} onAddAccount={() => { setTransactionOpen(false); setTab('accounts'); setAddingAccount(true) }} />}
    {clearLedgerOpen && <ClearLedgerDialog onClose={() => setClearLedgerOpen(false)} onConfirm={() => { onClearLedger(); setClearLedgerOpen(false) }} />}
  </>
}

function ClearLedgerDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="record-modal clear-ledger-modal" role="alertdialog" aria-modal="true" aria-labelledby="clear-ledger-title">
      <div className="record-modal-head"><div><span className="eyebrow">PERMANENT ACTION</span><h2 id="clear-ledger-title">Clear all ledger entries?</h2></div><button className="close-button" type="button" onClick={onClose} aria-label="Close confirmation">×</button></div>
      <div className="clear-ledger-content"><p>This removes all buy, sell, deposit, withdrawal, and transfer history. Cargo holdings derived from trades will also be cleared.</p><p>Your bank accounts and current balances will remain unchanged. This cannot be undone.</p></div>
      <div className="record-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="danger-button confirm-clear-button" type="button" onClick={onConfirm}>Clear ledger</button></div>
    </section>
  </div>
}

function CrewManagerView({ crewState, transactions, accounts, search, onAdd, onAssignRole, onUpdateShare, onUpdatePayoutAccount, onRemove, onAddRole, onUpdateRoleDefault, onRemoveRole }: {
  crewState: CrewState
  transactions: FinanceState['transactions']
  accounts: BankAccount[]
  search: string
  onAdd: (name: string, roleId: string | null, sharePercent: number, payoutAccountId: string | null) => string
  onAssignRole: (memberId: string, roleId: string | null) => string
  onUpdateShare: (memberId: string, sharePercent: number) => string
  onUpdatePayoutAccount: (memberId: string, payoutAccountId: string | null) => string
  onRemove: (member: CrewMember) => void
  onAddRole: (name: string, defaultSharePercent: number) => string
  onUpdateRoleDefault: (roleId: string, defaultSharePercent: number) => string
  onRemoveRole: (role: CrewRole) => void
}) {
  const [name, setName] = useState('')
  const [roleId, setRoleId] = useState('')
  const [sharePercent, setSharePercent] = useState('')
  const [payoutAccountId, setPayoutAccountId] = useState('')
  const [error, setError] = useState('')
  const [roleName, setRoleName] = useState('')
  const [roleDefaultShare, setRoleDefaultShare] = useState('')
  const [roleError, setRoleError] = useState('')
  const totalSharePercent = getCrewSharePercent(crewState)
  const totalPaid = transactions.reduce((sum, entry) => sum + (entry.crewShareTotal ?? 0), 0)
  const sortedRoles = [...crewState.roles].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
  const visibleMembers = crewState.members.filter((member) => {
    const roleName = crewState.roles.find((role) => role.id === member.roleId)?.name ?? ''
    return `${member.name} ${roleName}`.toLowerCase().includes(search.trim().toLowerCase())
  })
  const visibleRoles = sortedRoles.filter((role) => role.name.toLowerCase().includes(search.trim().toLowerCase()))
  const selectedRole = crewState.roles.find((role) => role.id === roleId)
  const pendingSharePercent = selectedRole?.defaultSharePercent ?? Math.max(0, Number(sharePercent) || 0)
  const remainingSharePercent = 100 - totalSharePercent - pendingSharePercent
  const sharesWouldExceedLimit = remainingSharePercent < 0

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const message = onAdd(name, roleId || null, Number(sharePercent), payoutAccountId || null)
    if (message) {
      setError(message)
      return
    }
    setName('')
    setRoleId('')
    setSharePercent('')
    setPayoutAccountId('')
    setError('')
  }

  function submitRole(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const message = onAddRole(roleName, Number(roleDefaultShare))
    if (message) {
      setRoleError(message)
      return
    }
    setRoleName('')
    setRoleDefaultShare('')
    setRoleError('')
  }

  return <>
    <div className="crew-overview">
      <div><span>CREW MEMBERS</span><strong>{crewState.members.length}</strong><small>Shares applied to future sales</small></div>
      <div><span>ALLOCATED SHARE</span><strong>{totalSharePercent.toFixed(2)}%</strong><small>{(100 - totalSharePercent).toFixed(2)}% not allocated to crew</small></div>
      <div><span>RECORDED PAYOUTS</span><strong>{formatCredits(totalPaid)}</strong><small>Across saved sale entries</small></div>
    </div>
    <section className="data-section crew-manager-section">
      <div className="section-toolbar"><div><h2>Crew shares</h2><span>Shares are deducted from gross proceeds and credited to each member’s payout account.</span></div><span className="table-label">LOCAL CREW</span></div>
      <form className="crew-add-form" onSubmit={submit}>
        <label><span>CREW MEMBER</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name" maxLength={40} required /></label>
        <label><span>ROLE</span><select value={roleId} onChange={(event) => { const nextRoleId = event.target.value; setRoleId(nextRoleId); setSharePercent(String(crewState.roles.find((role) => role.id === nextRoleId)?.defaultSharePercent ?? '')) }}><option value="">Manual share</option>{sortedRoles.map((role) => <option key={role.id} value={role.id}>{role.name} · {role.defaultSharePercent}%</option>)}</select></label>
        <label><span>{selectedRole ? 'ROLE DEFAULT' : 'MANUAL SHARE'}</span><div className="number-input"><input type="number" min="0" max="100" step="0.01" value={sharePercent} onChange={(event) => setSharePercent(event.target.value)} placeholder="0" disabled={Boolean(selectedRole)} required /><span>%</span></div></label>
        <label><span>PAYOUT ACCOUNT</span><select value={payoutAccountId} onChange={(event) => setPayoutAccountId(event.target.value)} required={Number(sharePercent) > 0}><option value="">{accounts.length ? 'Choose account' : 'Add bank account first'}</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
        <div className={`crew-share-remaining ${sharesWouldExceedLimit ? 'over-limit' : ''}`} aria-live="polite"><span>REMAINING AFTER ADD</span><strong>{sharesWouldExceedLimit ? `Over by ${Math.abs(remainingSharePercent).toFixed(2)}%` : `${remainingSharePercent.toFixed(2)}%`}</strong></div>
        <button className="primary-button" type="submit">+ Add crew member</button>
      </form>
      {error && <div className="form-error crew-form-error" role="alert">{error}</div>}
      <div className="crew-list">
        {visibleMembers.map((member) => {
          const paid = transactions.reduce((sum, entry) => sum + (entry.crewShares?.find((share) => share.memberId === member.id)?.amount ?? 0), 0)
          return <CrewMemberRow key={`${member.id}-${member.roleId ?? 'manual'}-${member.sharePercent}`} member={member} roles={sortedRoles} accounts={accounts} paid={paid} onAssignRole={onAssignRole} onUpdate={onUpdateShare} onUpdatePayoutAccount={onUpdatePayoutAccount} onRemove={onRemove} />
        })}
        {!visibleMembers.length && <div className="accounts-empty"><strong>{crewState.members.length ? 'No crew members match this search' : 'No crew shares configured'}</strong><span>{crewState.members.length ? 'Try another name.' : 'Add a crew member to deduct a percentage from future sale proceeds.'}</span></div>}
      </div>
      <div className="table-note"><span>Combined shares cannot exceed 100%; every nonzero share needs a payout account.</span><span>Sales are blocked until all payout destinations are set.</span></div>
    </section>
    <section className="data-section crew-manager-section role-manager-section">
      <div className="section-toolbar"><div><h2>Roles &amp; default shares</h2><span>Assign a role to apply its default share to a crew member.</span></div><span className="table-label">{crewState.roles.length} {crewState.roles.length === 1 ? 'ROLE' : 'ROLES'}</span></div>
      <form className="crew-add-form crew-role-add-form" onSubmit={submitRole}>
        <label><span>ROLE NAME</span><input value={roleName} onChange={(event) => setRoleName(event.target.value)} placeholder="e.g. Pilot" maxLength={40} required /></label>
        <label><span>DEFAULT SHARE</span><div className="number-input"><input type="number" min="0" max="100" step="0.01" value={roleDefaultShare} onChange={(event) => setRoleDefaultShare(event.target.value)} placeholder="0" required /><span>%</span></div></label>
        <button className="primary-button" type="submit">+ Add role</button>
      </form>
      {roleError && <div className="form-error crew-form-error" role="alert">{roleError}</div>}
      <div className="crew-role-list">
        {visibleRoles.map((role) => <CrewRoleRow key={`${role.id}-${role.defaultSharePercent}`} role={role} assignedCount={crewState.members.filter((member) => member.roleId === role.id).length} onUpdate={onUpdateRoleDefault} onRemove={onRemoveRole} />)}
        {!visibleRoles.length && <div className="accounts-empty"><strong>{crewState.roles.length ? 'No roles match this search' : 'No roles configured'}</strong><span>{crewState.roles.length ? 'Try another role name.' : 'Add roles to apply consistent default shares to crew members.'}</span></div>}
      </div>
      <div className="table-note"><span>Updating a role default changes all members assigned to it.</span><span>Removing a role keeps members and their current shares.</span></div>
    </section>
    <div className="disclaimer-strip"><span className="disclaimer-icon">i</span><span>Crew payouts are local ledger calculations. They are not transferred to in-game accounts.</span></div>
  </>
}

function CrewMemberRow({ member, roles, accounts, paid, onAssignRole, onUpdate, onUpdatePayoutAccount, onRemove }: {
  member: CrewMember
  roles: CrewRole[]
  accounts: BankAccount[]
  paid: number
  onAssignRole: (memberId: string, roleId: string | null) => string
  onUpdate: (memberId: string, sharePercent: number) => string
  onUpdatePayoutAccount: (memberId: string, payoutAccountId: string | null) => string
  onRemove: (member: CrewMember) => void
}) {
  const [sharePercent, setSharePercent] = useState(String(member.sharePercent))
  const [error, setError] = useState('')

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const message = onUpdate(member.id, Number(sharePercent))
    setError(message)
    if (!message) setSharePercent(String(Number(sharePercent)))
  }

  return <article className="crew-row">
    <div className="crew-member-copy"><strong>{member.name}</strong><small>{roles.find((role) => role.id === member.roleId)?.name ?? 'No role'} · Paid to date: {formatCredits(paid)}</small></div>
    <label className="crew-member-role"><span>ROLE</span><select value={member.roleId ?? ''} onChange={(event) => setError(onAssignRole(member.id, event.target.value || null))}><option value="">Manual share</option>{roles.map((role) => <option key={role.id} value={role.id}>{role.name} · {role.defaultSharePercent}%</option>)}</select></label>
    <label className="crew-member-payout"><span>PAYOUT ACCOUNT</span><select value={member.payoutAccountId ?? ''} onChange={(event) => setError(onUpdatePayoutAccount(member.id, event.target.value || null))}><option value="">{accounts.length ? 'Choose account' : 'Add bank account first'}</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
    <form className="crew-share-form" onSubmit={submit}>
      <label><span>{member.roleId ? 'ROLE SHARE' : 'MANUAL SHARE'}</span><div className="number-input"><input type="number" min="0" max="100" step="0.01" value={sharePercent} onChange={(event) => setSharePercent(event.target.value)} aria-label={`${member.name} share percentage`} disabled={Boolean(member.roleId)} /><span>%</span></div></label>
      {!member.roleId && <button className="secondary-button" type="submit" disabled={Number(sharePercent) === member.sharePercent}>Save share</button>}
    </form>
    <button className="remove-account" type="button" onClick={() => onRemove(member)} aria-label={`Remove ${member.name}`} title={`Remove ${member.name}`}>×</button>
    {error && <div className="crew-row-error" role="alert">{error}</div>}
  </article>
}

function CrewRoleRow({ role, assignedCount, onUpdate, onRemove }: {
  role: CrewRole
  assignedCount: number
  onUpdate: (roleId: string, defaultSharePercent: number) => string
  onRemove: (role: CrewRole) => void
}) {
  const [defaultShare, setDefaultShare] = useState(String(role.defaultSharePercent))
  const [error, setError] = useState('')

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const message = onUpdate(role.id, Number(defaultShare))
    setError(message)
  }

  return <article className="crew-role-row">
    <div className="crew-member-copy"><strong>{role.name}</strong><small>{assignedCount} {assignedCount === 1 ? 'crew member' : 'crew members'} assigned</small></div>
    <form className="crew-share-form" onSubmit={submit}>
      <label><span>DEFAULT SHARE</span><div className="number-input"><input type="number" min="0" max="100" step="0.01" value={defaultShare} onChange={(event) => setDefaultShare(event.target.value)} aria-label={`${role.name} default share percentage`} /><span>%</span></div></label>
      <button className="secondary-button" type="submit" disabled={Number(defaultShare) === role.defaultSharePercent}>Save default</button>
    </form>
    <button className="remove-account" type="button" onClick={() => onRemove(role)} aria-label={`Remove ${role.name} role`} title={`Remove ${role.name} role`}>×</button>
    {error && <div className="crew-row-error" role="alert">{error}</div>}
  </article>
}

function MoneyTransactionDialog({ accounts, onClose, onSubmit, onAddAccount }: {
  accounts: BankAccount[]
  onClose: () => void
  onSubmit: (kind: AccountTransactionKind, accountId: string, destinationId: string, amount: number, note: string) => string
  onAddAccount: () => void
}) {
  const [kind, setKind] = useState<AccountTransactionKind>('deposit')
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [toId, setToId] = useState(accounts.find((account) => account.id !== accounts[0]?.id)?.id ?? '')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const account = accounts.find((item) => item.id === accountId)
  const destination = accounts.find((account) => account.id === toId)
  const amountValue = Number(amount)
  const isTransfer = kind === 'transfer'
  const maxAmount = kind === 'withdrawal' || isTransfer ? account?.balance : undefined
  const transactionSummary = kind === 'deposit'
    ? `Deposit to ${account?.name || 'account'}`
    : kind === 'withdrawal'
      ? `Withdraw from ${account?.name || 'account'}`
      : `${account?.name || 'Source'} → ${destination?.name || 'Destination'}`

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const message = onSubmit(kind, accountId, isTransfer ? toId : '', amountValue, note)
    setError(message)
    if (!message) onClose()
  }

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="record-modal transfer-modal" role="dialog" aria-modal="true" aria-labelledby="account-transaction-title">
      <div className="record-modal-head"><div><span className="eyebrow">LOCAL ACCOUNT ACTIVITY</span><h2 id="account-transaction-title">Make transaction</h2></div><button className="close-button" type="button" onClick={onClose} aria-label="Close transaction form">×</button></div>
      {!accounts.length ? <div className="no-account-prompt"><p>Add a bank account before recording deposits, withdrawals, or transfers.</p><button className="primary-button" type="button" onClick={onAddAccount}>Add bank account</button></div> : <form onSubmit={submit}>
        <div className="side-switch account-transaction-switch" role="group" aria-label="Transaction type">
          <button type="button" className={kind === 'deposit' ? 'active buy-active' : ''} onClick={() => { setKind('deposit'); setError('') }}>Deposit</button>
          <button type="button" className={kind === 'withdrawal' ? 'active sell-active' : ''} onClick={() => { setKind('withdrawal'); setError('') }}>Withdrawal</button>
          <button type="button" className={kind === 'transfer' ? 'active' : ''} onClick={() => { setKind('transfer'); setError('') }}>Transfer</button>
        </div>
        {isTransfer && accounts.length < 2 && <div className="no-account-prompt account-transaction-prompt"><p>Add a second bank account to transfer funds.</p><button className="secondary-button" type="button" onClick={onAddAccount}>Add another account</button></div>}
        <div className="record-fields account-transaction-fields">
          <label className="record-field"><span>{isTransfer ? 'FROM ACCOUNT' : kind === 'deposit' ? 'DEPOSIT TO' : 'WITHDRAW FROM'}</span><select value={accountId} onChange={(event) => { setAccountId(event.target.value); if (event.target.value === toId) setToId(accounts.find((item) => item.id !== event.target.value)?.id ?? '') }} required>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · {formatCredits(item.balance)}</option>)}</select></label>
          {isTransfer && <label className="record-field"><span>TO ACCOUNT</span><select value={toId} onChange={(event) => setToId(event.target.value)} required>{accounts.filter((item) => item.id !== accountId).map((item) => <option key={item.id} value={item.id}>{item.name} · {formatCredits(item.balance)}</option>)}</select></label>}
          <label className="record-field"><span>AMOUNT</span><div className="number-input record-number"><input type="number" min="0.01" max={maxAmount} step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required /><span>aUEC</span></div>{maxAmount !== undefined && <small className="available-balance">Available: {formatCredits(maxAmount)}</small>}</label>
          <label className="record-field record-note"><span>NOTE <small>OPTIONAL</small></span><input value={note} onChange={(event) => setNote(event.target.value)} maxLength={120} placeholder="Reason or reference" /></label>
        </div>
        <div className="transfer-summary"><span>{transactionSummary}</span><strong>{amountValue > 0 ? formatCredits(amountValue) : 'Enter amount'}</strong></div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="record-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={isTransfer && accounts.length < 2}>Record {kind}</button></div>
      </form>}
    </section>
  </div>
}

function groupByManufacturer<T>(items: T[], getManufacturer: (item: T) => string, getName: (item: T) => string) {
  const groups = new Map<string, T[]>()
  for (const item of [...items].sort((left, right) => {
    const manufacturerOrder = getManufacturer(left).localeCompare(getManufacturer(right), undefined, { sensitivity: 'base' })
    return manufacturerOrder || getName(left).localeCompare(getName(right), undefined, { sensitivity: 'base' })
  })) {
    const manufacturer = getManufacturer(item) || 'Unknown manufacturer'
    groups.set(manufacturer, [...(groups.get(manufacturer) ?? []), item])
  }
  return [...groups.entries()]
}

function HangarView({ hangarState, candidates, vehicles, purchaseRows, terminals, selectedVehicleId, setSelectedVehicleId, onAdd, onSetActive, onRemove }: {
  hangarState: HangarState
  candidates: UexRow[]
  vehicles: UexRow[]
  purchaseRows: UexRow[]
  terminals: UexRow[]
  selectedVehicleId: string
  setSelectedVehicleId: (value: string) => void
  onAdd: () => void
  onSetActive: (shipId: string | null) => void
  onRemove: (ship: HangarShip) => void
}) {
  const [detailShip, setDetailShip] = useState<HangarShip | null>(null)
  const { ships, activeShipId } = hangarState
  const activeShip = ships.find((ship) => ship.id === activeShipId)
  const availableShips = candidates.filter((vehicle) => !ships.some((ship) => ship.vehicleId === readText(vehicle, 'id')))
  const candidateGroups = groupByManufacturer(availableShips, (vehicle) => readText(vehicle, 'company_name') || 'Unknown manufacturer', (vehicle) => readText(vehicle, 'name'))
  const shipGroups = groupByManufacturer(ships, (ship) => ship.manufacturer || 'Unknown manufacturer', (ship) => ship.name)
  const detailVehicle = detailShip
    ? vehicles.find((vehicle) => readText(vehicle, 'id') === detailShip.vehicleId) ?? {
      id: detailShip.vehicleId,
      name: detailShip.name,
      company_name: detailShip.manufacturer,
      scu: detailShip.cargoCapacity,
      url_photo: detailShip.photoUrl,
    }
    : null

  function showShipDetails(ship: HangarShip) {
    setDetailShip(ship)
  }

  return <>
    <div className="hangar-toolbar">
      <label className="control-group"><span>ADD FROM UEX SHIP REGISTRY</span><select value={selectedVehicleId} onChange={(event) => setSelectedVehicleId(event.target.value)} disabled={!availableShips.length}><option value="">{availableShips.length ? 'Select a ship' : 'All listed ships are in your hangar'}</option>{candidateGroups.map(([manufacturer, group]) => <optgroup key={manufacturer} label={manufacturer}>{group.map((vehicle) => <option key={readText(vehicle, 'id')} value={readText(vehicle, 'id')}>{readText(vehicle, 'name')} · {readNumber(vehicle, 'scu')} SCU</option>)}</optgroup>)}</select></label>
      <button className="primary-button" type="button" disabled={!selectedVehicleId} onClick={onAdd}>+ Add to hangar</button>
      <span className="table-label">{ships.length} {ships.length === 1 ? 'SHIP' : 'SHIPS'}</span>
    </div>
    {activeShip ? <section className="active-ship-panel">
      <div className="active-ship-identity">{activeShip.photoUrl ? <img src={activeShip.photoUrl} alt="" referrerPolicy="no-referrer" /> : <div className="ship-placeholder" aria-hidden="true">▰</div>}<div><span className="eyebrow">ACTIVE SHIP</span><h2>{activeShip.name}</h2><p>{activeShip.manufacturer || 'Manufacturer not listed'}</p></div></div>
      <div className="ship-capacity"><span>CARGO HOLD</span><strong>{formatQuantity(getShipCargoUsed(hangarState, activeShip.id))} / {formatQuantity(activeShip.cargoCapacity)} SCU</strong><div className="capacity-track"><i style={{ width: `${activeShip.cargoCapacity ? Math.min(100, getShipCargoUsed(hangarState, activeShip.id) / activeShip.cargoCapacity * 100) : 0}%` }} /></div></div>
      <button className="secondary-button active-ship-details" type="button" onClick={() => showShipDetails(activeShip)}>Full ship details</button>
    </section> : <div className="hangar-empty"><strong>No active ship selected</strong><span>Add a ship from the UEX registry, then set it active to manage its cargo hold.</span></div>}
    <section className="data-section hangar-section"><div className="section-toolbar"><div><h2>Personal fleet</h2><span>Ship specifications are from UEX; cargo assignments are stored locally.</span></div><span className="table-label">LOCAL HANGAR</span></div>
      <div className="hangar-list">{shipGroups.map(([manufacturer, group]) => <div className="hangar-manufacturer-group" key={manufacturer}><h3>{manufacturer}</h3>{group.map((ship) => <article className={`hangar-ship ${ship.id === activeShipId ? 'is-active' : ''}`} key={ship.id}>
        <button className="hangar-ship-details" type="button" onClick={() => showShipDetails(ship)} aria-label={`View details for ${ship.name}`}>
          <span className="hangar-ship-image">{ship.photoUrl ? <img src={ship.photoUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span aria-hidden="true">▰</span>}</span>
          <span className="hangar-ship-info"><strong>{ship.name}</strong><small>{ship.cargoCapacity > 0 ? `${formatQuantity(ship.cargoCapacity)} SCU cargo capacity` : 'No cargo capacity listed'}</small></span>
        </button>
        {ship.id === activeShipId ? <span className="active-ship-tag">ACTIVE</span> : <button className="secondary-button" type="button" onClick={() => onSetActive(ship.id)}>Set active</button>}
        <button className="remove-account hangar-remove" type="button" onClick={() => onRemove(ship)} aria-label={`Remove ${ship.name} from hangar`} title="Remove ship">×</button>
      </article>)}</div>)}{!ships.length && <div className="accounts-empty"><strong>Your hangar is empty</strong><span>Add a ship using the UEX registry above.</span></div>}</div>
    </section>
    <div className="disclaimer-strip"><span className="disclaimer-icon">i</span><span>UEX cargo capacity is a published reference. This app does not read a live in-game ship hold.</span></div>
    {detailShip && detailVehicle && <VehicleDetailsDialog vehicle={detailVehicle} offers={purchaseRows.filter((offer) => readText(offer, 'id_vehicle') === detailShip.vehicleId)} terminals={terminals} hangarShip={detailShip} isActive={detailShip.id === activeShipId} cargoUsed={getShipCargoUsed(hangarState, detailShip.id)} cargoByCommodity={hangarState.cargoByShip[detailShip.id] ?? {}} onClose={() => setDetailShip(null)} />}
  </>
}

function CargoAllocationControl({ unassigned, loaded, freeCapacity, onLoad, onUnload }: { unassigned: number; loaded: number; freeCapacity: number; onLoad: (quantity: number) => void; onUnload: (quantity: number) => void }) {
  const maxLoad = Math.max(0, Math.min(unassigned, freeCapacity))
  const maxTransfer = Math.max(maxLoad, loaded)
  const initialTransfer = maxLoad > 0 && loaded > 0 ? Math.min(maxLoad, loaded) : maxTransfer
  const initialContainers = getContainerSelection(initialTransfer)
  const [containerSize, setContainerSize] = useState(String(initialContainers.size))
  const [containerCount, setContainerCount] = useState(String(initialContainers.count))
  const size = Number(containerSize)
  const count = Number(containerCount)
  const quantity = size * count
  const maximumCount = Math.floor(maxTransfer / size)
  const loadCount = Math.floor(maxLoad / size)
  const unloadCount = Math.floor(loaded / size)
  const validCount = isContainerSizedQuantity(quantity) && Number.isInteger(count)
  const availableSizes = CONTAINER_SIZES.filter((container) => container <= maxTransfer)

  function changeContainerSize(nextSize: string) {
    const sizeNumber = Number(nextSize)
    const nextCount = Math.min(Math.floor(quantity / sizeNumber) || 1, Math.floor(maxTransfer / sizeNumber))
    setContainerSize(nextSize)
    setContainerCount(String(nextCount))
  }

  return <div className="cargo-allocation-control">
    <label className="cargo-container-field"><span>SIZE</span><select value={containerSize} onChange={(event) => changeContainerSize(event.target.value)}>{(availableSizes.length ? availableSizes : [1]).map((container) => <option key={container} value={container}>{container} SCU</option>)}</select></label>
    <label className="cargo-container-field cargo-container-count"><span>CONTAINERS</span><div className="number-input"><input type="number" min={maximumCount ? 1 : 0} max={maximumCount || undefined} step="1" value={containerCount} onChange={(event) => setContainerCount(event.target.value)} aria-label="Number of cargo containers" /><span>BOXES</span></div><small>{formatQuantity(quantity)} SCU</small></label>
    <button type="button" className="secondary-button" disabled={!validCount || count > loadCount} onClick={() => onLoad(quantity)}>Load</button>
    <button type="button" className="secondary-button" disabled={!validCount || count > unloadCount} onClick={() => onUnload(quantity)}>Unload</button>
    {maxTransfer > 0 && maxTransfer < 1 && <small className="cargo-container-warning">Remainder is below the 1-SCU minimum.</small>}
  </div>
}

function HoldingsView({ holdings, prices, state, search, activeShip, hangarState, financeState, activeShipFree, onAllocate, onSell }: {
  holdings: ReturnType<typeof getCommodityHoldings>
  prices: UexRow[]
  state: DatasetState
  search: string
  activeShip?: HangarShip
  hangarState: HangarState
  financeState: FinanceState
  activeShipFree: number
  onAllocate: (action: 'load' | 'unload', shipId: string, commodity: string, quantity: number) => void
  onSell: (commodity: string, quantity: number) => void
}) {
  const filtered = holdings.filter((holding) => !search || holding.commodity.toLowerCase().includes(search.toLowerCase()))
  const totalQuantity = filtered.reduce((sum, holding) => sum + holding.quantity, 0)
  const fleetQuantity = holdings.reduce((sum, holding) => sum + getAssignedQuantity(hangarState, holding.commodity), 0)
  return <>
    <div className="holdings-summary"><div><span>UNSOLD COMMODITIES</span><strong>{filtered.length}</strong><small>Based on recorded buys minus sales</small></div><div><span>OWNED CARGO</span><strong>{formatQuantity(totalQuantity)} SCU</strong><small>Across all recorded commodities</small></div><div><span>ACTIVE SHIP HOLD</span><strong>{activeShip ? `${formatQuantity(getShipCargoUsed(hangarState, activeShip.id))} / ${formatQuantity(activeShip.cargoCapacity)} SCU` : 'No active ship'}</strong><small>{activeShip ? activeShip.name : 'Choose one in Personal hangar'}</small></div><div><span>ASSIGNED TO FLEET</span><strong>{formatQuantity(fleetQuantity)} SCU</strong><small>Across all ships in your hangar</small></div></div>
    <section className="data-section holdings-section">
      <div className="section-toolbar"><div><h2>Cargo holdings</h2><span>{filtered.length} commodities with unclosed quantities</span></div><span className="table-label">LOCAL INVENTORY</span></div>
      {state.status === 'error' && <div className="holdings-market-warning">UEX sell quotes are unavailable. Your recorded cargo is still shown.</div>}
      {!activeShip && <div className="holdings-market-warning">Select an active ship in Personal hangar to load cargo and sell from its hold. Unassigned holdings remain available.</div>}
      <div className="table-scroll"><table className="data-table holdings-table"><thead><tr><th>COMMODITY</th><th>OWNED</th><th>ON ACTIVE SHIP</th><th>UNASSIGNED</th><th>AVG. BUY PRICE</th><th>BEST SELL QUOTE</th><th>SELL AT</th><th>CARGO</th><th></th></tr></thead><tbody>
        {filtered.map((holding) => {
          const quotes = prices.filter((row) => readText(row, 'commodity_name') === holding.commodity && readNumber(row, 'price_sell') > 0 && readNumber(row, 'scu_sell_stock') > 0).sort((left, right) => readNumber(right, 'price_sell') - readNumber(left, 'price_sell'))
          const best = quotes[0]
          const loaded = activeShip ? getShipCargoQuantity(hangarState, activeShip.id, holding.commodity) : 0
          const unassigned = getUnassignedQuantity(financeState, hangarState, holding.commodity)
          return <tr key={holding.commodity}><td className="primary-cell">{holding.commodity}</td><td className="holding-quantity">{formatQuantity(holding.quantity)} SCU</td><td>{formatQuantity(loaded)} SCU</td><td>{formatQuantity(unassigned)} SCU</td><td>{formatCredits(holding.averagePurchasePrice)}</td><td>{best ? formatCredits(readNumber(best, 'price_sell')) : '—'}</td><td>{best ? readText(best, 'terminal_name') : state.status === 'loading' ? 'Loading quote…' : 'No active quote'}</td><td>{activeShip ? <CargoAllocationControl key={`${holding.commodity}-${loaded}-${unassigned}-${activeShipFree}`} unassigned={unassigned} loaded={loaded} freeCapacity={activeShipFree} onLoad={(quantity) => onAllocate('load', activeShip.id, holding.commodity, quantity)} onUnload={(quantity) => onAllocate('unload', activeShip.id, holding.commodity, quantity)} /> : '—'}</td><td><button className="holdings-sell-button" type="button" disabled={!best || (!loaded && !unassigned)} onClick={() => onSell(holding.commodity, loaded || unassigned)}>Sell</button></td></tr>
        })}
        {!filtered.length && <tr><td colSpan={9} className="empty-cell">{holdings.length ? 'No holdings match this search.' : 'No recorded commodity holdings. Record a buy to add cargo here.'}</td></tr>}
      </tbody></table></div>
      <div className="table-note"><span>Loading moves owned cargo into the active ship without changing ownership.</span><span>Unloading returns it to unassigned holdings.</span></div>
    </section>
    <div className="disclaimer-strip"><span className="disclaimer-icon">i</span><span>Sale records reduce ownership and the selected ship’s hold. UEX does not execute the trade.</span></div>
  </>
}

function RecordTradeDialog({ preset, prices, accounts, crewMembers, hangarState, onClose, onSubmit, onAddAccount }: {
  preset: TradePreset
  prices: UexRow[]
  accounts: BankAccount[]
  crewMembers: CrewMember[]
  hangarState: HangarState
  onClose: () => void
  onSubmit: (trade: NewTrade, shipId?: string) => string
  onAddAccount: () => void
}) {
  const [side, setSide] = useState<TradeSide>(preset.side)
  const [commodity, setCommodity] = useState(preset.commodity)
  const [terminal, setTerminal] = useState(preset.terminal)
  const initialContainers = getContainerSelection(preset.quantity > 0 ? preset.quantity : 1)
  const [containerSize, setContainerSize] = useState(String(initialContainers.size))
  const [containerCount, setContainerCount] = useState(String(initialContainers.count))
  const [unitPrice, setUnitPrice] = useState(String(preset.unitPrice || ''))
  const [accountId, setAccountId] = useState(accounts.some((account) => account.id === preset.accountId) ? preset.accountId ?? '' : accounts[0]?.id ?? '')
  const [shipId, setShipId] = useState(preset.shipId ?? '')
  const [note, setNote] = useState(preset.note ?? '')
  const [error, setError] = useState('')
  const quantity = Number(containerSize) * Number(containerCount)
  const validContainerQuantity = isContainerSizedQuantity(quantity) && Number.isInteger(Number(containerCount))
  const invalidSavedRouteQuantity = Boolean(preset.routePlanId && !isContainerSizedQuantity(preset.quantity))
  const availableRows = prices.filter((row) => readText(row, 'commodity_name') === commodity
    && readNumber(row, side === 'buy' ? 'price_buy' : 'price_sell') > 0
    && readNumber(row, side === 'buy' ? 'scu_buy' : 'scu_sell_stock') > 0)
  const terminalNames = [...new Set(availableRows.map((row) => readText(row, 'terminal_name')).filter(Boolean))]
  const total = Math.round((Number(quantity) * Number(unitPrice)) * 100) / 100
  const crewSharePercent = side === 'sell' ? crewMembers.reduce((sum, member) => sum + member.sharePercent, 0) : 0
  const crewPayoutPreview = side === 'sell'
    ? previewCrewPayouts(total, crewMembers, accounts, accountId)
    : { payouts: [], crewShareTotal: 0, accountNet: total }
  const crewShareTotal = crewPayoutPreview.crewShareTotal
  const netSale = crewPayoutPreview.accountNet
  const payoutSummary = crewPayoutPreview.payouts.map((share) => `${share.memberName} → ${share.accountName}`).join(', ')

  function selectSide(nextSide: TradeSide) {
    setSide(nextSide)
    const nextRows = prices.filter((row) => readText(row, 'commodity_name') === commodity
      && readNumber(row, nextSide === 'buy' ? 'price_buy' : 'price_sell') > 0
      && readNumber(row, nextSide === 'buy' ? 'scu_buy' : 'scu_sell_stock') > 0)
    const first = nextRows[0]
    setTerminal(first ? readText(first, 'terminal_name') : '')
    setUnitPrice(first ? String(readNumber(first, nextSide === 'buy' ? 'price_buy' : 'price_sell')) : '')
    setError('')
  }

  function selectCommodity(nextCommodity: string) {
    setCommodity(nextCommodity)
    const nextRows = prices.filter((row) => readText(row, 'commodity_name') === nextCommodity
      && readNumber(row, side === 'buy' ? 'price_buy' : 'price_sell') > 0
      && readNumber(row, side === 'buy' ? 'scu_buy' : 'scu_sell_stock') > 0)
    const first = nextRows[0]
    setTerminal(first ? readText(first, 'terminal_name') : '')
    setUnitPrice(first ? String(readNumber(first, side === 'buy' ? 'price_buy' : 'price_sell')) : '')
    setError('')
  }

  function selectTerminal(nextTerminal: string) {
    setTerminal(nextTerminal)
    const match = availableRows.find((row) => readText(row, 'terminal_name') === nextTerminal)
    if (match) setUnitPrice(String(readNumber(match, side === 'buy' ? 'price_buy' : 'price_sell')))
  }

  function changeContainerSize(nextSize: string) {
    const nextSizeNumber = Number(nextSize)
    setContainerCount(String(Math.floor(quantity / nextSizeNumber)))
    setContainerSize(nextSize)
    setError('')
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (invalidSavedRouteQuantity) {
      setError('This saved route has a fractional SCU quantity. Replace it with a whole-container route before trading.')
      return
    }
    if (!validContainerQuantity) {
      setError('Enter a whole number of containers.')
      return
    }
    const message = onSubmit({ side, commodity, terminal, quantity, unitPrice: Number(unitPrice), accountId, note: note.trim(), containerSize: Number(containerSize), containerCount: Number(containerCount) }, shipId || undefined)
    if (message) setError(message)
  }

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="record-modal" role="dialog" aria-modal="true" aria-labelledby="record-trade-title">
      <div className="record-modal-head"><div><span className="eyebrow">LOCAL LEDGER ENTRY</span><h2 id="record-trade-title">{preset.routePlanId ? `Confirm planned ${side}` : 'Record a trade'}</h2></div><button className="close-button" type="button" onClick={onClose} aria-label="Close trade form">×</button></div>
      {!accounts.length ? <div className="no-account-prompt"><p>Add a bank account before recording trades. Its balance will update with each buy or sale.</p><button className="primary-button" type="button" onClick={onAddAccount}>Add bank account</button></div> : <form onSubmit={submit}>
        {preset.routePlanId ? <div className="route-confirmation-note">Commodity, terminal, and container quantity are locked to this saved route plan.</div> : <div className="side-switch" role="group" aria-label="Trade direction"><button type="button" className={side === 'buy' ? 'active buy-active' : ''} onClick={() => selectSide('buy')}>Buy commodity</button><button type="button" className={side === 'sell' ? 'active sell-active' : ''} onClick={() => selectSide('sell')}>Sell commodity</button></div>}
        <div className="record-fields">
          <label className="record-field"><span>COMMODITY</span><select value={commodity} onChange={(event) => selectCommodity(event.target.value)} required disabled={Boolean(preset.routePlanId)}><option value="">Select commodity</option>{[...new Set(prices.map((row) => readText(row, 'commodity_name')).filter(Boolean))].sort((a, b) => a.localeCompare(b)).map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
          <label className="record-field"><span>TERMINAL / LOCATION</span><input list="record-terminal-options" value={terminal} onChange={(event) => selectTerminal(event.target.value)} placeholder="Choose or enter a location" required readOnly={Boolean(preset.routePlanId)} /><datalist id="record-terminal-options">{terminalNames.map((name) => <option key={name} value={name} />)}</datalist></label>
          <label className="record-field"><span>ACCOUNT</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)} required>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {formatCredits(account.balance)}</option>)}</select></label>
          <label className="record-field"><span>{side === 'buy' ? 'LOAD PURCHASE INTO' : 'SELL CARGO FROM'}</span><select value={shipId} onChange={(event) => setShipId(event.target.value)}><option value="">Unassigned cargo</option>{hangarState.ships.map((ship) => <option key={ship.id} value={ship.id}>{ship.name} · {side === 'buy' ? `${formatQuantity(Math.max(0, ship.cargoCapacity - getShipCargoUsed(hangarState, ship.id)))} SCU free` : `${formatQuantity(getShipCargoQuantity(hangarState, ship.id, commodity))} SCU loaded`}</option>)}</select></label>
          <label className="record-field"><span>CONTAINER SIZE</span><select value={containerSize} onChange={(event) => changeContainerSize(event.target.value)} disabled={Boolean(preset.routePlanId) || invalidSavedRouteQuantity}>{CONTAINER_SIZES.map((size) => <option key={size} value={size}>{size} SCU</option>)}</select></label>
          <label className="record-field"><span>NUMBER OF CONTAINERS</span><div className="number-input record-number"><input type="number" min="1" step="1" value={containerCount} onChange={(event) => setContainerCount(event.target.value)} required readOnly={Boolean(preset.routePlanId) || invalidSavedRouteQuantity} /><span>BOXES</span></div></label>
          <label className="record-field"><span>PRICE PER SCU</span><div className="number-input record-number"><input type="number" min="0.01" step="0.01" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} required /><span>aUEC</span></div></label>
          <label className="record-field record-note"><span>NOTE <small>OPTIONAL</small></span><input value={note} onChange={(event) => setNote(event.target.value)} maxLength={120} placeholder="Route, cargo, or other details" /></label>
        </div>
        <div className={`trade-total ${side}`}><span>{side === 'buy' ? 'ACCOUNT DEBIT' : 'SALE ACCOUNT CHANGE'} <small>{side === 'buy' ? `${containerCount || 0} × ${containerSize} SCU containers · ${quantity || 0} SCU · ${Number(unitPrice) ? formatCredits(Number(unitPrice)) : '—'} per SCU` : `${containerCount || 0} × ${containerSize} SCU containers · ${formatCredits(total)} gross − ${formatCredits(crewShareTotal)} crew (${crewSharePercent.toFixed(2)}%)${payoutSummary ? ` · ${payoutSummary}` : ''}`}</small></span><strong>{formatCredits(side === 'buy' ? total : netSale)}</strong></div>
        {invalidSavedRouteQuantity && <div className="form-error" role="alert">This saved route has a fractional SCU amount and cannot be confirmed in container units. Replace it with a whole-container route.</div>}
        {side === 'sell' && crewPayoutPreview.error && <div className="form-error" role="alert">{crewPayoutPreview.error}</div>}
        <p className="record-disclaimer">This updates your local account and ledger only. It does not submit a trade to UEX or Star Citizen, or validate cargo inventory.</p>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="record-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={!validContainerQuantity || invalidSavedRouteQuantity || (side === 'sell' && Boolean(crewPayoutPreview.error))}>Record {side}</button></div>
      </form>}
    </section>
  </div>
}

function CommodityView({ rows, state, search }: { rows: UexRow[]; state: DatasetState; search: string }) {
  if (state.status === 'loading' || state.status === 'idle') return <LoadingPanel label="Loading commodity catalog" />
  if (state.status === 'error') return <ErrorPanel resource="Commodities" message={state.error} />
  const catalogMode = rows.some((row) => Boolean(readText(row, 'kind')))
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const grouped = new Map<string, { label: string; items: Map<string, { row: UexRow; name: string; marketRows: UexRow[] }> }>()
  for (const row of rows) {
    const name = readText(row, 'commodity_name', 'name').trim()
    if (!name) continue
    const kind = readText(row, 'kind').trim() || (catalogMode ? 'Uncategorized' : 'Market listings')
    const searchText = [name, readText(row, 'code'), kind, readText(row, 'wiki'), readText(row, 'terminal_name')].join(' ').toLocaleLowerCase()
    if (normalizedSearch && !searchText.includes(normalizedSearch)) continue
    const groupKey = kind.toLocaleLowerCase()
    const group = grouped.get(groupKey) ?? { label: kind, items: new Map() }
    const itemKey = catalogMode ? readText(row, 'id') || name.toLocaleLowerCase() : name.toLocaleLowerCase()
    const item = group.items.get(itemKey) ?? { row, name, marketRows: [] }
    if (!catalogMode) item.marketRows.push(row)
    group.items.set(itemKey, item)
    grouped.set(groupKey, group)
  }
  const typeGroups = [...grouped.values()].map((group) => ({ label: group.label, items: [...group.items.values()].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })) }))
    .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' }))
  const itemCount = typeGroups.reduce((total, group) => total + group.items.length, 0)
  const propertyFlags: [string, string][] = [
    ['Raw', 'is_raw'], ['Pure', 'is_pure'], ['Refined', 'is_refined'], ['Refinable', 'is_refinable'],
    ['Mineral', 'is_mineral'], ['Extractable', 'is_extractable'], ['Harvestable', 'is_harvestable'],
    ['Buyable', 'is_buyable'], ['Sellable', 'is_sellable'], ['Illegal', 'is_illegal'],
    ['Temporary', 'is_temporary'], ['Fuel', 'is_fuel'], ['Explosive', 'is_explosive'],
    ['Inert', 'is_inert'], ['Quantum volatile', 'is_volatile_qt'], ['Time volatile', 'is_volatile_time'],
  ]

  return <section className="data-section directory-section commodity-directory">
    <div className="section-toolbar"><div><h2>Commodity catalog</h2><span>{itemCount.toLocaleString()} goods across {typeGroups.length.toLocaleString()} types</span></div><span className="table-label">UEX DIRECTORY</span></div>
    <div className="commodity-type-list">
      {typeGroups.map((group, groupIndex) => <details className="commodity-type-group" key={group.label.toLocaleLowerCase()} open={groupIndex === 0}>
        <summary><span className="commodity-type-name">{group.label}</span><span className="commodity-type-count">{group.items.length} {group.items.length === 1 ? 'good' : 'goods'}</span><span className="system-index-chevron" aria-hidden="true">⌄</span></summary>
        <div className="commodity-type-items">
          {group.items.map(({ row, name, marketRows }) => {
            const code = readText(row, 'code')
            const weight = readNumber(row, 'weight_scu')
            const wiki = readText(row, 'wiki')
            const flags = propertyFlags.filter(([, key]) => readNumber(row, key) === 1).map(([label]) => label)
            const liveStatus = readNumber(row, 'is_available_live') === 1 ? 'Live' : readNumber(row, 'is_available') === 1 ? 'Listed' : 'Unavailable'
            const orderedMarketRows = [...marketRows].sort((left, right) => readText(left, 'terminal_name').localeCompare(readText(right, 'terminal_name'), undefined, { sensitivity: 'base' }))
            return <details className="commodity-entry" key={readText(row, 'id') || name.toLocaleLowerCase()}>
              <summary><span className="commodity-entry-copy"><strong>{name}</strong>{code && <small>{code}</small>}</span><span className="commodity-entry-meta">{readNumber(row, 'is_illegal') === 1 && catalogMode && <span className="commodity-flag commodity-flag-alert">Illegal</span>}{!catalogMode && <small>{marketRows.length} {marketRows.length === 1 ? 'listing' : 'listings'}</small>}<span className="commodity-chevron" aria-hidden="true">⌄</span></span></summary>
              <div className="commodity-details">
                <div className="commodity-facts">
                  {catalogMode ? <>
                    <div><span>UEX ID</span><strong>{readText(row, 'id') || '—'}</strong></div>
                    <div><span>ITEM ID</span><strong>{readText(row, 'id_item') || '—'}</strong></div>
                    <div><span>SCU WEIGHT</span><strong>{weight > 0 ? `${formatQuantity(weight)} SCU` : 'Not specified'}</strong></div>
                    <div><span>REFERENCE BUY</span><strong>{readNumber(row, 'price_buy') > 0 ? formatCredits(readNumber(row, 'price_buy')) : '—'}</strong></div>
                    <div><span>REFERENCE SELL</span><strong>{readNumber(row, 'price_sell') > 0 ? formatCredits(readNumber(row, 'price_sell')) : '—'}</strong></div>
                    <div><span>AVAILABILITY</span><strong>{liveStatus}</strong></div>
                  </> : <div><span>TYPE</span><strong>Market listings</strong></div>}
                </div>
                {catalogMode && flags.length > 0 && <div className="commodity-flags">{flags.map((flag) => <span className={`commodity-flag ${flag === 'Illegal' ? 'commodity-flag-alert' : ''}`} key={flag}>{flag}</span>)}</div>}
                {!catalogMode && <div className="commodity-market-details"><div className="table-scroll"><table className="data-table"><thead><tr><th>TERMINAL</th><th>BUY PRICE</th><th>SELL PRICE</th></tr></thead><tbody>{orderedMarketRows.map((marketRow, index) => <tr key={`${readText(marketRow, 'terminal_name')}-${index}`}><td className="primary-cell">{readText(marketRow, 'terminal_name') || 'Unknown terminal'}</td><td>{readNumber(marketRow, 'price_buy') > 0 ? formatCredits(readNumber(marketRow, 'price_buy')) : '—'}</td><td>{readNumber(marketRow, 'price_sell') > 0 ? formatCredits(readNumber(marketRow, 'price_sell')) : '—'}</td></tr>)}</tbody></table></div></div>}
                {wiki && <a className="commodity-wiki-link" href={wiki} target="_blank" rel="noreferrer">Open Star Citizen wiki reference <span aria-hidden="true">↗</span></a>}
                {catalogMode && <span className="commodity-reference-note">Catalog reference prices may differ from current terminal market listings.</span>}
              </div>
            </details>
          })}
        </div>
      </details>)}
      {!itemCount && <div className="accounts-empty"><strong>{normalizedSearch ? 'No commodities match this search' : 'No commodities listed'}</strong><span>{normalizedSearch ? 'Try a commodity name, type, code, or wiki term.' : 'No catalog entries are currently available.'}</span></div>}
    </div>
  </section>
}

function VehiclePurchaseDialog({ vehicle, offers, terminals, accounts, onClose, onSubmit, onAddAccount }: {
  vehicle: UexRow
  offers: UexRow[]
  terminals: UexRow[]
  accounts: BankAccount[]
  onClose: () => void
  onSubmit: (vehicle: UexRow, offer: UexRow, accountId: string) => string
  onAddAccount: () => void
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [offerId, setOfferId] = useState(readText(offers[0] ?? {}, 'id'))
  const [error, setError] = useState('')
  const offer = offers.find((row) => readText(row, 'id') === offerId) ?? offers[0]
  const terminal = terminals.find((row) => readText(row, 'id') === readText(offer ?? {}, 'id_terminal'))
  const terminalName = readText(terminal ?? {}, 'name', 'terminal_name') || readText(offer ?? {}, 'terminal_name') || 'Unknown terminal'
  const location = offer ? getVehicleOfferLocation(offer, terminals) : ''
  const price = readNumber(offer ?? {}, 'price_buy')

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!offer) {
      setError('No current in-game purchase listing is available for this vehicle.')
      return
    }
    const message = onSubmit(vehicle, offer, accountId)
    if (message) setError(message)
    else onClose()
  }

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="record-modal" role="dialog" aria-modal="true" aria-labelledby="vehicle-purchase-title">
      <div className="record-modal-head"><div><span className="eyebrow">UEX IN-GAME PURCHASE LISTING</span><h2 id="vehicle-purchase-title">Buy {readText(vehicle, 'name', 'vehicle_name')}</h2></div><button className="close-button" type="button" onClick={onClose} aria-label="Close vehicle purchase form">×</button></div>
      {!accounts.length ? <div className="no-account-prompt"><p>Add a bank account before tracking a vehicle purchase.</p><button className="primary-button" type="button" onClick={onAddAccount}>Add bank account</button></div> : <form onSubmit={submit}>
        <div className="record-fields">
          <label className="record-field"><span>PURCHASE LOCATION</span><select value={readText(offer ?? {}, 'id')} onChange={(event) => { setOfferId(event.target.value); setError('') }} required>{offers.map((row) => {
            const rowTerminal = terminals.find((item) => readText(item, 'id') === readText(row, 'id_terminal'))
            const rowTerminalName = readText(rowTerminal ?? {}, 'name', 'terminal_name') || readText(row, 'terminal_name') || 'Unknown terminal'
            const rowLocation = getVehicleOfferLocation(row, terminals)
            return <option key={readText(row, 'id')} value={readText(row, 'id')}>{rowTerminalName}{rowLocation ? ` · ${rowLocation}` : ''} · {formatCredits(readNumber(row, 'price_buy'))}</option>
          })}</select></label>
          <label className="record-field"><span>PAY FROM</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)} required>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {formatCredits(account.balance)}</option>)}</select></label>
        </div>
        <div className="transfer-summary"><span>{terminalName}{location ? ` · ${location}` : ''}</span><strong>{price > 0 ? formatCredits(price) : 'Price unavailable'}</strong></div>
        <p className="record-disclaimer">This records the purchase in this browser's ledger and hangar. It does not submit a transaction to Star Citizen; verify the community-reported price in game.</p>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="record-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={!offer || price <= 0}>Confirm purchase</button></div>
      </form>}
    </section>
  </div>
}

function VehicleDetailsDialog({ vehicle, offers, terminals, hangarShip, isActive = false, cargoUsed = 0, cargoByCommodity = {}, onClose }: {
  vehicle: UexRow
  offers: UexRow[]
  terminals: UexRow[]
  hangarShip?: HangarShip
  isActive?: boolean
  cargoUsed?: number
  cargoByCommodity?: Record<string, number>
  onClose: () => void
}) {
  const vehicleName = readText(vehicle, 'name_full') || readText(vehicle, 'name', 'vehicle_name') || 'Vehicle details'
  const photo = readText(vehicle, 'url_photo')
  const vehicleFeatures = [...vehicleTypeFlags, ...vehicleAdditionalFlags]
    .filter(([, flag]) => readNumber(vehicle, flag) === 1)
    .map(([label]) => label)
  const value = (key: string, suffix = '') => {
    const raw = vehicle[key]
    if (typeof raw !== 'string' && typeof raw !== 'number') return 'Not listed'
    const text = String(raw).trim()
    return text ? `${text}${suffix}` : 'Not listed'
  }
  const formatTimestamp = (key: string) => {
    const timestamp = readNumber(vehicle, key)
    if (timestamp <= 0) return 'Not listed'
    const milliseconds = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000
    return `${new Date(milliseconds).toISOString().slice(0, 16).replace('T', ' ')} UTC`
  }
  const specifications: [string, string][] = [
    ['Crew', value('crew')],
    ['Cargo capacity', value('scu', ' SCU')],
    ['Mass', value('mass', ' kg')],
    ['Length', value('length', ' m')],
    ['Width', value('width', ' m')],
    ['Height', value('height', ' m')],
    ['Quantum fuel', value('fuel_quantum')],
    ['Hydrogen fuel', value('fuel_hydrogen')],
    ['Container sizes', value('container_sizes')],
    ['Landing pad', value('pad_type')],
    ['Game version', value('game_version')],
  ]
  const identifiers: [string, string][] = [
    ['UEX vehicle ID', value('id')],
    ['UUID', value('uuid')],
    ['Slug', value('slug')],
    ['Company ID', value('id_company')],
    ['Parent vehicle ID', value('id_parent')],
    ['Loaner vehicle IDs', value('ids_vehicles_loaners')],
    ['Record added', formatTimestamp('date_added')],
    ['Record updated', formatTimestamp('date_modified')],
  ]
  const links: [string, string][] = [
    ['RSI pledge store', 'url_store'],
    ['Brochure', 'url_brochure'],
    ['Vehicle site', 'url_hotsite'],
    ['Video', 'url_video'],
  ].map(([label, key]) => [label, readText(vehicle, key)] as [string, string]).filter(([, url]) => Boolean(url))
  let additionalPhotos: string[] = []
  try {
    const parsed: unknown = JSON.parse(readText(vehicle, 'url_photos'))
    if (Array.isArray(parsed)) additionalPhotos = parsed.filter((url): url is string => typeof url === 'string' && url.startsWith('https://'))
  } catch {}
  const sortedOffers = [...offers].sort((left, right) => readNumber(left, 'price_buy') - readNumber(right, 'price_buy'))
  const cargoItems = Object.entries(cargoByCommodity).filter(([, quantity]) => quantity > 0).sort(([left], [right]) => left.localeCompare(right))

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="record-modal vehicle-detail-modal" role="dialog" aria-modal="true" aria-labelledby="vehicle-detail-title">
      <div className="record-modal-head vehicle-detail-head">
        {photo ? <img src={photo} alt="" referrerPolicy="no-referrer" /> : <div className="ship-placeholder" aria-hidden="true">▰</div>}
        <div><span className="eyebrow">UEX VEHICLE RECORD · {readText(vehicle, 'name')}</span><h2 id="vehicle-detail-title">{vehicleName}</h2><p>{readText(vehicle, 'company_name') || 'Manufacturer not listed'}</p></div>
        <button className="close-button" type="button" onClick={onClose} aria-label="Close vehicle details">×</button>
      </div>
      <div className="vehicle-detail-content">
        {hangarShip && <section className="vehicle-detail-section"><div className="vehicle-detail-section-head"><h3>Personal hangar</h3>{isActive && <span className="active-ship-tag">ACTIVE SHIP</span>}</div><div className="vehicle-detail-grid">
          <div><span>Hangar cargo usage</span><strong>{formatQuantity(cargoUsed)} / {formatQuantity(hangarShip.cargoCapacity)} SCU</strong></div>
          <div><span>Added to hangar</span><strong>{new Date(hangarShip.addedAt).toLocaleString()}</strong></div>
        </div><div className="vehicle-hold-manifest"><span>CURRENT HOLD</span>{cargoItems.length ? cargoItems.map(([commodity, quantity]) => <div key={commodity}><strong>{commodity}</strong><span>{formatQuantity(quantity)} SCU</span></div>) : <p className="vehicle-detail-empty">No locally assigned cargo.</p>}</div></section>}
        <section className="vehicle-detail-section"><h3>Specifications</h3><div className="vehicle-detail-grid">{specifications.map(([label, detail]) => <div key={label}><span>{label}</span><strong>{detail}</strong></div>)}</div></section>
        <section className="vehicle-detail-section"><h3>Classification &amp; capabilities</h3>{vehicleFeatures.length ? <div className="vehicle-feature-list">{vehicleFeatures.map((feature) => <span key={feature}>{feature}</span>)}</div> : <p className="vehicle-detail-empty">No classification flags listed.</p>}</section>
        <section className="vehicle-detail-section"><h3>In-game purchase locations</h3>{sortedOffers.length ? <div className="vehicle-purchase-location-list">{sortedOffers.map((offer) => {
          const terminal = terminals.find((row) => readText(row, 'id') === readText(offer, 'id_terminal'))
          const terminalName = readText(terminal ?? {}, 'name', 'terminal_name') || readText(offer, 'terminal_name') || 'Unknown terminal'
          const location = getVehicleOfferLocation(offer, terminals)
          return <div className="vehicle-purchase-location" key={readText(offer, 'id')}><div><strong>{terminalName}</strong><small>{location || 'Location not listed'}</small></div><strong>{formatCredits(readNumber(offer, 'price_buy'))}</strong></div>
        })}</div> : <p className="vehicle-detail-empty">No current purchase listing at a UEX terminal.</p>}</section>
        <section className="vehicle-detail-section"><h3>UEX identifiers</h3><div className="vehicle-detail-grid">{identifiers.map(([label, detail]) => <div key={label}><span>{label}</span><strong>{detail}</strong></div>)}</div></section>
        {links.length > 0 && <section className="vehicle-detail-section"><h3>Reference links</h3><div className="vehicle-reference-links">{links.map(([label, url]) => <a href={url} key={label} target="_blank" rel="noreferrer">{label} ↗</a>)}</div></section>}
        {additionalPhotos.length > 0 && <details className="vehicle-detail-photos"><summary>Additional photos <span>{additionalPhotos.length}</span></summary><div>{additionalPhotos.map((url, index) => <a href={url} key={url} target="_blank" rel="noreferrer">Photo {index + 1} ↗</a>)}</div></details>}
      </div>
    </section>
  </div>
}

function VehicleView({ rows, state, purchaseRows, purchaseState, terminals, accounts, hangarState, onBuy }: {
  rows: UexRow[]
  state: DatasetState
  purchaseRows: UexRow[]
  purchaseState: DatasetState
  terminals: UexRow[]
  accounts: BankAccount[]
  hangarState: HangarState
  onBuy: (vehicle: UexRow, offers: UexRow[]) => void
}) {
  const [typeFilter, setTypeFilter] = useState('')
  const [affordableOnly, setAffordableOnly] = useState(false)
  const [detailVehicle, setDetailVehicle] = useState<UexRow | null>(null)
  if (state.status === 'loading' || state.status === 'idle') return <LoadingPanel label="Loading vehicle registry" />
  if (state.status === 'error') return <ErrorPanel resource="Vehicles" message={state.error} />
  const offersByVehicle = new Map<string, UexRow[]>()
  for (const offer of purchaseRows) {
    const vehicleId = readText(offer, 'id_vehicle')
    if (!vehicleId || readNumber(offer, 'price_buy') <= 0) continue
    offersByVehicle.set(vehicleId, [...(offersByVehicle.get(vehicleId) ?? []), offer])
  }
  const getTypes = (row: UexRow) => {
    const explicitType = readText(row, 'type_name', 'type', 'role').trim()
    const flagTypes = vehicleTypeFlags.filter(([, flag]) => readNumber(row, flag) === 1).map(([label]) => label)
    const types = [...new Set([...(explicitType ? [explicitType] : []), ...flagTypes])]
    return types.length ? types : ['Uncategorized']
  }
  const typeOptions = [...new Set(rows.flatMap(getTypes))].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
  const filteredRows = rows.filter((row) => {
    if (typeFilter && !getTypes(row).includes(typeFilter)) return false
    if (!affordableOnly) return true
    const offers = offersByVehicle.get(readText(row, 'id')) ?? []
    return offers.some((offer) => accounts.some((account) => account.balance >= readNumber(offer, 'price_buy')))
  })
  const visibleRows = filteredRows.slice(0, 400)
  const selectedHangarShip = hangarState.ships.find((ship) => ship.vehicleId === readText(detailVehicle ?? {}, 'id'))
  const offerStateLabel = purchaseState.status === 'loading' || purchaseState.status === 'idle' ? 'Loading in-game prices…' : purchaseState.status === 'error' ? 'In-game price feed unavailable' : 'Not listed at a UEX purchase terminal'
  return <>
    <div className="module-note"><span className="note-mark">i</span><div><strong>UEX in-game purchase prices</strong><p>Prices and locations are community-reported. Confirm availability in game before travelling; a confirmed purchase here only updates this browser's account ledger and hangar.</p></div></div>
    <section className="data-section directory-section">
      <div className="section-toolbar"><div><h2>Ship &amp; vehicle registry</h2><span>{filteredRows.length.toLocaleString()} of {rows.length.toLocaleString()} entries</span></div><span className="table-label">UEX PURCHASE LISTINGS</span></div>
      <div className="vehicle-filter-bar">
        <label className="vehicle-type-filter"><span>TYPE</span><select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="">All types</option>{typeOptions.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
        <label className="vehicle-affordable-filter"><input type="checkbox" checked={affordableOnly} onChange={(event) => setAffordableOnly(event.target.checked)} /><span>Affordable only</span></label>
        <small>At least one account can cover one listed terminal price.</small>
        {(typeFilter || affordableOnly) && <button className="text-button" type="button" onClick={() => { setTypeFilter(''); setAffordableOnly(false) }}>Clear filters</button>}
      </div>
      <div className="table-scroll"><table className="data-table vehicle-registry-table"><thead><tr><th>VEHICLE</th><th>MANUFACTURER</th><th>ROLE / TYPE</th><th>CREW</th><th>CARGO</th><th>LOWEST IN-GAME PRICE</th><th>ACTIONS</th></tr></thead><tbody>
        {visibleRows.map((row) => {
          const vehicleId = readText(row, 'id')
          const offers = [...(offersByVehicle.get(vehicleId) ?? [])].sort((left, right) => readNumber(left, 'price_buy') - readNumber(right, 'price_buy'))
          const cheapest = offers[0]
          const matchingTerminal = terminals.find((terminal) => readText(terminal, 'id') === readText(cheapest ?? {}, 'id_terminal'))
          const terminalName = readText(matchingTerminal ?? {}, 'name', 'terminal_name') || readText(cheapest ?? {}, 'terminal_name')
          const terminalLocation = cheapest ? getVehicleOfferLocation(cheapest, terminals) : ''
          const hangarShip = hangarState.ships.find((ship) => ship.vehicleId === vehicleId)
          return <tr key={vehicleId || readText(row, 'name')}>
            <td className="primary-cell">{readText(row, 'name', 'vehicle_name')}</td>
            <td>{readText(row, 'company_name', 'manufacturer_name') || '—'}</td>
            <td>{getTypes(row).join(' · ')}</td>
            <td>{readText(row, 'crew_min', 'crew') || '—'}</td>
            <td>{readText(row, 'scu', 'cargo_capacity', 'cargo_scu') || '—'}</td>
            <td>{cheapest ? <span className="vehicle-price-cell"><strong>{formatCredits(readNumber(cheapest, 'price_buy'))}</strong><small>{terminalName}{terminalLocation ? ` · ${terminalLocation}` : ''}</small></span> : <span className="muted-cell">{offerStateLabel}</span>}</td>
            <td><div className="vehicle-actions"><button className="secondary-button vehicle-detail-button" type="button" onClick={() => setDetailVehicle(row)}>Details</button>{hangarShip ? <span className="table-label">IN HANGAR</span> : cheapest ? <button className="secondary-button vehicle-buy-button" type="button" onClick={() => onBuy(row, offers)}>Buy</button> : null}</div></td>
          </tr>
        })}
        {!visibleRows.length && <tr><td colSpan={7} className="empty-cell">No vehicles match these filters.</td></tr>}
      </tbody></table></div>
      <div className="table-note"><span>Choose a terminal to compare its current reported purchase price.</span><span>Purchases are recorded locally.</span></div>
    </section>
    {detailVehicle && <VehicleDetailsDialog vehicle={detailVehicle} offers={offersByVehicle.get(readText(detailVehicle, 'id')) ?? []} terminals={terminals} hangarShip={selectedHangarShip} isActive={selectedHangarShip?.id === hangarState.activeShipId} cargoUsed={selectedHangarShip ? getShipCargoUsed(hangarState, selectedHangarShip.id) : 0} cargoByCommodity={selectedHangarShip ? hangarState.cargoByShip[selectedHangarShip.id] ?? {} : {}} onClose={() => setDetailVehicle(null)} />}
  </>
}

function SystemsView({ rows, terminals, prices, newLocationKeys, state, terminalState, priceState, search }: {
  rows: UexRow[]
  terminals: UexRow[]
  prices: UexRow[]
  newLocationKeys: Set<string>
  state: DatasetState
  terminalState: DatasetState
  priceState: DatasetState
  search: string
}) {
  if (state.status === 'loading' || state.status === 'idle') return <LoadingPanel label="Loading star system index" />
  if (state.status === 'error') return <ErrorPanel resource="Star systems" message={state.error} />
  const locationsBySystem = new Map<string, UexRow[]>()
  for (const terminal of terminals) {
    const systemId = readText(terminal, 'id_star_system')
    const systemName = readText(terminal, 'star_system_name', 'system_name').trim().toLocaleLowerCase()
    for (const key of [systemId && `id:${systemId}`, systemName && `name:${systemName}`].filter((value): value is string => Boolean(value))) {
      locationsBySystem.set(key, [...(locationsBySystem.get(key) ?? []), terminal])
    }
  }
  const pricesByTerminal = new Map<string, UexRow[]>()
  const addPriceRow = (key: string, row: UexRow) => {
    if (!key) return
    const indexedRows = pricesByTerminal.get(key) ?? []
    indexedRows.push(row)
    pricesByTerminal.set(key, indexedRows)
  }
  for (const price of prices) {
    const terminalId = readText(price, 'id_terminal', 'terminal_id')
    const terminalName = readText(price, 'terminal_name', 'name').trim().toLocaleLowerCase()
    if (terminalId) addPriceRow(`id:${terminalId}`, price)
    if (terminalName) addPriceRow(`name:${terminalName}`, price)
  }
  const pricesForTerminal = (terminal: UexRow) => {
    const terminalId = readText(terminal, 'id')
    const terminalName = readText(terminal, 'name', 'terminal_name').trim().toLocaleLowerCase()
    return pricesByTerminal.get(`id:${terminalId}`) ?? pricesByTerminal.get(`name:${terminalName}`) ?? []
  }
  const listedPricesForTerminal = (terminal: UexRow) => pricesForTerminal(terminal)
    .filter((price) => (readNumber(price, 'price_buy') > 0 && readNumber(price, 'scu_buy') > 0)
      || (readNumber(price, 'price_sell') > 0 && readNumber(price, 'scu_sell_stock') > 0))
    .sort((left, right) => readText(left, 'commodity_name').localeCompare(readText(right, 'commodity_name'), undefined, { sensitivity: 'base' }))

  const normalizedSearch = search.trim().toLocaleLowerCase()
  const groupedSystems = rows.map((system) => {
    const name = readText(system, 'name', 'star_system_name')
    const systemId = readText(system, 'id')
    const systemLocations = locationsBySystem.get(`id:${systemId}`) ?? locationsBySystem.get(`name:${name.toLocaleLowerCase()}`) ?? []
    const systemMatches = !normalizedSearch || `${name} ${readText(system, 'code')} ${readText(system, 'faction_name')}`.toLocaleLowerCase().includes(normalizedSearch)
    const matchingLocations = systemMatches ? systemLocations : systemLocations.filter((terminal) => {
      const marketCommodities = pricesForTerminal(terminal).map((price) => readText(price, 'commodity_name')).join(' ')
      const searchText = [readText(terminal, 'planet_name'), readText(terminal, 'moon_name'), readText(terminal, 'name', 'terminal_name'), readText(terminal, 'orbit_name'), marketCommodities].join(' ').toLocaleLowerCase()
      return searchText.includes(normalizedSearch)
    })
    const planets = new Map<string, UexRow[]>()
    for (const terminal of matchingLocations) {
      const planet = readText(terminal, 'planet_name').trim() || 'No planet listed'
      planets.set(planet, [...(planets.get(planet) ?? []), terminal])
    }
    return { system, name, systemLocations, planets, systemMatches, matchingLocations }
  }).filter(({ systemLocations, systemMatches, matchingLocations }) => systemLocations.length > 0 && (systemMatches || matchingLocations.length))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))

  return <section className="data-section system-index-section">
    <div className="section-toolbar"><div><h2>Star system index</h2><span>{groupedSystems.length.toLocaleString()} systems with listed locations · refresh to check for additions</span></div><span className="table-label">UEX DIRECTORY</span></div>
    {terminalState.status === 'error' && <div className="holdings-market-warning">Terminal locations could not be loaded. System records are still available.</div>}
    <div className="system-index-list">
      {groupedSystems.map(({ system, name, systemLocations, planets, systemMatches, matchingLocations }) => {
        const visiblePlanets = [...planets.entries()].sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
        const code = readText(system, 'code')
        const faction = readText(system, 'faction_name')
        const description = readText(system, 'description')
        const systemHasNewLocation = systemLocations.some((location) => newLocationKeys.has(getTerminalLocationKey(location)))
        return <details className="system-index-group" key={readText(system, 'id') || name}>
          <summary><span className="system-index-name">{name}{systemHasNewLocation && <span className="new-tag">New</span>}</span><span className="system-index-count">{systemMatches ? systemLocations.length : matchingLocations.length} locations</span><span className="system-index-code">{code || '—'}</span><span className="system-index-chevron" aria-hidden="true">⌄</span></summary>
          <div className="system-index-content">
            <div className="system-index-meta"><span>{readText(system, 'is_available_live') === '1' ? 'LIVE' : readText(system, 'is_available') === '1' ? 'LISTED' : 'UNAVAILABLE'}</span>{faction && <span>{faction}</span>}</div>
            {description && <p className="system-index-description">{description}</p>}
            {!visiblePlanets.length ? <div className="system-no-planets">No terminal locations with planet data are listed for this system.</div> : visiblePlanets.map(([planet, locations]) => <details className="system-planet-group" key={`${name}-${planet}`} open={visiblePlanets.length === 1}>
              <summary><span>{planet}</span><small>{locations.length} {locations.length === 1 ? 'location' : 'locations'}</small></summary>
              <ul className="system-location-list">{locations.sort((left, right) => readText(left, 'name', 'terminal_name').localeCompare(readText(right, 'name', 'terminal_name'), undefined, { sensitivity: 'base' })).map((location) => {
                const locationName = readText(location, 'name', 'terminal_name') || 'Unnamed location'
                const detail = [readText(location, 'moon_name'), readText(location, 'orbit_name'), readText(location, 'type')].filter(Boolean).filter((item, index, values) => values.indexOf(item) === index).join(' · ')
                const marketRows = listedPricesForTerminal(location)
                const locationIsNew = newLocationKeys.has(getTerminalLocationKey(location))
                return <li key={getTerminalLocationKey(location) || `${planet}-${locationName}`}><details className="system-terminal-market">
                  <summary><span className="system-location-copy"><strong>{locationName}</strong>{detail && <small>{detail}</small>}</span><span className="system-terminal-summary-meta">{locationIsNew && <span className="new-tag">New</span>}<small>{marketRows.length} {marketRows.length === 1 ? 'good' : 'goods'}</small><span className="system-index-chevron" aria-hidden="true">⌄</span></span></summary>
                  <div className="system-market-content">
                    {priceState.status === 'loading' || priceState.status === 'idle' ? <span className="system-market-message">Loading market listings...</span>
                      : priceState.status === 'error' ? <span className="system-market-message">Market prices could not be loaded.</span>
                        : !marketRows.length ? <span className="system-market-message">No current commodity buy or sell listings are reported for this terminal.</span>
                          : <div className="system-market-table-scroll"><table className="data-table system-market-table"><thead><tr><th>COMMODITY</th><th>TERMINAL BUYS</th><th>BUY SCU</th><th>TERMINAL SELLS</th><th>SELL STOCK SCU</th></tr></thead><tbody>{marketRows.map((price) => {
                            const buyPrice = readNumber(price, 'price_buy')
                            const buyQuantity = readNumber(price, 'scu_buy')
                            const sellPrice = readNumber(price, 'price_sell')
                            const sellQuantity = readNumber(price, 'scu_sell_stock')
                            const hasBuy = buyPrice > 0 && buyQuantity > 0
                            const hasSell = sellPrice > 0 && sellQuantity > 0
                            return <tr key={`${getTerminalLocationKey(location)}-${readText(price, 'commodity_name')}`}><td className="primary-cell">{readText(price, 'commodity_name') || 'Unknown commodity'}</td><td>{hasBuy ? formatCredits(buyPrice) : '—'}</td><td>{hasBuy ? formatQuantity(buyQuantity) : '—'}</td><td>{hasSell ? formatCredits(sellPrice) : '—'}</td><td>{hasSell ? formatQuantity(sellQuantity) : '—'}</td></tr>
                          })}</tbody></table></div>}
                    <span className="system-market-footnote">Reported market quantities are in SCU and may change with UEX updates.</span>
                  </div>
                </details></li>
              })}</ul>
            </details>)}
          </div>
        </details>
      })}
      {!groupedSystems.length && <div className="accounts-empty"><strong>{normalizedSearch ? 'No systems with locations match this search' : 'No systems have listed locations'}</strong><span>{normalizedSearch ? 'Try a system, planet, moon, or terminal name.' : 'Systems appear here when UEX lists a location. Refresh UEX data to check for updates.'}</span></div>}
    </div>
    <div className="table-note"><span>Planet and location groups use terminal records published by UEX.</span><span>They may not include every body in a system.</span></div>
  </section>
}

function MiningView({ prices, commodities, state, methods, methodsState, yields, yieldsState, capacities, capacitiesState, search, miningOpsState, onAddScan, onRemoveScan }: {
  prices: UexRow[]
  commodities: UexRow[]
  state: DatasetState
  methods: UexRow[]
  methodsState: DatasetState
  yields: UexRow[]
  yieldsState: DatasetState
  capacities: UexRow[]
  capacitiesState: DatasetState
  search: string
  miningOpsState: MiningOpsState
  onAddScan: (scan: NewRockScan) => string
  onRemoveScan: (scanId: string) => void
}) {
  const [tab, setTab] = useState<'market' | 'calculator' | 'refinery' | 'scans'>('market')
  const rawMinerals = new Set(commodities.filter((row) => readNumber(row, 'is_mineral') === 1 && readNumber(row, 'is_raw') === 1).map((row) => readText(row, 'name')))
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const oreRows = prices.filter((row) => rawMinerals.has(readText(row, 'commodity_name')) || /\bore\b|mineral/i.test(readText(row, 'commodity_name')))
    .filter((row) => !normalizedSearch || `${readText(row, 'commodity_name')} ${readText(row, 'terminal_name')}`.toLocaleLowerCase().includes(normalizedSearch))
  const methodRows = methods.filter((row) => !normalizedSearch || `${readText(row, 'name')} ${readText(row, 'code')}`.toLocaleLowerCase().includes(normalizedSearch))
  const yieldRows = yields.filter((row) => !normalizedSearch || `${readText(row, 'commodity_name')} ${readText(row, 'terminal_name')} ${readText(row, 'star_system_name')}`.toLocaleLowerCase().includes(normalizedSearch))
  const capacityRows = capacities.filter((row) => !normalizedSearch || `${readText(row, 'terminal_name')} ${readText(row, 'star_system_name')} ${readText(row, 'planet_name')}`.toLocaleLowerCase().includes(normalizedSearch))

  return <>
    <div className="module-note"><span className="note-mark">⌁</span><div><strong>Mining &amp; refinery tools</strong><p>Uses UEX commodity market listings and refinery reports. UEX does not provide live rock scans, so record scanner readings manually in the local scan log.</p></div></div>
    <div className="finance-tabs mining-tool-tabs" role="tablist" aria-label="Mining tools">
      <button type="button" role="tab" aria-selected={tab === 'market'} className={tab === 'market' ? 'selected' : ''} onClick={() => setTab('market')}>Ore market</button>
      <button type="button" role="tab" aria-selected={tab === 'calculator'} className={tab === 'calculator' ? 'selected' : ''} onClick={() => setTab('calculator')}>Sale estimator</button>
      <button type="button" role="tab" aria-selected={tab === 'refinery'} className={tab === 'refinery' ? 'selected' : ''} onClick={() => setTab('refinery')}>Refinery data</button>
      <button type="button" role="tab" aria-selected={tab === 'scans'} className={tab === 'scans' ? 'selected' : ''} onClick={() => setTab('scans')}>Rock scan log <span>{miningOpsState.scans.length}</span></button>
    </div>
    {tab === 'market' && (state.status === 'loading' || state.status === 'idle'
      ? <LoadingPanel label="Loading mining and commodity market data" />
      : state.status === 'error'
        ? <ErrorPanel resource="Mining market" message={state.error} />
        : <DataPanel title="Ore buy & sell listings" subtitle={`${oreRows.length.toLocaleString()} market rows`} columns={['ORE / MATERIAL', 'LOCATION', 'BUY PRICE', 'BUY SCU', 'SELL PRICE', 'SELL STOCK']} rows={oreRows.slice(0, 400).map((row) => [readText(row, 'commodity_name'), readText(row, 'terminal_name'), readNumber(row, 'price_buy') ? formatCredits(readNumber(row, 'price_buy')) : '—', readNumber(row, 'scu_buy').toLocaleString(), readNumber(row, 'price_sell') ? formatCredits(readNumber(row, 'price_sell')) : '—', readNumber(row, 'scu_sell_stock').toLocaleString()])} />)}
    {tab === 'calculator' && <MiningSaleEstimator prices={prices} commodities={commodities} priceState={state} search={search} />}
    {tab === 'refinery' && <div className="mining-refinery-tools">
      {methodsState.status === 'loading' || methodsState.status === 'idle' ? <LoadingPanel label="Loading refinery methods" /> : methodsState.status === 'error' ? <ErrorPanel resource="Refinery methods" message={methodsState.error} /> : <DataPanel title="Refinery methods" subtitle={`${methodRows.length} methods · UEX ratings are relative indicators`} columns={['METHOD', 'YIELD RATING', 'COST RATING', 'SPEED RATING']} rows={methodRows.map((row) => [readText(row, 'name'), refineryRating(readNumber(row, 'rating_yield')), refineryRating(readNumber(row, 'rating_cost')), refineryRating(readNumber(row, 'rating_speed'), true)])} />}
      {yieldsState.status === 'loading' || yieldsState.status === 'idle' ? <LoadingPanel label="Loading refinery yield reports" /> : yieldsState.status === 'error' ? <ErrorPanel resource="Refinery yields" message={yieldsState.error} /> : <DataPanel title="Refinery yield reports" subtitle={`${yieldRows.length} UEX reports · raw reported values`} columns={['COMMODITY', 'REFINERY', 'SYSTEM', 'CURRENT VALUE', 'WEEK', 'MONTH']} rows={yieldRows.slice(0, 400).map((row) => [readText(row, 'commodity_name'), readText(row, 'terminal_name'), readText(row, 'star_system_name') || '—', readText(row, 'value') || '—', readText(row, 'value_week') || '—', readText(row, 'value_month') || '—'])} />}
      {capacitiesState.status === 'loading' || capacitiesState.status === 'idle' ? <LoadingPanel label="Loading refinery capacity reports" /> : capacitiesState.status === 'error' ? <ErrorPanel resource="Refinery capacities" message={capacitiesState.error} /> : <DataPanel title="Refinery capacity reports" subtitle={`${capacityRows.length} UEX reports · values shown as reported`} columns={['REFINERY', 'SYSTEM', 'CURRENT VALUE', 'WEEK', 'MONTH']} rows={capacityRows.map((row) => [readText(row, 'terminal_name'), readText(row, 'star_system_name') || '—', readText(row, 'value') || '—', readText(row, 'value_week') || '—', readText(row, 'value_month') || '—'])} />}
    </div>}
    {tab === 'scans' && <RockScanLog scans={miningOpsState.scans} minerals={commodities.filter((row) => readNumber(row, 'is_mineral') === 1 && readNumber(row, 'is_raw') === 1).map((row) => readText(row, 'name')).filter(Boolean).sort((left, right) => left.localeCompare(right))} onAdd={onAddScan} onRemove={onRemoveScan} />}
  </>
}

function RockScanLog({ scans, minerals, onAdd, onRemove }: { scans: RockScan[]; minerals: string[]; onAdd: (scan: NewRockScan) => string; onRemove: (scanId: string) => void }) {
  const [label, setLabel] = useState('')
  const [location, setLocation] = useState('')
  const [massKg, setMassKg] = useState('')
  const [resistancePercent, setResistancePercent] = useState('')
  const [instabilityPercent, setInstabilityPercent] = useState('')
  const [composition, setComposition] = useState([{ id: 'composition-0', commodity: '', percent: '' }])
  const [error, setError] = useState('')
  const compositionTotal = composition.reduce((sum, part) => sum + (Number(part.percent) || 0), 0)

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const message = onAdd({
      label,
      location,
      massKg: Number(massKg),
      resistancePercent: Number(resistancePercent),
      instabilityPercent: Number(instabilityPercent),
      composition: composition.map((part) => ({ commodity: part.commodity, percent: Number(part.percent) })),
    })
    if (message) {
      setError(message)
      return
    }
    setLabel('')
    setLocation('')
    setMassKg('')
    setResistancePercent('')
    setInstabilityPercent('')
    setComposition([{ id: `composition-${Date.now()}`, commodity: '', percent: '' }])
    setError('')
  }

  function updateComposition(id: string, field: 'commodity' | 'percent', value: string) {
    setComposition((current) => current.map((part) => part.id === id ? { ...part, [field]: value } : part))
    setError('')
  }

  function addComposition() {
    setComposition((current) => [...current, { id: `composition-${Date.now()}-${current.length}`, commodity: '', percent: '' }])
  }

  return <>
    <section className="data-section mining-scan-form-section">
      <div className="section-toolbar"><div><h2>Record a rock scan</h2><span>Enter the measurements shown by your in-game scanner.</span></div><span className="table-label">LOCAL SCAN LOG</span></div>
      <form className="mining-scan-form" onSubmit={submit}>
        <label><span>SCAN LABEL</span><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Rock or cluster name" maxLength={60} required /></label>
        <label><span>LOCATION</span><input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="System, belt, or site" maxLength={100} required /></label>
        <label><span>MASS</span><div className="number-input"><input type="number" min="1" step="1" value={massKg} onChange={(event) => setMassKg(event.target.value)} required /><span>KG</span></div></label>
        <label><span>RESISTANCE</span><div className="number-input"><input type="number" min="0" max="100" step="0.1" value={resistancePercent} onChange={(event) => setResistancePercent(event.target.value)} required /><span>%</span></div></label>
        <label><span>INSTABILITY</span><div className="number-input"><input type="number" min="0" max="100" step="0.1" value={instabilityPercent} onChange={(event) => setInstabilityPercent(event.target.value)} required /><span>%</span></div></label>
        <div className="mining-scan-composition">
          <div className="mining-scan-composition-head"><div><span>MINERAL COMPOSITION</span><small>{compositionTotal.toFixed(1)}% recorded · maximum 100%</small></div><button className="text-button" type="button" onClick={addComposition}>+ Add mineral</button></div>
          {composition.map((part) => <div className="mining-scan-composition-row" key={part.id}>
            <select aria-label="Scanned mineral" value={part.commodity} onChange={(event) => updateComposition(part.id, 'commodity', event.target.value)} required><option value="">Select raw mineral</option>{minerals.map((mineral) => <option key={mineral} value={mineral}>{mineral}</option>)}</select>
            <div className="number-input"><input aria-label="Mineral composition percent" type="number" min="0.1" max="100" step="0.1" value={part.percent} onChange={(event) => updateComposition(part.id, 'percent', event.target.value)} required /><span>%</span></div>
            <button className="remove-account" type="button" aria-label="Remove mineral row" onClick={() => setComposition((current) => current.filter((item) => item.id !== part.id))}>×</button>
          </div>)}
        </div>
        {error && <div className="form-error mining-scan-error" role="alert">{error}</div>}
        <div className="mining-scan-submit"><span>Scan measurements are stored locally and are not read from the game.</span><button className="primary-button" type="submit" disabled={!minerals.length || compositionTotal > 100}>Save scan</button></div>
      </form>
    </section>
    <section className="data-section mining-scan-history">
      <div className="section-toolbar"><div><h2>Saved scans</h2><span>{scans.length} recorded {scans.length === 1 ? 'scan' : 'scans'}</span></div><span className="table-label">SAVED LOCALLY</span></div>
      <div className="mining-scan-list">{scans.map((scan) => <article className="mining-scan-entry" key={scan.id}>
        <div className="mining-scan-entry-head"><div><strong>{scan.label}</strong><small>{scan.location} · {new Date(scan.scannedAt).toLocaleString()}</small></div><button className="remove-account" type="button" aria-label={`Remove scan ${scan.label}`} onClick={() => onRemove(scan.id)}>×</button></div>
        <div className="mining-scan-metrics"><div><span>MASS</span><strong>{formatQuantity(scan.massKg)} kg</strong></div><div><span>RESISTANCE</span><strong>{scan.resistancePercent}%</strong></div><div><span>INSTABILITY</span><strong>{scan.instabilityPercent}%</strong></div></div>
        <div className="mining-scan-composition-summary"><span>COMPOSITION</span>{scan.composition.map((part) => <span className="mining-scan-mineral" key={`${part.commodity}-${part.percent}`}>{part.commodity} · {part.percent}%</span>)}</div>
      </article>)}{!scans.length && <div className="accounts-empty"><strong>No rock scans recorded</strong><span>Enter measurements from your in-game scanner to build a local scan log.</span></div>}</div>
    </section>
  </>
}

function MiningSaleEstimator({ prices, commodities, priceState, search }: { prices: UexRow[]; commodities: UexRow[]; priceState: DatasetState; search: string }) {
  const [commodityChoice, setCommodityChoice] = useState('')
  const [terminalChoice, setTerminalChoice] = useState('')
  const [containerSize, setContainerSize] = useState('16')
  const [containerCount, setContainerCount] = useState('1')
  const fallbackOres = [...new Set(prices.map((row) => readText(row, 'commodity_name')).filter((name) => /\bore\b|mineral/i.test(name)))]
  const rawOreNames = [...new Set(commodities.filter((row) => readNumber(row, 'is_mineral') === 1 && readNumber(row, 'is_raw') === 1).map((row) => readText(row, 'name')).filter(Boolean))]
  const oreNames = (rawOreNames.length ? rawOreNames : fallbackOres).filter((name) => !search || name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
  const quotedOres = oreNames.filter((name) => prices.some((row) => readText(row, 'commodity_name') === name && readNumber(row, 'price_sell') > 0 && readNumber(row, 'scu_sell_stock') > 0))
  const commodity = oreNames.includes(commodityChoice) ? commodityChoice : quotedOres[0] ?? oreNames[0] ?? ''
  const offers = prices.filter((row) => readText(row, 'commodity_name') === commodity && readNumber(row, 'price_sell') > 0 && readNumber(row, 'scu_sell_stock') > 0).sort((left, right) => readNumber(right, 'price_sell') - readNumber(left, 'price_sell') || readNumber(right, 'scu_sell_stock') - readNumber(left, 'scu_sell_stock'))
  const terminalId = offers.some((row) => readText(row, 'id_terminal') === terminalChoice) ? terminalChoice : readText(offers[0] ?? {}, 'id_terminal')
  const offer = offers.find((row) => readText(row, 'id_terminal') === terminalId) ?? offers[0]
  const quantity = Number(containerSize) * Number(containerCount)
  const validQuantity = isContainerSizedQuantity(quantity) && Number.isInteger(Number(containerCount))
  const stock = readNumber(offer ?? {}, 'scu_sell_stock')
  const exceedsStock = validQuantity && quantity > stock
  const estimate = validQuantity && offer ? quantity * readNumber(offer, 'price_sell') : 0

  return <section className="data-section mining-sale-estimator">
    <div className="section-toolbar"><div><h2>Mining sale estimator</h2><span>Estimate a sale from a whole-container mining load.</span></div><span className="table-label">CURRENT UEX QUOTE</span></div>
    <div className="mining-estimator-fields">
      <label><span>ORE / MINERAL</span><select value={commodity} onChange={(event) => { setCommodityChoice(event.target.value); setTerminalChoice('') }} disabled={!oreNames.length}><option value="">No raw minerals listed</option>{oreNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
      <label><span>SELL AT</span><select value={terminalId} onChange={(event) => setTerminalChoice(event.target.value)} disabled={!offers.length}><option value="">No current sell quotes</option>{offers.map((row) => <option key={`${readText(row, 'id_terminal')}-${readText(row, 'commodity_name')}`} value={readText(row, 'id_terminal')}>{readText(row, 'terminal_name')} · {formatCredits(readNumber(row, 'price_sell'))} · {formatQuantity(readNumber(row, 'scu_sell_stock'))} SCU stock</option>)}</select></label>
      <label><span>CONTAINER SIZE</span><select value={containerSize} onChange={(event) => setContainerSize(event.target.value)}>{CONTAINER_SIZES.map((size) => <option key={size} value={size}>{size} SCU</option>)}</select></label>
      <label><span>NUMBER OF CONTAINERS</span><div className="number-input"><input type="number" min="1" step="1" value={containerCount} onChange={(event) => setContainerCount(event.target.value)} /><span>BOXES</span></div></label>
    </div>
    {priceState.status === 'error' && <div className="form-error mining-estimator-error">UEX market prices are unavailable.</div>}
    {offer && <div className={`mining-estimate ${exceedsStock ? 'warning' : ''}`}><div><span>EST. GROSS SALE</span><strong>{formatCredits(estimate)}</strong></div><div><span>LOAD SIZE</span><strong>{validQuantity ? `${formatQuantity(quantity)} SCU` : 'Enter containers'}</strong></div><div><span>CURRENT TERMINAL STOCK</span><strong>{formatQuantity(stock)} SCU</strong></div><p>{exceedsStock ? 'This container load exceeds current reported stock at the selected terminal.' : 'Estimate excludes travel, mining time, refining yield, and fees.'}</p></div>}
  </section>
}

function refineryRating(value: number, speed = false) {
  const ratings = speed ? ['', 'Slow', 'Medium', 'Fast'] : ['', 'Low', 'Medium', 'High']
  return ratings[value] || '—'
}

function DataPanel({ title, subtitle, columns, rows }: { title: string; subtitle: string; columns: string[]; rows: string[][] }) {
  return <section className="data-section directory-section"><div className="section-toolbar"><div><h2>{title}</h2><span>{subtitle}</span></div><span className="table-label">UEX DIRECTORY</span></div><div className="table-scroll"><table className="data-table"><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={`${row[0]}-${index}`}>{row.map((cell, cellIndex) => <td key={`${cellIndex}-${cell}`} className={cellIndex === 0 ? 'primary-cell' : ''}>{cell}</td>)}</tr>)}{!rows.length && <tr><td colSpan={columns.length} className="empty-cell">No matching records.</td></tr>}</tbody></table></div></section>
}

function LoadingPanel({ label }: { label: string }) {
  return <div className="state-panel"><span className="spinner" /><div><strong>{label}</strong><span>Querying the UEX API</span></div></div>
}

function ErrorPanel({ resource, message }: { resource: string; message?: string }) {
  return <div className="state-panel error-state"><span className="state-symbol">!</span><div><strong>{resource} could not be loaded</strong><span>{message || 'Check the token and try again.'}</span></div></div>
}

function ItemCatalogView({ token }: { token: string }) {
  const [categoriesState, setCategoriesState] = useState<DatasetState>({ rows: [], status: 'loading' })
  const [itemsResult, setItemsResult] = useState<{ categoryId: string; state: DatasetState }>({ categoryId: '', state: { rows: [], status: 'idle' } })
  const [pricesState, setPricesState] = useState<DatasetState>({ rows: [], status: 'loading' })
  const [categoryId, setCategoryId] = useState('')
  const [search, setSearch] = useState('')
  const [detailItem, setDetailItem] = useState<UexRow | null>(null)

  useEffect(() => {
    let active = true
    getUexData<UexRow[]>('categories', token).then((rows) => {
      if (!active) return
      const categories = rows.filter((row) => readText(row, 'type') === 'item' && readNumber(row, 'is_game_related') === 1)
      setCategoriesState({ rows: categories, status: 'ready' })
      setCategoryId((current) => categories.some((row) => readText(row, 'id') === current) ? current : readText(categories[0] ?? {}, 'id'))
    }).catch((error) => {
      if (active) setCategoriesState({ rows: [], status: 'error', error: error instanceof Error ? error.message : 'Unable to load UEX item categories.' })
    })
    getUexData<UexRow[]>('items_prices_all', token).then((rows) => {
      if (active) setPricesState({ rows, status: 'ready' })
    }).catch((error) => {
      if (active) setPricesState({ rows: [], status: 'error', error: error instanceof Error ? error.message : 'Unable to load UEX item prices.' })
    })
    return () => { active = false }
  }, [token])

  useEffect(() => {
    if (!categoryId) return
    let active = true
    getUexData<UexRow[]>('items', token, { id_category: Number(categoryId) }).then((rows) => {
      if (active) setItemsResult({ categoryId, state: { rows, status: 'ready' } })
    }).catch((error) => {
      if (active) setItemsResult({ categoryId, state: { rows: [], status: 'error', error: error instanceof Error ? error.message : 'Unable to load items for this category.' } })
    })
    return () => { active = false }
  }, [categoryId, token])

  const itemsState = categoryId
    ? itemsResult.categoryId === categoryId ? itemsResult.state : { rows: [], status: 'loading' as const }
    : { rows: [], status: categoriesState.status === 'ready' ? 'ready' as const : 'idle' as const }
  const selectedCategory = categoriesState.rows.find((row) => readText(row, 'id') === categoryId)
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const visibleItems = itemsState.rows.filter((item) => [readText(item, 'name'), readText(item, 'company_name'), readText(item, 'vehicle_name'), readText(item, 'section'), readText(item, 'category'), readText(item, 'slug')].join(' ').toLocaleLowerCase().includes(normalizedSearch))
  const pricesByItem = new Map<string, UexRow[]>()
  for (const row of pricesState.rows) {
    const itemId = readText(row, 'id_item')
    if (itemId) pricesByItem.set(itemId, [...(pricesByItem.get(itemId) ?? []), row])
  }

  if (categoriesState.status === 'loading') return <LoadingPanel label="Loading UEX item categories" />
  if (categoriesState.status === 'error') return <ErrorPanel resource="Item categories" message={categoriesState.error} />

  return <>
    <section className="data-section directory-section item-catalog-section">
      <div className="section-toolbar"><div><h2>UEX item catalog</h2><span>{itemsState.status === 'ready' ? `${visibleItems.length.toLocaleString()} of ${itemsState.rows.length.toLocaleString()} items` : selectedCategory ? `Loading ${readText(selectedCategory, 'name')} items` : 'Browse items by category'}</span></div><span className="table-label">{pricesState.status === 'ready' ? `${pricesState.rows.length.toLocaleString()} PRICE LISTINGS` : pricesState.status === 'error' ? 'PRICE FEED UNAVAILABLE' : 'LOADING PRICE FEED'}</span></div>
      <div className="item-catalog-controls">
        <label><span>CATEGORY</span><select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">Choose category</option>{categoriesState.rows.slice().sort((left, right) => `${readText(left, 'section')} ${readText(left, 'name')}`.localeCompare(`${readText(right, 'section')} ${readText(right, 'name')}`)).map((category) => <option key={readText(category, 'id')} value={readText(category, 'id')}>{readText(category, 'section') ? `${readText(category, 'section')} · ` : ''}{readText(category, 'name')}</option>)}</select></label>
        <label className="item-catalog-search"><span>SEARCH ITEMS</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, manufacturer, vehicle" /></label>
      </div>
      {pricesState.status === 'error' && <div className="item-price-notice">UEX item prices could not be loaded. Item specifications remain available.</div>}
      {itemsState.status === 'loading' && <LoadingPanel label={`Loading ${readText(selectedCategory ?? {}, 'name')} items`} />}
      {itemsState.status === 'error' && <ErrorPanel resource="Items" message={itemsState.error} />}
      {itemsState.status === 'ready' && <div className="table-scroll"><table className="data-table item-catalog-table"><thead><tr><th>ITEM</th><th>MANUFACTURER</th><th>VEHICLE</th><th>LOWEST BUY</th><th>HIGHEST SELL</th><th>BUY AT</th><th></th></tr></thead><tbody>
        {visibleItems.map((item) => {
          const itemId = readText(item, 'id')
          const offers = pricesByItem.get(itemId) ?? []
          const buyOffers = offers.filter((offer) => readNumber(offer, 'price_buy') > 0).sort((left, right) => readNumber(left, 'price_buy') - readNumber(right, 'price_buy'))
          const sellOffers = offers.filter((offer) => readNumber(offer, 'price_sell') > 0).sort((left, right) => readNumber(right, 'price_sell') - readNumber(left, 'price_sell'))
          return <tr key={itemId}>
            <td className="primary-cell">{readText(item, 'name')}</td>
            <td>{readText(item, 'company_name') || '—'}</td>
            <td>{readText(item, 'vehicle_name') || '—'}</td>
            <td>{buyOffers[0] ? formatCredits(readNumber(buyOffers[0], 'price_buy')) : '—'}</td>
            <td>{sellOffers[0] ? formatCredits(readNumber(sellOffers[0], 'price_sell')) : '—'}</td>
            <td>{buyOffers[0] ? readText(buyOffers[0], 'terminal_name') : '—'}</td>
            <td><button className="secondary-button item-details-button" type="button" onClick={() => setDetailItem(item)}>Details</button></td>
          </tr>
        })}
        {!visibleItems.length && <tr><td colSpan={7} className="empty-cell">{itemsState.rows.length ? 'No items match this search.' : 'No items are listed for this category.'}</td></tr>}
      </tbody></table></div>}
      <div className="table-note"><span>Item details and market listings are community-reported UEX data.</span><span>{selectedCategory ? `${readText(selectedCategory, 'name')} · ${readText(selectedCategory, 'section')}` : 'Select a category'}</span></div>
    </section>
    {detailItem && <ItemDetailsDialog item={detailItem} prices={pricesByItem.get(readText(detailItem, 'id')) ?? []} token={token} onClose={() => setDetailItem(null)} />}
  </>
}

function ItemDetailsDialog({ item, prices, token, onClose }: { item: UexRow; prices: UexRow[]; token: string; onClose: () => void }) {
  const [attributesState, setAttributesState] = useState<DatasetState>({ rows: [], status: 'loading' })
  useEffect(() => {
    let active = true
    getUexData<UexRow[]>('items_attributes', token, { id_item: Number(readText(item, 'id')) }).then((rows) => {
      if (active) setAttributesState({ rows, status: 'ready' })
    }).catch((error) => {
      if (active) setAttributesState({ rows: [], status: 'error', error: error instanceof Error ? error.message : 'Unable to load item attributes.' })
    })
    return () => { active = false }
  }, [item, token])
  const buyOffers = prices.filter((row) => readNumber(row, 'price_buy') > 0).sort((left, right) => readNumber(left, 'price_buy') - readNumber(right, 'price_buy'))
  const sellOffers = prices.filter((row) => readNumber(row, 'price_sell') > 0).sort((left, right) => readNumber(right, 'price_sell') - readNumber(left, 'price_sell'))
  const metadata: [string, string][] = [
    ['Category', readText(item, 'category') || 'Not listed'],
    ['Section', readText(item, 'section') || 'Not listed'],
    ['Manufacturer', readText(item, 'company_name') || 'Not listed'],
    ['Compatible vehicle', readText(item, 'vehicle_name') || 'Not listed'],
    ['Size', readText(item, 'size') || 'Not listed'],
    ['Quality', readText(item, 'quality') || 'Not listed'],
    ['Game version', readText(item, 'game_version') || 'Not listed'],
    ['UUID', readText(item, 'uuid') || 'Not listed'],
  ]
  const referenceLinks = [['Wiki', readText(item, 'wiki')], ['RSI store', readText(item, 'url_store')], ['Screenshot', readText(item, 'screenshot')]].filter(([, url]) => url.startsWith('https://'))

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="record-modal item-details-modal" role="dialog" aria-modal="true" aria-labelledby="item-detail-title">
      <div className="record-modal-head"><div><span className="eyebrow">UEX ITEM · {readText(item, 'category')}</span><h2 id="item-detail-title">{readText(item, 'name')}</h2></div><button className="close-button" type="button" onClick={onClose} aria-label="Close item details">×</button></div>
      <div className="item-details-content">
        <section className="item-detail-section"><h3>Item information</h3><div className="item-detail-grid">{metadata.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div></section>
        <section className="item-detail-section"><h3>UEX attributes</h3>{attributesState.status === 'loading' && <span className="item-detail-muted">Loading attributes…</span>}{attributesState.status === 'error' && <span className="item-detail-muted">{attributesState.error}</span>}{attributesState.status === 'ready' && (attributesState.rows.length ? <div className="item-detail-attributes">{attributesState.rows.map((attribute) => <div key={readText(attribute, 'id')}><span>{readText(attribute, 'attribute_name')}</span><strong>{readText(attribute, 'value') || '—'}{readText(attribute, 'unit') ? ` ${readText(attribute, 'unit')}` : ''}</strong></div>)}</div> : <span className="item-detail-muted">No attributes listed for this item.</span>)}</section>
        <section className="item-detail-section"><h3>Market listings</h3>{prices.length ? <div className="item-price-list">{prices.slice().sort((left, right) => readText(left, 'terminal_name').localeCompare(readText(right, 'terminal_name'))).map((offer) => <div key={readText(offer, 'id')}><strong>{readText(offer, 'terminal_name')}</strong><span>Buy {readNumber(offer, 'price_buy') > 0 ? formatCredits(readNumber(offer, 'price_buy')) : '—'}</span><span>Sell {readNumber(offer, 'price_sell') > 0 ? formatCredits(readNumber(offer, 'price_sell')) : '—'}</span></div>)}</div> : <span className="item-detail-muted">No current item price listings.</span>}</section>
        {referenceLinks.length > 0 && <section className="item-detail-section"><h3>Reference links</h3><div className="item-detail-links">{referenceLinks.map(([label, url]) => <a href={url} key={label} target="_blank" rel="noreferrer">{label} ↗</a>)}</div></section>}
        {(buyOffers[0] || sellOffers[0]) && <div className="item-detail-best-prices"><span>BEST BUY <strong>{buyOffers[0] ? formatCredits(readNumber(buyOffers[0], 'price_buy')) : '—'}</strong></span><span>BEST SELL <strong>{sellOffers[0] ? formatCredits(readNumber(sellOffers[0], 'price_sell')) : '—'}</strong></span></div>}
      </div>
    </section>
  </div>
}

function FuelPricesView({ rows, terminals, state }: { rows: UexRow[]; terminals: UexRow[]; state: DatasetState }) {
  if (state.status === 'loading' || state.status === 'idle') return <LoadingPanel label="Loading UEX fuel prices" />
  if (state.status === 'error') return <ErrorPanel resource="Fuel prices" message={state.error} />

  const terminalById = new Map(terminals.map((terminal) => [readText(terminal, 'id'), terminal]))
  const terminalName = (row: UexRow) => readText(terminalById.get(readText(row, 'id_terminal')) ?? {}, 'name', 'terminal_name') || readText(row, 'terminal_name') || 'Unknown terminal'
  const locations = new Set(rows.map((row) => readText(row, 'id_terminal') || terminalName(row)))
  const orderedRows = [...rows].sort((left, right) => terminalName(left).localeCompare(terminalName(right), undefined, { sensitivity: 'base' }) || readText(left, 'commodity_name').localeCompare(readText(right, 'commodity_name'), undefined, { sensitivity: 'base' }))

  return <>
    <DataPanel title="Fuel prices by location" subtitle={`${rows.length.toLocaleString()} listings across ${locations.size.toLocaleString()} terminals · prices in aUEC per unit`} columns={['FUEL TYPE', 'TERMINAL', 'SYSTEM / LOCATION', 'CURRENT BUY', 'UEX AVERAGE']} rows={orderedRows.map((row) => {
      const location = getVehicleOfferLocation(row, terminals)
      return [readText(row, 'commodity_name') || 'Unknown fuel', terminalName(row), location || 'Location not listed', readNumber(row, 'price_buy') > 0 ? formatCredits(readNumber(row, 'price_buy')) : '—', readNumber(row, 'price_buy_avg') > 0 ? formatCredits(readNumber(row, 'price_buy_avg')) : '—']
    })} />
    <div className="table-note"><span>Listings and averages are community-reported UEX data.</span><span>{state.rows.length.toLocaleString()} TOTAL UEX LISTINGS</span></div>
  </>
}

function sectionTitle(section: Section) {
  const titles: Record<Section, string> = { dashboard: 'Dashboard', settings: 'Settings', trade: 'Trade routes', finance: 'Money & ledger', holdings: 'Cargo holdings', hangar: 'Personal hangar', crew: 'Crew manager', routePlanner: 'Route planner', commodities: 'Commodities', ships: 'Ships & vehicles', systems: 'Star systems', mining: 'Mining & refining', inventory: 'Items & equipment', fuelPrices: 'Fuel prices' }
  return titles[section]
}

function sectionDescription(section: Section) {
  const descriptions: Record<Section, string> = {
    dashboard: 'Operational overview',
    settings: 'Customize the appearance of your command hub.',
    trade: 'Compare reported market prices and find positive terminal-to-terminal spreads.',
    finance: 'Manage aUEC accounts and record your buy and sell activity.',
    holdings: 'Review recorded ownership, ship cargo assignments, and sell directly from your active hold.',
    hangar: 'Build your personal fleet and choose the ship whose cargo hold you are managing.',
    crew: 'Assign crew roles, set default shares, and choose where each sale payout is deposited.',
    routePlanner: 'Plan commodity pickups and drop-offs using current terminal prices and volume.',
    commodities: 'Browse goods listed across the UEX commodity catalog and market feed.',
    ships: 'Explore the UEX vehicle registry and compare published specifications.',
    systems: 'Browse UEX systems, planets, terminal locations, and current commodity markets.',
    mining: 'Review reported ore prices and stock at listed terminals.',
    inventory: 'Equipment and item records from UEX.',
    fuelPrices: 'Compare current quantum and hydrogen fuel prices at UEX terminals.',
  }
  return descriptions[section]
}

function formatCredits(value: number) {
  const rounded = Math.round(value * 100) / 100
  return `${rounded.toLocaleString(undefined, { maximumFractionDigits: 2 })} aUEC`
}

function formatQuantity(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

export default App