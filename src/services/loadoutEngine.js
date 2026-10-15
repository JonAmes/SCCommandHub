/**
 * Loadout calculation engine.
 *
 * Pure functions only: no database or I/O access, so the engine can be reused by the API,
 * tests, or a future client-side calculator.
 *
 * Component `stats` keys used by the engine (all optional, per second where applicable):
 *   burstDps, sustainedDps, shieldHp, powerOutput, powerDraw, coolingRate, heatGeneration
 */

const STAT_KEYS = [
  'burstDps',
  'sustainedDps',
  'shieldHp',
  'powerOutput',
  'powerDraw',
  'coolingRate',
  'heatGeneration',
]

const round = (value) => Math.round(value * 100) / 100

function parseJson(value, fallback) {
  if (typeof value !== 'string') return value ?? fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function toComponentIndex(allComponents) {
  if (allComponents instanceof Map) return allComponents
  const list = Array.isArray(allComponents) ? allComponents : Object.values(allComponents ?? {})
  return new Map(list.filter((component) => component?.id != null).map((c) => [String(c.id), c]))
}

function readStats(component) {
  const raw = parseJson(component.stats, {})
  const stats = {}
  for (const key of STAT_KEYS) {
    const value = Number(raw?.[key])
    stats[key] = Number.isFinite(value) ? value : 0
  }
  // Weapons without heat/ammo constraints can sustain their burst output.
  if (raw?.sustainedDps === undefined) stats.sustainedDps = stats.burstDps
  return stats
}

const sameText = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

/** True when the component type/sub-type is accepted by the hardpoint. */
export function isTypeCompatible(hardpoint, component) {
  const types = Array.isArray(hardpoint.types) ? hardpoint.types : []
  if (types.length === 0) {
    return !hardpoint.type || !component.type || sameText(hardpoint.type, component.type)
  }
  if (!component.type) return false

  const subType = component.sub_type ?? component.subType ?? null
  return types.some(({ type, subTypes = [] }) => {
    if (!sameText(type, component.type)) return false
    if (subTypes.length === 0 || !subType) return true
    return subTypes.some((allowed) => sameText(allowed, subType))
  })
}

/** Compatibility issues for placing `component` in `hardpoint` (empty array = compatible). */
export function checkCompatibility(hardpoint, component) {
  const issues = []
  const size = Number(component.size)
  const minSize = Number(hardpoint.minSize ?? 0)
  const maxSize = Number(hardpoint.maxSize ?? hardpoint.size ?? 0)

  if (hardpoint.editable === false) {
    issues.push({ code: 'SLOT_NOT_EDITABLE', message: `Slot "${hardpoint.name}" cannot be modified` })
  }
  if (!isTypeCompatible(hardpoint, component)) {
    const accepted = (hardpoint.types ?? []).map((t) => t.type).join(', ') || hardpoint.type
    issues.push({
      code: 'TYPE_MISMATCH',
      message: `${component.name} (${component.type ?? 'unknown type'}) does not fit slot "${hardpoint.name}" (accepts ${accepted})`,
    })
  }
  if (component.size === null || component.size === undefined || !Number.isFinite(size)) {
    issues.push({ code: 'UNKNOWN_SIZE', message: `${component.name} has no size; size check skipped`, severity: 'warning' })
  } else if (size > maxSize) {
    issues.push({
      code: 'SIZE_TOO_LARGE',
      message: `${component.name} is size ${size} but slot "${hardpoint.name}" allows at most size ${maxSize}`,
    })
  } else if (size < minSize) {
    issues.push({
      code: 'SIZE_TOO_SMALL',
      message: `${component.name} is size ${size} but slot "${hardpoint.name}" requires at least size ${minSize}`,
    })
  }

  return issues.map((issue) => ({ severity: 'error', ...issue }))
}

/**
 * Calculate aggregate stats for a ship loadout.
 *
 * @param {{ id: string, name?: string, hardpoints: Array|string }} ship
 * @param {Record<string, string|null>} loadoutMap  Hardpoint name -> component ID (null/'' = empty).
 * @param {Array|Map|Record<string, object>} allComponents  Components available for lookup.
 */
export function calculateLoadout(ship, loadoutMap, allComponents) {
  if (!ship) throw new TypeError('ship is required')

  const hardpoints = parseJson(ship.hardpoints, [])
  const slotIndex = new Map((Array.isArray(hardpoints) ? hardpoints : []).map((h) => [h.name, h]))
  const components = toComponentIndex(allComponents)

  const errors = []
  const warnings = []
  const slots = []
  const totals = Object.fromEntries(STAT_KEYS.map((key) => [key, 0]))

  for (const [slotName, rawComponentId] of Object.entries(loadoutMap ?? {})) {
    if (rawComponentId === null || rawComponentId === undefined || rawComponentId === '') continue
    const componentId = String(rawComponentId)

    const hardpoint = slotIndex.get(slotName)
    const component = components.get(componentId)
    const slot = {
      slot: slotName,
      componentId,
      componentName: component?.name ?? null,
      type: component?.type ?? null,
      size: component?.size ?? null,
      accepted: false,
      issues: [],
    }

    if (!hardpoint) {
      slot.issues.push({ severity: 'error', code: 'UNKNOWN_SLOT', message: `Ship has no slot named "${slotName}"` })
    }
    if (!component) {
      slot.issues.push({ severity: 'error', code: 'UNKNOWN_COMPONENT', message: `Component "${componentId}" not found` })
    }
    if (hardpoint && component) slot.issues.push(...checkCompatibility(hardpoint, component))

    slot.accepted = slot.issues.every((issue) => issue.severity !== 'error')
    if (slot.accepted) {
      slot.stats = readStats(component)
      for (const key of STAT_KEYS) totals[key] += slot.stats[key]
    }

    for (const issue of slot.issues) {
      ;(issue.severity === 'error' ? errors : warnings).push({ slot: slotName, ...issue })
    }
    slots.push(slot)
  }

  const powerMargin = totals.powerOutput - totals.powerDraw
  const power = {
    generation: round(totals.powerOutput),
    draw: round(totals.powerDraw),
    margin: round(powerMargin),
    utilization: totals.powerOutput > 0 ? round((totals.powerDraw / totals.powerOutput) * 100) : null,
    valid: powerMargin >= 0,
    status: powerMargin >= 0 ? 'ok' : totals.powerOutput === 0 ? 'no_generation' : 'overdrawn',
  }
  if (!power.valid) {
    warnings.push({
      severity: 'warning',
      code: power.status === 'no_generation' ? 'NO_POWER_GENERATION' : 'POWER_OVERDRAWN',
      message:
        power.status === 'no_generation'
          ? `Components draw ${power.draw} power but no power plant is equipped`
          : `Power draw ${power.draw} exceeds generation ${power.generation} by ${round(-powerMargin)}`,
    })
  }

  const coolingMargin = totals.coolingRate - totals.heatGeneration
  const cooling = {
    capacity: round(totals.coolingRate),
    heatGeneration: round(totals.heatGeneration),
    margin: round(coolingMargin),
    utilization: totals.coolingRate > 0 ? round((totals.heatGeneration / totals.coolingRate) * 100) : null,
    valid: coolingMargin >= 0,
    status: coolingMargin >= 0 ? 'ok' : totals.coolingRate === 0 ? 'no_cooling' : 'overheating',
  }
  if (!cooling.valid) {
    warnings.push({
      severity: 'warning',
      code: cooling.status === 'no_cooling' ? 'NO_COOLING' : 'INSUFFICIENT_COOLING',
      message:
        cooling.status === 'no_cooling'
          ? `Components generate ${cooling.heatGeneration} heat but no cooler is equipped`
          : `Heat generation ${cooling.heatGeneration} exceeds cooling capacity ${cooling.capacity} by ${round(-coolingMargin)}`,
    })
  }

  return {
    shipId: ship.id,
    shipName: ship.name ?? null,
    valid: errors.length === 0 && power.valid && cooling.valid,
    totals: {
      burstDps: round(totals.burstDps),
      sustainedDps: round(totals.sustainedDps),
      shieldHp: round(totals.shieldHp),
      power,
      cooling,
    },
    slots,
    warnings,
    errors,
  }
}
