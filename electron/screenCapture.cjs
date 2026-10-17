function findGameSource(sources) {
  const candidates = sources.filter((source) => source.id.startsWith('window:') && /^star\s*citizen(?:\s*[-:|]?\s*(?:LIVE|PTU|EPTU|TECH[- ]?PREVIEW|(?:ALPHA\s*)?v?\d[\w. -]*))?$/i.test(source.name.trim()))
  return candidates.length === 1 ? candidates[0] : null
}

function selectedScreenSource(sources, sourceId) {
  return typeof sourceId === 'string' ? sources.find((source) => source.id === sourceId) ?? null : null
}

function describeScreenSources(sources, primaryDisplayId, excludedId) {
  const selectable = sources.filter((source) => source.id !== excludedId)
  const game = findGameSource(selectable)
  const primaryId = primaryDisplayId == null ? '' : String(primaryDisplayId)
  return selectable.map((source) => ({
    id: source.id,
    name: source.name,
    kind: source.id.startsWith('screen:') ? 'screen' : 'window',
    isPrimary: source.id.startsWith('screen:') && primaryId !== '' && source.display_id === primaryId,
    isGame: source.id === game?.id,
  }))
}

module.exports = { findGameSource, selectedScreenSource, describeScreenSources }