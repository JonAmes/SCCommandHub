import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from 'vite'

test('expanded OCR controller and operations workflows', { timeout: 180_000 }, async (context) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  let browser
  try {
    await server.listen()
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      let asset
      if (url.hostname === 'cdn.jsdelivr.net' && /\/tesseract\.js@[^/]+\/dist\/worker\.min\.js$/.test(url.pathname)) asset = '../node_modules/tesseract.js/dist/worker.min.js'
      if (url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('/tesseract.js-core@')) asset = `../node_modules/tesseract.js-core/${url.pathname.split('/').pop()}`
      if (url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('/@tesseract.js-data/eng/') && url.pathname.endsWith('/eng.traineddata.gz')) asset = '../node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'
      if (asset) return route.fulfill({ body: await readFile(new URL(asset, import.meta.url)), contentType: asset.endsWith('.js') ? 'application/javascript' : 'application/octet-stream', headers: { 'Access-Control-Allow-Origin': '*' } })
      if (!route.request().url().startsWith(`${origin}/`)) return route.abort()
      return route.continue()
    })
    await page.addInitScript(() => {
      if (!localStorage.getItem('operations-test-initialized')) {
        localStorage.setItem('operations-test-initialized', 'true')
        localStorage.setItem('sc-command-hub.setup-profile-v1', JSON.stringify({ skipped: true, completedAt: new Date().toISOString() }))
        localStorage.setItem('sc-command-hub.hangar-v1', JSON.stringify({ ships: [{ id: 'vulture', vehicleId: 'v', name: 'Vulture', manufacturer: 'Drake', cargoCapacity: 12, photoUrl: '', addedAt: new Date().toISOString() }, { id: 'prospector', vehicleId: 'p', name: 'Prospector', manufacturer: 'MISC', cargoCapacity: 32, photoUrl: '', addedAt: new Date().toISOString() }], activeShipId: 'prospector', cargoByShip: {} }))
      }
    })
    await page.goto(origin)

    await context.test('controller rejects 2/3 agreement and supports cancellation', async () => {
      const result = await page.evaluate(async () => {
        const { captureOcrBurst, captureOcrImage, captureDelay } = await import('/src/ocrCapture.ts')
        const canvas = document.createElement('canvas')
        canvas.width = 800
        canvas.height = 400
        const drawing = canvas.getContext('2d')
        let animation
        const draw = () => { drawing.fillStyle = performance.now() % 2 ? 'white' : '#eee'; drawing.fillRect(0, 0, 800, 400); animation = requestAnimationFrame(draw) }
        draw()
        const stream = canvas.captureStream(10)
        const video = document.createElement('video')
        video.muted = true
        video.srcObject = stream
        document.body.append(video)
        await video.play()
        let parameters = {}
        let cropReads = 0
        let mismatch = false
        const worker = {
          setParameters: async (value) => { parameters = value },
          recognize: async (image) => {
            const single = parameters.tessedit_pageseg_mode === '6'
            if (single) cropReads += 1
            const name = single && mismatch && cropReads === 3 ? 'RECLAIMER' : 'VULTURE'
            const words = [{ text: 'VULTURE', bbox: { x0: image.width * 0.1, y0: image.height * 0.3, x1: image.width * 0.4, y1: image.height * 0.3 + 20 } }, { text: 'STORE', bbox: { x0: image.width * 0.7, y0: image.height * 0.3, x1: image.width * 0.9, y1: image.height * 0.3 + 20 } }]
            return { data: { text: `${name} STORE`, confidence: 95, blocks: [{ paragraphs: [{ lines: [{ words }] }] }] } }
          },
        }
        const progress = []
        try {
          const success = await captureOcrBurst(worker, video, 'shipTerminal', new AbortController().signal, (message) => progress.push(message))
          cropReads = 0
          mismatch = true
          const failure = await captureOcrBurst(worker, video, 'shipTerminal', new AbortController().signal, () => {})
          const preview = await captureOcrImage(worker, canvas, 'shipTerminal', new AbortController().signal)
          const controller = new AbortController()
          const wait = captureDelay(controller.signal, 60_000)
          controller.abort()
          let cancellation
          try { await wait } catch (error) { cancellation = error.name }
          return { success, failure, preview, progress, cancellation }
        } finally { cancelAnimationFrame(animation); stream.getTracks().forEach((track) => track.stop()); video.remove() }
      })
      assert.equal(result.success.verified, true)
      assert.equal(result.success.crops.length, 3)
      assert.equal(result.success.readings[0].identity, 'VULTURE')
      assert.equal(result.failure.verified, false)
      assert.equal(result.preview.verified, false)
      assert.equal(result.progress.filter((message) => message.startsWith('Capturing discovered')).length, 3)
      assert.equal(result.cancellation, 'AbortError')
    })

    await context.test('sessions, corrections, reconciliation and finances persist without bank mutations', async () => {
      await page.getByRole('button', { name: 'Salvaging', exact: true }).click()
      await page.getByLabel('Salvage target', { exact: true }).fill('Test wreck')
      await page.getByLabel('Location', { exact: true }).fill('Yela')
      await page.getByRole('button', { name: 'Start session', exact: true }).click()
      await page.getByLabel('Manual quantity (SCU)').fill('4')
      await page.getByRole('combobox', { name: /^Store/ }).selectOption('hold')
      await page.getByRole('button', { name: 'Save correction', exact: true }).click()
      const reconcile = page.locator('.operations-warning').filter({ hasText: 'Recycled Material Composite' })
      await reconcile.getByLabel('Additional collected (SCU)').fill('3')
      await reconcile.getByLabel('Reconciliation note').fill('Manual recovered material')
      await reconcile.getByRole('button', { name: 'Confirm reconciliation' }).click()
      const finance = page.locator('.data-section').filter({ has: page.getByRole('heading', { name: 'Sales & expenses', exact: true }) })
      await finance.getByRole('combobox', { name: /^Type/ }).selectOption('sale')
      await finance.getByLabel('Amount (aUEC)').fill('100')
      await finance.getByLabel('Note', { exact: true }).fill('Material sale')
      await finance.getByRole('button', { name: 'Save financial record' }).click()
      await finance.getByRole('combobox', { name: /^Type/ }).selectOption('expense')
      await finance.getByLabel('Amount (aUEC)').fill('20')
      await finance.getByLabel('Note', { exact: true }).fill('Fuel')
      await finance.getByRole('button', { name: 'Save financial record' }).click()
      await finance.getByText('NET 80 aUEC', { exact: true }).waitFor()
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('sc-command-hub.salvaging-ops-v1')))
      assert.equal(saved.sessions[0].collected['Recycled Material Composite'], 3)
      assert.equal(saved.sessions[0].money.length, 2)
      assert.equal(await page.evaluate(() => localStorage.getItem('sc-command-hub.finance-v1')), null)
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport)
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page overflow')
        await page.screenshot({ path: join(tmpdir(), `sc-salvage-${viewport.width}.png`), fullPage: true })
      }
      await page.reload()
      await page.getByRole('button', { name: 'Salvaging', exact: true }).click()
      await page.getByText('NET 80 aUEC', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'End session', exact: true }).click()
      assert.equal(await page.getByRole('button', { name: 'Save correction', exact: true }).count(), 0)
    })

    await context.test('session removal confirms, preserves other sessions, and persists after reload', async () => {
      await page.getByLabel('Salvage target', { exact: true }).fill('Second wreck')
      await page.getByRole('button', { name: 'Start session', exact: true }).click()
      const readSessions = () => page.evaluate(() => JSON.parse(localStorage.getItem('sc-command-hub.salvaging-ops-v1')).sessions)
      const before = await readSessions()
      assert.equal(before.length, 2)
      const protectedState = await page.evaluate(() => [localStorage.getItem('sc-command-hub.hangar-v1'), localStorage.getItem('sc-command-hub.finance-v1')])
      const remove = page.getByRole('button', { name: 'Remove session', exact: true })
      page.once('dialog', (dialog) => dialog.dismiss())
      await remove.click()
      assert.deepEqual(await readSessions(), before, 'Cancelling must preserve all session records')
      page.once('dialog', (dialog) => dialog.accept())
      await remove.click()
      assert.deepEqual(await readSessions(), [before[1]], 'Removing an active session must preserve the ended session')
      assert.equal(await page.getByRole('button', { name: 'Start session', exact: true }).isEnabled(), true)
      page.once('dialog', (dialog) => dialog.accept())
      await remove.click()
      assert.deepEqual(await readSessions(), [])
      assert.equal(await remove.count(), 0)
      assert.deepEqual(await page.evaluate(() => [localStorage.getItem('sc-command-hub.hangar-v1'), localStorage.getItem('sc-command-hub.finance-v1')]), protectedState)
      await page.reload()
      await page.getByRole('button', { name: 'Salvaging', exact: true }).click()
      assert.equal(await remove.count(), 0)
      assert.deepEqual(await readSessions(), [])
    })

    await context.test('scanner manual records persist separately and remain marked manual', async () => {
      await page.getByRole('button', { name: 'Scanner', exact: true }).click()
      await page.getByRole('tab', { name: 'Contacts', exact: true }).click()
      await page.getByLabel('Manual target / contact').fill('Contact 17')
      await page.getByRole('button', { name: 'Save manual observation' }).click()
      await page.getByRole('cell', { name: 'CONTACT 17', exact: true }).waitFor()
      assert.equal(await page.getByRole('cell', { name: 'Manual', exact: true }).count(), 1)
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('sc-command-hub.scanner-ops-v1')))
      assert.equal(saved.observations[0].target, 'contacts')
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport)
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
        await page.screenshot({ path: join(tmpdir(), `sc-scanner-${viewport.width}.png`), fullPage: true })
      }
    })

    await context.test('live terminal recognition proposes but never silently changes active ship', async () => {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.getByRole('button', { name: /^Personal hangar/ }).click()
      await page.getByRole('button', { name: 'Read ship terminal', exact: true }).click()
      await page.evaluate(() => {
        navigator.mediaDevices.getDisplayMedia = async () => {
          const canvas = document.createElement('canvas')
          canvas.width = 1000
          canvas.height = 400
          const context = canvas.getContext('2d')
          const stream = canvas.captureStream(10)
          let frame = 0
          const draw = () => {
            context.fillStyle = '#000'
            context.fillRect(0, 0, 1000, 400)
            context.fillStyle = '#fff'
            context.font = 'bold 40px sans-serif'
            context.fillText('VULTURE', 50, 100)
            context.fillText('STORE', 750, 100)
            context.fillText('PROSPECTOR', 50, 200)
            context.fillText('CLAIM', 750, 200)
            context.fillStyle = frame++ % 2 ? 'white' : 'black'
            context.fillRect(0, 0, 3, 3)
            if (stream.getVideoTracks()[0].readyState === 'live') requestAnimationFrame(draw)
          }
          draw()
          return stream
        }
      })
      await page.getByRole('button', { name: 'Capture screen', exact: true }).click()
      const confirm = page.getByRole('button', { name: 'Set Vulture active', exact: true })
      await confirm.waitFor({ timeout: 40_000 })
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sc-command-hub.hangar-v1')).activeShipId), 'prospector')
      assert.equal(await page.locator('.operations-crops img').count(), 3)
      await page.screenshot({ path: join(tmpdir(), 'sc-terminal-confirmation.png'), fullPage: true })
      await confirm.click()
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sc-command-hub.hangar-v1')).activeShipId), 'vulture')
    })
    assert.deepEqual(errors, [])
  } finally { await browser?.close(); await server.close() }
})