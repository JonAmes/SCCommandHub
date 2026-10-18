export type OcrTarget = 'shipTarget' | 'contacts' | 'salvage' | 'shipTerminal'
export type Material = 'Recycled Material Composite' | 'Construction Materials'
export type OcrReading = {
  target: OcrTarget
  identity: string
  values: Record<string, number>
  live: Record<string, number>
  text: string
}
export type OcrSample = { reading: OcrReading | null; confidence: number; warnings: string[] }
export type OcrWord = { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }
export type OcrArea = { x: number; y: number; width: number; height: number }

export function locateOcrAreas(words: OcrWord[], width: number, height: number, target: OcrTarget): OcrArea[] {
  if (width <= 0 || height <= 0) return []
  const rows: OcrWord[][] = []
  for (const word of [...words].sort((left, right) => left.bbox.y0 - right.bbox.y0 || left.bbox.x0 - right.bbox.x0)) {
    const row = rows.find((entries) => Math.abs((entries[0].bbox.y0 + entries[0].bbox.y1 - word.bbox.y0 - word.bbox.y1) / 2) < Math.min(entries[0].bbox.y1 - entries[0].bbox.y0, word.bbox.y1 - word.bbox.y0) * 0.5)
    if (row) row.push(word)
    else rows.push([word])
  }
  const ordered = rows.map((row) => row.sort((left, right) => left.bbox.x0 - right.bbox.x0))
  const bounds = (entries: OcrWord[]): OcrArea => {
    const pad = Math.max(4, ...entries.map((word) => word.bbox.y1 - word.bbox.y0))
    const x0 = Math.max(0, Math.min(...entries.map((word) => word.bbox.x0)) - pad)
    const y0 = Math.max(0, Math.min(...entries.map((word) => word.bbox.y0)) - pad)
    const x1 = Math.min(width, Math.max(...entries.map((word) => word.bbox.x1)) + pad)
    const y1 = Math.min(height, Math.max(...entries.map((word) => word.bbox.y1)) + pad)
    return { x: x0 / width, y: y0 / height, width: (x1 - x0) / width, height: (y1 - y0) / height }
  }
  if (target === 'shipTerminal') return ordered.flatMap((row) => {
    const stores = row.filter((word) => /^STORE$/i.test(word.text))
    if (stores.length !== 1 || row.some((word) => /^(?:CLAIM|UNKNOWN)$/i.test(word.text))) return []
    const names = row.filter((word) => word.bbox.x1 < stores[0].bbox.x0)
    return names.length && names.some((word) => /[a-z]{2}/i.test(word.text)) ? [bounds([...names, stores[0]])] : []
  })
  const anchors = ordered.filter((row) => target === 'salvage'
    ? /\b(?:RMC|RECYCLED MATERIAL COMPOSITE|CONSTRUCTION MATERIALS?|CM)\b/i.test(row.map((word) => word.text).join(' '))
    : /^(?:TARGET|SHIP|CONTACT|SIGNATURE|ID)\s*[:=]/i.test(row.map((word) => word.text).join(' ')))
  return anchors.map((anchor) => {
    const anchorBounds = bounds(anchor)
    const textHeight = Math.max(...anchor.map((word) => word.bbox.y1 - word.bbox.y0))
    const bottom = Math.min(height, (anchorBounds.y + anchorBounds.height) * height + textHeight * 10,
      ...anchors.filter((other) => other !== anchor && other[0].bbox.y0 > anchor[0].bbox.y1).map((other) => other[0].bbox.y0 - textHeight / 2))
    const content = ordered.flat().filter((word) => word.bbox.y0 >= anchor[0].bbox.y0 && word.bbox.y1 <= bottom && word.bbox.x0 >= anchorBounds.x * width && word.bbox.x1 <= (anchorBounds.x + anchorBounds.width) * width + textHeight * 12)
    return bounds(content.length ? content : anchor)
  })
}

export function normalizedIdentity(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
}

