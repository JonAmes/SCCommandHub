import assert from 'node:assert/strict'
import test from 'node:test'
import { describeScreenSources, findGameSource, selectedScreenSource } from '../electron/screenCapture.cjs'

const monitor = { id: 'screen:0:0', name: 'Screen 1' }
const game = { id: 'window:123:0', name: 'Star Citizen' }

test('prefers only an unambiguous game window, not a monitor or browser title', () => {
  assert.equal(findGameSource([monitor, game]), game)
  for (const name of ['StarCitizen', 'Star Citizen - LIVE', 'Star Citizen - PTU', 'Star Citizen Alpha 4.3.0']) {
    assert.ok(findGameSource([{ ...game, name }]), name)
  }
  for (const name of ['Star Citizen Wiki - Chrome', 'SC Command Hub', 'Star Citizen - Firefox', 'Star Citizen Launcher']) {
    assert.equal(findGameSource([monitor, { ...game, name }]), null, name)
  }
  assert.equal(findGameSource([monitor, { ...monitor, name: 'Star Citizen' }]), null)
  assert.equal(findGameSource([game, { ...game, id: 'window:456:0' }]), null)
})

test('never falls back to a monitor when a source disappears or was not selected', () => {
  assert.equal(selectedScreenSource([monitor, game], game.id), game)
  assert.equal(selectedScreenSource([monitor, game], monitor.id), monitor)
  assert.equal(selectedScreenSource([monitor], game.id), null)
  assert.equal(selectedScreenSource([monitor, game], null), null)
})

test('identifies the actual primary display independently of screen order and excludes the app', () => {
  const primary = { id: 'screen:8:0', name: 'Screen 2', display_id: '42' }
  const ownWindow = { id: 'window:999:0', name: 'SC Command Hub' }
  const sources = describeScreenSources([{ ...monitor, display_id: '7' }, game, primary, ownWindow], 42, ownWindow.id)
  assert.deepEqual(sources.find((source) => source.isPrimary), { id: primary.id, name: primary.name, kind: 'screen', isPrimary: true, isGame: false })
  assert.equal(sources.find((source) => source.id === game.id).kind, 'window')
  assert.equal(sources.find((source) => source.isGame).id, game.id)
  assert.equal(sources.some((source) => source.id === ownWindow.id), false)
})

test('does not guess the primary display or game from missing or ambiguous metadata', () => {
  const sources = [{ ...monitor, display_id: '' }, { ...game, display_id: '42' }, { ...game, id: 'window:456:0' }]
  assert.equal(describeScreenSources(sources, 42).some((source) => source.isPrimary || source.isGame), false)
  assert.equal(describeScreenSources(sources, undefined).some((source) => source.isPrimary), false)
})