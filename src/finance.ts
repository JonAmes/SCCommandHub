import type { CrewMember } from './crew'
import { CONTAINER_SIZES, isContainerSizedQuantity } from './containerSizes'

const storageKey = 'sc-command-hub.finance-v1'

export type TradeSide = 'buy' | 'sell'
export type AccountTransactionKind = 'deposit' | 'withdrawal' | 'transfer'
export type AccountAdjustmentKind = Exclude<AccountTransactionKind, 'transfer'>
export type VehiclePurchase = { accountId: string; vehicleId: string; vehicleName: string; terminal: string; price: number }

export type BankAccount = {
  id: string
  name: string
  balance: number
  createdAt: string
}

export type LedgerEntry = {
  id: string
  accountId: string
  accountName: string
  side: TradeSide | AccountTransactionKind | 'vehicle_purchase'
  commodity: string
  terminal: string
  quantity: number
  unitPrice: number
  total: number
  note: string
  recordedAt: string
  containerSize?: number
  containerCount?: number
  transferToAccountId?: string
  transferToAccountName?: string
  crewShareTotal?: number
  crewShares?: CrewSharePayout[]
}

export type CrewSharePayout = {
  memberId: string
  memberName: string
  sharePercent: number
  amount: number
  accountId?: string
  accountName?: string
}

export type CrewPayoutPreview = {
  payouts: CrewSharePayout[]
  crewShareTotal: number
  accountNet: number
  error?: string
}

export type CommodityHolding = {
  commodity: string
  purchased: number
  sold: number
  quantity: number
  averagePurchasePrice: number
}

export type FinanceState = {
  accounts: BankAccount[]
  transactions: LedgerEntry[]
}

export type NewTrade = Omit<LedgerEntry, 'id' | 'accountName' | 'side' | 'total' | 'recordedAt'> & { side: TradeSide }

const emptyState = (): FinanceState => ({ accounts: [], transactions: [] })

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function isAccount(value: unknown): value is BankAccount {
  if (!value || typeof value !== 'object') return false
  const account = value as Partial<BankAccount>
  return typeof account.id === 'string' && typeof account.name === 'string' && Number.isFinite(account.balance)
}

function isTransaction(value: unknown): value is LedgerEntry {
  if (!value || typeof value !== 'object') return false
  const transaction = value as Partial<LedgerEntry>
  return typeof transaction.id === 'string'
    && typeof transaction.accountId === 'string'
    && (transaction.side === 'buy' || transaction.side === 'sell' || transaction.side === 'deposit' || transaction.side === 'withdrawal' || transaction.side === 'transfer' || transaction.side === 'vehicle_purchase')
    && typeof transaction.commodity === 'string'
    && Number.isFinite(transaction.total)
    && (transaction.crewShareTotal === undefined || Number.isFinite(transaction.crewShareTotal))
    && (transaction.containerSize === undefined || CONTAINER_SIZES.some((size) => size === transaction.containerSize))
    && (transaction.containerCount === undefined || (Number.isInteger(transaction.containerCount) && transaction.containerCount > 0))
    && (transaction.crewShares === undefined || (Array.isArray(transaction.crewShares) && transaction.crewShares.every((share) => {
      if (!share || typeof share !== 'object') return false
      const payout = share as Partial<CrewSharePayout>
      return typeof payout.memberId === 'string'
        && typeof payout.memberName === 'string'
        && Number.isFinite(payout.sharePercent)
        && Number.isFinite(payout.amount)
        && (payout.accountId === undefined || typeof payout.accountId === 'string')
        && (payout.accountName === undefined || typeof payout.accountName === 'string')
    })))
}

export function loadFinanceState(): FinanceState {
  try {
    const stored = window.localStorage.getItem(storageKey)
    if (!stored) return emptyState()
    const parsed: unknown = JSON.parse(stored)
    if (!parsed || typeof parsed !== 'object') return emptyState()
    const value = parsed as Partial<FinanceState>
    return {
      accounts: Array.isArray(value.accounts) ? value.accounts.filter(isAccount) : [],
      transactions: Array.isArray(value.transactions) ? value.transactions.filter(isTransaction) : [],
    }
  } catch {
    return emptyState()
  }
}

export function saveFinanceState(state: FinanceState) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

export function createBankAccount(name: string, balance: number): BankAccount {
  return { id: createId(), name: name.trim(), balance, createdAt: new Date().toISOString() }
}