export function parseTerminalRows(text: string) {
  return text.split(/\r?\n/).flatMap((line) => {
    if (!/\bSTORE\b/i.test(line) || /\b(?:CLAIM|UNKNOWN)\b/i.test(line)) return []
    const name = line.split(/\bSTORE\b/i)[0].replace(/\b(?:STATUS|ACTION)\b/gi, '').replace(/[|:]+/g, ' ').trim()
    return name.length >= 3 && /[a-z]/i.test(name) ? [name] : []
  })
}

export function matchTerminalShip(name: string, ships: { id: string; name: string; manufacturer?: string }[]) {
  const identity = normalizedIdentity(name)
  const matches = ships.filter((ship) => [ship.name, `${ship.manufacturer ?? ''} ${ship.name}`].some((alias) => normalizedIdentity(alias) === identity))
  return matches.length === 1 ? matches[0].id : null
}

export function parseOcrReading(target: OcrTarget, text: string): OcrReading | null {
  const values: Record<string, number> = {}
  const live: Record<string, number> = {}
  const lines = text.toUpperCase().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (target === 'shipTerminal') {
    const rows = parseTerminalRows(text)
    return rows.length === 1 ? { target, identity: normalizedIdentity(rows[0]), values, live, text } : null
  }
  if (target === 'salvage') {
    for (const line of lines) {
      const material = /\b(?:RMC|RECYCLED MATERIAL COMPOSITE)\b/.test(line) ? 'Recycled Material Composite' : /\b(?:CM|CONSTRUCTION MATERIALS?)\b/.test(line) ? 'Construction Materials' : null
      if (!material) continue
      const amount = line.match(/(\d+(?:[.,]\d+)?)\s*(?:\/\s*(\d+(?:[.,]\d+)?))?\s*SCU\b/)
      if (!amount) continue
      const kind = /\bBUFFER\b/.test(line) ? 'buffer' : /\b(?:CARGO|HOLD)\b/.test(line) ? 'hold' : null
      if (!kind) continue
      const quantity = Number(amount[1].replace(',', '.'))
      const capacity = amount[2] === undefined ? undefined : Number(amount[2].replace(',', '.'))
      if (!Number.isFinite(quantity) || quantity < 0 || capacity !== undefined && (!Number.isFinite(capacity) || quantity > capacity)) return null
      const key = `${kind}:${material}`
      if (values[key] !== undefined && values[key] !== quantity) return null
      values[key] = quantity
      if (capacity !== undefined) values[`capacity:${key}`] = capacity
    }
    return Object.keys(values).some((key) => !key.startsWith('capacity:')) ? { target, identity: 'SALVAGE', values, live, text } : null
  }
  const identityLine = lines.find((line) => /^(?:TARGET|SHIP|CONTACT|SIGNATURE|ID)\s*[:=]\s*\S/.test(line))
  if (!identityLine) return null
  const identity = normalizedIdentity(identityLine.replace(/^[^:=]+[:=]\s*/, ''))
  if (identity.length < 2 || /^(?:UNKNOWN|SCANNING|NONE)$/.test(identity)) return null
  for (const line of lines) {
    const measurement = line.match(/^(DISTANCE|RANGE|EM|IR|CS|SPEED|HULL|CARGO)\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*(KM|M|SCU|%)?\s*$/)
    if (!measurement) continue
    let amount = Number(measurement[2].replace(',', '.'))
    if (!Number.isFinite(amount)) continue
    if (measurement[3] === 'KM') amount *= 1000
    const key = `${measurement[1]}${measurement[3] ? ` (${measurement[3] === 'KM' ? 'M' : measurement[3]})` : ''}`
    if (measurement[1] === 'CARGO' && measurement[3] === 'SCU') values[key] = amount
    else live[key] = amount
  }
  return { target, identity, values, live, text }
}

export function readingSignature(reading: OcrReading) {
  return JSON.stringify([reading.target, normalizedIdentity(reading.identity), Object.entries(reading.values).sort(([left], [right]) => left.localeCompare(right))])
}

export function agreeOcrSamples(samples: OcrSample[]) {
  if (samples.length !== 3 || samples.some((sample) => !sample.reading || sample.confidence < 80 || sample.warnings.length)) return null
  const readings = samples.map((sample) => sample.reading!)
  if (!readings.every((reading) => readingSignature(reading) === readingSignature(readings[0]))) return null
  return readings[2]
}