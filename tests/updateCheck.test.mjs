import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchLatestRelease, isNewerVersion } from '../src/updateCheck.ts'

test('compares semantic versions', () => {
  assert.equal(isNewerVersion('v1.0.5', '1.0.4'), true)
  assert.equal(isNewerVersion('1.1.0', '1.0.9'), true)
  assert.equal(isNewerVersion('2.0.0', '1.9.9'), true)
  assert.equal(isNewerVersion('v1.0.4', '1.0.4'), false)
  assert.equal(isNewerVersion('1.0.3', '1.0.4'), false)
  assert.equal(isNewerVersion('nightly', '1.0.4'), false)
})

test('reads the latest GitHub release and rejects unexpected links', async () => {
  const reply = (body, ok = true) => async () => ({ ok, json: async () => body })
  assert.deepEqual(await fetchLatestRelease(reply({ tag_name: 'v1.0.6', html_url: 'https://github.com/JonAmes/SCCommandHub/releases/tag/v1.0.6', name: 'v1.0.6' })), { version: '1.0.6', url: 'https://github.com/JonAmes/SCCommandHub/releases/tag/v1.0.6', name: 'v1.0.6' })
  assert.equal(await fetchLatestRelease(reply({ tag_name: 'v9.9.9', html_url: 'https://evil.example/releases/x' })), null)
  assert.equal(await fetchLatestRelease(reply({}, false)), null)
})