function calculateCrewPayouts(total: number, members: CrewMember[], accounts: BankAccount[]): { payouts?: CrewSharePayout[]; error?: string } {
  const eligibleMembers = members.filter((member) => member.sharePercent > 0)
  const sharePercent = eligibleMembers.reduce((sum, member) => sum + member.sharePercent, 0)
  if (!sharePercent) return { payouts: [] }

  const membersWithAccounts = eligibleMembers.map((member) => {
    const account = accounts.find((item) => item.id === member.payoutAccountId)
    return { member, account }
  })
  const missingAccount = membersWithAccounts.find(({ account }) => !account)
  if (missingAccount) return { error: `Choose a payout account for ${missingAccount.member.name} in Crew Manager.` }

  const payoutCents = Math.min(Math.round(total * 100), Math.round(total * 100 * sharePercent / 100))
  const payouts = membersWithAccounts.map(({ member, account }) => {
    const exactCents = payoutCents * member.sharePercent / sharePercent
    const cents = Math.floor(exactCents)
    return { member, account: account!, cents, remainder: exactCents - cents }
  })
  let unassignedCents = payoutCents - payouts.reduce((sum, payout) => sum + payout.cents, 0)
  const roundingOrder = [...payouts].sort((left, right) => right.remainder - left.remainder)
  for (const payout of roundingOrder) {
    if (!unassignedCents) break
    payout.cents += 1
    unassignedCents -= 1
  }

  return {
    payouts: payouts.map(({ member, account, cents }) => ({
      memberId: member.id,
      memberName: member.name,
      sharePercent: member.sharePercent,
      amount: cents / 100,
      accountId: account.id,
      accountName: account.name,
    })),
  }
}

export function previewCrewPayouts(total: number, members: CrewMember[], accounts: BankAccount[], saleAccountId: string): CrewPayoutPreview {
  const sharePercent = members.reduce((sum, member) => sum + member.sharePercent, 0)
  if (sharePercent > 100) return { payouts: [], crewShareTotal: 0, accountNet: 0, error: 'Crew shares cannot exceed 100% of sale proceeds.' }
  const result = calculateCrewPayouts(total, members, accounts)
  if (result.error) return { payouts: [], crewShareTotal: 0, accountNet: 0, error: result.error }
  const payouts = result.payouts ?? []
  const crewShareTotal = payouts.reduce((sum, share) => sum + share.amount, 0)
  const paidToSaleAccount = payouts.filter((share) => share.accountId === saleAccountId).reduce((sum, share) => sum + share.amount, 0)
  return {
    payouts,
    crewShareTotal,
    accountNet: Math.round((total - crewShareTotal + paidToSaleAccount) * 100) / 100,
  }
}

export function recordTrade(state: FinanceState, trade: NewTrade, crewMembers: CrewMember[] = []): { state?: FinanceState; error?: string } {
  if (!trade.commodity.trim() || !trade.terminal.trim()) return { error: 'Choose a commodity and terminal.' }
  if (!isContainerSizedQuantity(trade.quantity)) return { error: 'Trade quantity must be a whole number of SCU containers.' }
  const containerSize = trade.containerSize ?? 1
  const containerCount = trade.containerCount ?? trade.quantity
  if (!CONTAINER_SIZES.some((size) => size === containerSize) || !Number.isInteger(containerCount) || containerCount <= 0 || containerSize * containerCount !== trade.quantity) {
    return { error: 'Choose a valid container size and count for this trade.' }
  }
  if (!Number.isFinite(trade.unitPrice) || trade.unitPrice <= 0) return { error: 'Unit price must be greater than zero.' }

  const account = state.accounts.find((item) => item.id === trade.accountId)
  if (!account) return { error: 'Choose an account before recording this trade.' }
  if (trade.side === 'sell' && getHeldQuantity(state, trade.commodity) < trade.quantity) {
    return { error: `You only have ${getHeldQuantity(state, trade.commodity)} SCU of ${trade.commodity} recorded in holdings.` }
  }

  const total = Math.round(trade.quantity * trade.unitPrice * 100) / 100
  if (trade.side === 'buy' && account.balance < total) return { error: 'Insufficient account balance for this purchase.' }
  const crewPreview = trade.side === 'sell'
    ? previewCrewPayouts(total, crewMembers, state.accounts, account.id)
    : { payouts: [], crewShareTotal: 0, accountNet: 0 }
  if (crewPreview.error) return { error: crewPreview.error }
  const crewShares = crewPreview.payouts
  const crewShareTotal = crewPreview.crewShareTotal
  const accountCredit = Math.round((total - crewShareTotal) * 100) / 100

  const entry: LedgerEntry = {
    ...trade,
    containerSize,
    containerCount,
    id: createId(),
    accountName: account.name,
    total,
    recordedAt: new Date().toISOString(),
    ...(trade.side === 'sell' && crewShares.length ? { crewShareTotal, crewShares } : {}),
  }

  return {
    state: {
      accounts: state.accounts.map((item) => {
        const saleCredit = trade.side === 'sell' && item.id === account.id ? accountCredit : 0
        const purchaseDebit = trade.side === 'buy' && item.id === account.id ? total : 0
        const crewCredit = trade.side === 'sell'
          ? crewShares.filter((share) => share.accountId === item.id).reduce((sum, share) => sum + share.amount, 0)
          : 0
        const balance = Math.round((item.balance + saleCredit - purchaseDebit + crewCredit) * 100) / 100
        return balance === item.balance ? item : { ...item, balance }
      }),
      transactions: [entry, ...state.transactions],
    },
  }
}

