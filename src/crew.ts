const storageKey = 'sc-command-hub.crew-v1'

export type CrewMember = {
  id: string
  name: string
  sharePercent: number
  roleId?: string | null
  payoutAccountId?: string | null
  createdAt: string
}

export type CrewRole = {
  id: string
  name: string
  defaultSharePercent: number
  createdAt: string
}

export type CrewState = {
  members: CrewMember[]
  roles: CrewRole[]
}

const emptyState = (): CrewState => ({ members: [], roles: [] })

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function isCrewMember(value: unknown): value is CrewMember {
  if (!value || typeof value !== 'object') return false
  const member = value as Partial<CrewMember>
  return typeof member.id === 'string'
    && typeof member.name === 'string'
    && Number.isFinite(member.sharePercent)
    && (member.sharePercent ?? -1) >= 0
    && (member.sharePercent ?? 101) <= 100
    && (member.roleId === undefined || member.roleId === null || typeof member.roleId === 'string')
    && (member.payoutAccountId === undefined || member.payoutAccountId === null || typeof member.payoutAccountId === 'string')
    && typeof member.createdAt === 'string'
}

  function isCrewRole(value: unknown): value is CrewRole {
    if (!value || typeof value !== 'object') return false
    const role = value as Partial<CrewRole>
    return typeof role.id === 'string'
    && typeof role.name === 'string'
    && Number.isFinite(role.defaultSharePercent)
    && (role.defaultSharePercent ?? -1) >= 0
    && (role.defaultSharePercent ?? 101) <= 100
    && typeof role.createdAt === 'string'
  }

export function loadCrewState(): CrewState {
  try {
    const stored = window.localStorage.getItem(storageKey)
    if (!stored) return emptyState()
    const parsed: unknown = JSON.parse(stored)
    if (!parsed || typeof parsed !== 'object') return emptyState()
    const value = parsed as Partial<CrewState>
    const roles = Array.isArray(value.roles) ? value.roles.filter(isCrewRole) : []
    const members = Array.isArray(value.members) ? value.members.filter(isCrewMember).map((member) => {
      const role = roles.find((item) => item.id === member.roleId)
      return role
        ? { ...member, roleId: role.id, sharePercent: role.defaultSharePercent, payoutAccountId: member.payoutAccountId ?? null }
        : { ...member, roleId: null, payoutAccountId: member.payoutAccountId ?? null }
    }) : []
    return { members, roles }
  } catch {
    return emptyState()
  }
}

export function saveCrewState(state: CrewState) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

function validateShareTotal(members: CrewMember[]) {
  const total = members.reduce((sum, member) => sum + member.sharePercent, 0)
  return total <= 100 ? '' : `Crew shares total ${total.toFixed(2)}%. The total cannot exceed 100%.`
}

function validateSharePercent(sharePercent: number) {
  return Number.isFinite(sharePercent) && sharePercent >= 0 && sharePercent <= 100
    ? ''
    : 'Share must be between 0 and 100%.'
}

export function addCrewMember(state: CrewState, name: string, sharePercent: number, roleId: string | null = null, payoutAccountId: string | null = null): { state?: CrewState; error?: string } {
  const normalizedName = name.trim()
  if (!normalizedName) return { error: 'Enter a crew member name.' }
  if (state.members.some((member) => member.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) return { error: 'A crew member with this name already exists.' }
  const role = roleId ? state.roles.find((item) => item.id === roleId) : undefined
  if (roleId && !role) return { error: 'Choose a valid crew role.' }
  const memberShare = role ? role.defaultSharePercent : sharePercent
  const shareError = validateSharePercent(memberShare)
  if (shareError) return { error: shareError }
  const member: CrewMember = { id: createId(), name: normalizedName, sharePercent: memberShare, roleId: role?.id ?? null, payoutAccountId, createdAt: new Date().toISOString() }
  const members = [...state.members, member]
  const error = validateShareTotal(members)
  return error ? { error } : { state: { ...state, members } }
}

export function updateCrewMemberShare(state: CrewState, memberId: string, sharePercent: number): { state?: CrewState; error?: string } {
  const shareError = validateSharePercent(sharePercent)
  if (shareError) return { error: shareError }
  const member = state.members.find((item) => item.id === memberId)
  if (!member) return { error: 'Crew member was not found.' }
  if (member.roleId) return { error: 'This member’s share is set by their role. Change the role default instead.' }
  const members = state.members.map((member) => member.id === memberId ? { ...member, sharePercent } : member)
  const error = validateShareTotal(members)
  return error ? { error } : { state: { ...state, members } }
}

export function removeCrewMember(state: CrewState, memberId: string): CrewState {
  return { ...state, members: state.members.filter((member) => member.id !== memberId) }
}

export function addCrewRole(state: CrewState, name: string, defaultSharePercent: number): { state?: CrewState; error?: string } {
  const normalizedName = name.trim()
  if (!normalizedName) return { error: 'Enter a role name.' }
  if (state.roles.some((role) => role.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) return { error: 'A role with this name already exists.' }
  const shareError = validateSharePercent(defaultSharePercent)
  if (shareError) return { error: shareError.replace('Share', 'Default share') }
  const role: CrewRole = { id: createId(), name: normalizedName, defaultSharePercent, createdAt: new Date().toISOString() }
  return { state: { ...state, roles: [...state.roles, role] } }
}

export function updateCrewRoleDefault(state: CrewState, roleId: string, defaultSharePercent: number): { state?: CrewState; error?: string } {
  const shareError = validateSharePercent(defaultSharePercent)
  if (shareError) return { error: shareError.replace('Share', 'Default share') }
  if (!state.roles.some((role) => role.id === roleId)) return { error: 'Crew role was not found.' }
  const roles = state.roles.map((role) => role.id === roleId ? { ...role, defaultSharePercent } : role)
  const members = state.members.map((member) => member.roleId === roleId ? { ...member, sharePercent: defaultSharePercent } : member)
  const error = validateShareTotal(members)
  return error ? { error } : { state: { ...state, roles, members } }
}

export function assignCrewRole(state: CrewState, memberId: string, roleId: string | null): { state?: CrewState; error?: string } {
  const member = state.members.find((item) => item.id === memberId)
  if (!member) return { error: 'Crew member was not found.' }
  const role = roleId ? state.roles.find((item) => item.id === roleId) : undefined
  if (roleId && !role) return { error: 'Choose a valid crew role.' }
  const members = state.members.map((item) => item.id === memberId
    ? { ...item, roleId: role?.id ?? null, sharePercent: role?.defaultSharePercent ?? item.sharePercent }
    : item)
  const error = validateShareTotal(members)
  return error ? { error } : { state: { ...state, members } }
}

export function removeCrewRole(state: CrewState, roleId: string): CrewState {
  return {
    roles: state.roles.filter((role) => role.id !== roleId),
    members: state.members.map((member) => member.roleId === roleId ? { ...member, roleId: null } : member),
  }
}

export function getCrewSharePercent(state: CrewState) {
  return state.members.reduce((sum, member) => sum + member.sharePercent, 0)
}

export function updateCrewMemberPayoutAccount(state: CrewState, memberId: string, payoutAccountId: string | null): { state?: CrewState; error?: string } {
  if (!state.members.some((member) => member.id === memberId)) return { error: 'Crew member was not found.' }
  return {
    state: {
      ...state,
      members: state.members.map((member) => member.id === memberId ? { ...member, payoutAccountId } : member),
    },
  }
}