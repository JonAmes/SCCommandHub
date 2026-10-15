const systemSegment = /^(rr|stanton\d*|pyro\d*|nyx\d*|loc|location)$/i

function compact(value: string) {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]/g, '')
}

// Turns a Game.log location code such as RR_ARC_L1 or Stanton1_Lorville into match keys like "arcl1" / "lorville".
export function locationKeys(locationCode: string) {
  const segments = locationCode.split(/[_\s-]+/).filter((segment) => segment && !systemSegment.test(segment))
  return [...new Set([segments.join(''), segments.slice(0, 2).join('')].map(compact).filter((key) => key.length >= 4))]
}

export function formatLocationCode(locationCode: string) {
  const segments = locationCode.split('_').filter((segment) => segment && !systemSegment.test(segment))
  return segments.length ? segments.join(' ').replace(/\b(ARC|CRU|HUR|MIC) (L\d)\b/i, '$1-$2') : locationCode
}

export function isAtLocation(locationCode: string | null | undefined, placeNames: string[]) {
  if (!locationCode) return false
  const keys = locationKeys(locationCode)
  const places = placeNames.map(compact).filter(Boolean)
  return keys.some((key) => places.some((place) => place.includes(key)))
}