export function recordVehiclePurchase(state: FinanceState, purchase: VehiclePurchase): { state?: FinanceState; error?: string } {
  if (!purchase.vehicleId.trim() || !purchase.vehicleName.trim() || !purchase.terminal.trim()) return { error: 'Choose a vehicle and purchase location.' }
  if (!Number.isFinite(purchase.price) || purchase.price <= 0) return { error: 'Vehicle price must be greater than zero.' }

  const account = state.accounts.find((item) => item.id === purchase.accountId)
  if (!account) return { error: 'Choose an account before purchasing this vehicle.' }
  const total = Math.round(purchase.price * 100) / 100
  if (account.balance < total) return { error: 'Insufficient account balance for this vehicle purchase.' }

  const entry: LedgerEntry = {
    id: createId(),
    accountId: account.id,
    accountName: account.name,
    side: 'vehicle_purchase',
    commodity: purchase.vehicleName,
    terminal: purchase.terminal,
    quantity: 1,
    unitPrice: total,
    total,
    note: `In-game vehicle purchase · UEX vehicle ${purchase.vehicleId}`,
    recordedAt: new Date().toISOString(),
  }

  return {
    state: {
      accounts: state.accounts.map((item) => item.id === account.id ? { ...item, balance: Math.round((item.balance - total) * 100) / 100 } : item),
      transactions: [entry, ...state.transactions],
    },
  }
}

export function transferFunds(
  state: FinanceState,
  fromAccountId: string,
  toAccountId: string,
  amount: number,
  note = '',
): { state?: FinanceState; error?: string } {
  if (fromAccountId === toAccountId) return { error: 'Choose two different accounts.' }
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Transfer amount must be greater than zero.' }

  const source = state.accounts.find((account) => account.id === fromAccountId)
  const destination = state.accounts.find((account) => account.id === toAccountId)
  if (!source || !destination) return { error: 'Choose a source and destination account.' }
  if (source.balance < amount) return { error: 'Insufficient source account balance.' }

  const roundedAmount = Math.round(amount * 100) / 100
  if (source.balance < roundedAmount) return { error: 'Insufficient source account balance.' }
  const entry: LedgerEntry = {
    id: createId(),
    accountId: source.id,
    accountName: source.name,
    side: 'transfer',
    commodity: 'Account transfer',
    terminal: 'Internal transfer',
    quantity: 0,
    unitPrice: 0,
    total: roundedAmount,
    note: note.trim(),
    recordedAt: new Date().toISOString(),
    transferToAccountId: destination.id,
    transferToAccountName: destination.name,
  }

  return {
    state: {
      accounts: state.accounts.map((account) => {
        if (account.id === source.id) return { ...account, balance: Math.round((account.balance - roundedAmount) * 100) / 100 }
        if (account.id === destination.id) return { ...account, balance: Math.round((account.balance + roundedAmount) * 100) / 100 }
        return account
      }),
      transactions: [entry, ...state.transactions],
    },
  }
}

export function recordAccountAdjustment(
  state: FinanceState,
  kind: AccountAdjustmentKind,
  accountId: string,
  amount: number,
  note = '',
): { state?: FinanceState; error?: string } {
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Amount must be greater than zero.' }
  const account = state.accounts.find((item) => item.id === accountId)
  if (!account) return { error: 'Choose an account.' }
  const roundedAmount = Math.round(amount * 100) / 100
  if (roundedAmount <= 0) return { error: 'Amount must be at least 0.01 aUEC.' }
  if (kind === 'withdrawal' && account.balance < roundedAmount) return { error: 'Insufficient account balance for this withdrawal.' }

  const entry: LedgerEntry = {
    id: createId(),
    accountId: account.id,
    accountName: account.name,
    side: kind,
    commodity: kind === 'deposit' ? 'Account deposit' : 'Account withdrawal',
    terminal: 'Manual account entry',
    quantity: 0,
    unitPrice: 0,
    total: roundedAmount,
    note: note.trim(),
    recordedAt: new Date().toISOString(),
  }
  return {
    state: {
      accounts: state.accounts.map((item) => item.id !== account.id ? item : {
        ...item,
        balance: Math.round((item.balance + (kind === 'deposit' ? roundedAmount : -roundedAmount)) * 100) / 100,
      }),
      transactions: [entry, ...state.transactions],
    },
  }
}

export function getHeldQuantity(state: FinanceState, commodity: string) {
  return state.transactions.reduce((quantity, entry) => {
    if (entry.commodity !== commodity) return quantity
    if (entry.side === 'buy') return quantity + entry.quantity
    if (entry.side === 'sell') return quantity - entry.quantity
    return quantity
  }, 0)
}

export function getCommodityHoldings(state: FinanceState): CommodityHolding[] {
  const totals = new Map<string, { purchased: number; sold: number; purchaseValue: number }>()
  for (const entry of state.transactions) {
    if (entry.side !== 'buy' && entry.side !== 'sell') continue
    const current = totals.get(entry.commodity) ?? { purchased: 0, sold: 0, purchaseValue: 0 }
    if (entry.side === 'buy') {
      current.purchased += entry.quantity
      current.purchaseValue += entry.quantity * entry.unitPrice
    } else {
      current.sold += entry.quantity
    }
    totals.set(entry.commodity, current)
  }

  return [...totals.entries()]
    .map(([commodity, values]) => ({
      commodity,
      purchased: values.purchased,
      sold: values.sold,
      quantity: Math.max(0, values.purchased - values.sold),
      averagePurchasePrice: values.purchased ? values.purchaseValue / values.purchased : 0,
    }))
    .filter((holding) => holding.quantity > 0)
    .sort((left, right) => left.commodity.localeCompare(right.commodity))
}

export function getRealizedProfitLoss(state: FinanceState): Map<string, number | null> {
  const chronological = state.transactions
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => left.entry.recordedAt.localeCompare(right.entry.recordedAt) || left.index - right.index)
  const lotsByCommodity = new Map<string, { quantity: number; unitPrice: number }[]>()
  const profitLossByEntry = new Map<string, number | null>()

  for (const { entry } of chronological) {
    if (entry.side === 'buy') {
      const lots = lotsByCommodity.get(entry.commodity) ?? []
      lots.push({ quantity: entry.quantity, unitPrice: entry.unitPrice })
      lotsByCommodity.set(entry.commodity, lots)
      continue
    }
    if (entry.side !== 'sell') continue

    let remaining = entry.quantity
    let costBasis = 0
    const lots = lotsByCommodity.get(entry.commodity) ?? []
    while (remaining > 0.000001 && lots.length) {
      const lot = lots[0]
      const matchedQuantity = Math.min(remaining, lot.quantity)
      costBasis += matchedQuantity * lot.unitPrice
      remaining -= matchedQuantity
      lot.quantity -= matchedQuantity
      if (lot.quantity <= 0.000001) lots.shift()
    }
    lotsByCommodity.set(entry.commodity, lots)
    profitLossByEntry.set(entry.id, remaining > 0.000001
      ? null
      : Math.round((entry.total - (entry.crewShareTotal ?? 0) - costBasis) * 100) / 100)
  }

  return profitLossByEntry
}

export function getAccountHeldQuantity(state: FinanceState, accountId: string, commodity: string) {
  return state.transactions.reduce((quantity, entry) => {
    if (entry.accountId !== accountId || entry.commodity !== commodity) return quantity
    if (entry.side === 'buy') return quantity + entry.quantity
    if (entry.side === 'sell') return quantity - entry.quantity
    return quantity
  }, 0)
}