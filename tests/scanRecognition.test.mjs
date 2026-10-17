import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const manifest = JSON.parse(await readFile(new URL('../Examples/manifest.json', import.meta.url), 'utf8'))

async function loadFixture(page, file, preset = false) {
  if (preset) {
    const example = manifest.examples.find((entry) => entry.file === file)
    await page.evaluate(({ regions, width, height }) => {
      for (const [target, region] of Object.entries(regions)) {
        const key = target === 'scan' ? 'sc-command-hub.scan-reader-region-v1' : 'sc-command-hub.scan-reader-cargo-region-v1'
        if (region) localStorage.setItem(key, JSON.stringify({ x: region.x / width, y: region.y / height, width: region.width / width, height: region.height / height }))
        else localStorage.removeItem(key)
      }
    }, example)
  }
  await page.locator('.scan-reader-file input').setInputFiles(fileURLToPath(new URL(`../Examples/${file}`, import.meta.url)))
}

function measurements(actual, expected, prefix = '') {
  if (typeof expected !== 'object' || expected === null) return [{ path: prefix, correct: actual === expected }]
  return Object.entries(expected).flatMap(([key, value]) => {
    const path = `${prefix}${key}`
    if (Array.isArray(value)) {
      return [{ path: `${path}.length`, correct: actual?.[key]?.length === value.length }, ...value.flatMap((entry, index) => measurements(actual?.[key]?.[index], entry, `${path}[${index}].`))]
    }
    if (value && typeof value === 'object') return measurements(actual?.[key], value, `${path}.`)
    return [{ path, correct: actual?.[key] === value }]
  })
}

test('real screenshot OCR preserves good reads, improves fields, and exposes uncertainty', { timeout: 180_000 }, async (context) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
  let browser
  try {
    await server.listen()
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    browser = await chromium.launch()
    const page = await browser.newPage()
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      let asset
      if (url.hostname === 'cdn.jsdelivr.net' && /\/tesseract\.js@[^/]+\/dist\/worker\.min\.js$/.test(url.pathname)) asset = '../node_modules/tesseract.js/dist/worker.min.js'
      if (url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('/tesseract.js-core@')) asset = `../node_modules/tesseract.js-core/${url.pathname.split('/').pop()}`
      if (url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('/@tesseract.js-data/eng/') && url.pathname.endsWith('/eng.traineddata.gz')) asset = '../node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'
      if (asset) return route.fulfill({ body: await readFile(new URL(asset, import.meta.url)), contentType: asset.endsWith('.js') ? 'application/javascript' : 'application/octet-stream', headers: { 'Access-Control-Allow-Origin': '*' } })
      if (!route.request().url().startsWith(`${origin}/`)) return route.abort()
      if (route.request().url() === `${origin}/__scan-test__`) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>OCR fixtures</title>' })
      return route.continue()
    })
    await page.goto(`${origin}/__scan-test__`)
    const reports = await page.evaluate(async ({ examples, minerals }) => {
      const { captureScanRegion, createScanWorker, prepareScanImage, recognizeScanRegion } = await import('/src/scanRecognition.ts')
      const { parseScanText, parseCargoText } = await import('/src/scanOcr.ts')
      const worker = await createScanWorker({
        workerPath: `${location.origin}/node_modules/tesseract.js/dist/worker.min.js`,
        corePath: `${location.origin}/node_modules/tesseract.js-core`,
        langPath: `${location.origin}/node_modules/@tesseract.js-data/eng/4.0.0_best_int`,
        cacheMethod: 'none',
      })
      const reports = []
      try {
        for (const example of examples) {
          const image = new Image()
          image.src = `/Examples/${example.file}`
          await image.decode()
          if (image.naturalWidth !== example.width || image.naturalHeight !== example.height) throw new Error(`${example.file}: fixture dimensions changed`)
          for (const [target, region] of Object.entries(example.regions)) {
            if (!region) continue
            if (region.x < 0 || region.y < 0 || region.x + region.width > example.width || region.y + region.height > example.height) throw new Error(`${example.file}: crop is out of bounds`)
            const crop = captureScanRegion(image, example.width, example.height, { x: region.x / example.width, y: region.y / example.height, width: region.width / example.width, height: region.height / example.height })
            await worker.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:%()/- ' })
            const { data } = await worker.recognize(prepareScanImage(crop))
            const baseline = target === 'scan' ? parseScanText(data.text, minerals) : parseCargoText(data.text, minerals)
            const reading = await recognizeScanRegion(worker, crop, target, minerals)
            reports.push({ file: example.file, target, baseline, ...reading })
          }
        }
      } finally {
        await worker.terminate()
      }
      return reports
    }, manifest)
    let improvements = 0
    for (const report of reports) {
      const expected = manifest.examples.find((example) => example.file === report.file).expected[report.target]
      const actual = report.target === 'scan' ? report.parsed : report.cargo
      const baseline = measurements(report.baseline, expected)
      const revised = measurements(actual, expected)
      const regressions = revised.filter((entry, index) => !entry.correct && baseline[index].correct)
      const improved = revised.filter((entry, index) => entry.correct && !baseline[index].correct)
      improvements += improved.length
      context.diagnostic(`${report.file} ${report.target}: ${baseline.filter((entry) => entry.correct).length} -> ${revised.filter((entry) => entry.correct).length}/${revised.length} exact checks; ${report.passes} passes; ${report.elapsedMs}ms; ${report.warnings.length} warnings`)
      assert.deepEqual(regressions, [], `${report.file} ${report.target}: previously correct values regressed`)
      assert.ok(report.passes >= 1 && report.passes <= 7, 'Recognition retries must remain bounded')
      if (revised.some((entry) => !entry.correct)) assert.ok(report.warnings.length, `${report.file}: incorrect or missing values must not appear certain`)
      if (report.file === 'Example5.avif') assert.deepEqual(actual, expected, 'The legible older HUD must be read exactly, including raw-prefix mineral names')
      if (process.env.OCR_DEBUG) context.diagnostic(JSON.stringify(report, null, 2))
    }
    assert.ok(improvements >= 2, `Expected measurable numeric recovery; got ${improvements} improvements`)
    assert.equal(reports.length, manifest.examples.reduce((count, example) => count + Object.values(example.regions).filter(Boolean).length, 0))
    await context.test('discovers panels from full screenshots without preset coordinates', async () => {
      const detections = await page.evaluate(async files => {
        const { createScanWorker, discoverScanPanels, captureScanRegion, recognizeScanRegion, locateScanPanels } = await import('/src/scanRecognition.ts')
        const worker = await createScanWorker({ workerPath: `${location.origin}/node_modules/tesseract.js/dist/worker.min.js`, corePath: `${location.origin}/node_modules/tesseract.js-core`, langPath: `${location.origin}/node_modules/@tesseract.js-data/eng/4.0.0_best_int`, cacheMethod: 'none' })
        const output = []
        try {
          for (const file of files) {
            const image = new Image()
            image.src = `/Examples/${file}`
            await image.decode()
            const frame = document.createElement('canvas')
            frame.width = image.naturalWidth
            frame.height = image.naturalHeight
            frame.getContext('2d').drawImage(image, 0, 0)
            const detected = await discoverScanPanels(worker, frame)
            let scan
            if (detected.regions.scan) {
              const crop = captureScanRegion(frame, frame.width, frame.height, detected.regions.scan)
              scan = (await recognizeScanRegion(worker, crop, 'scan', ['Beryl (Raw)', 'Titanium (Ore)', 'Agricium (Ore)', 'Aslarite (Raw)', 'Tungsten (Ore)', 'Diamond (Raw)', 'Aluminum (Ore)', 'Quartz (Raw)'])).parsed
            }
            output.push({ file, regions: detected.regions, scan, warnings: detected.warnings })
          }
          const blank = document.createElement('canvas')
          blank.width = 640
          blank.height = 360
          blank.getContext('2d').fillRect(0, 0, 640, 360)
          output.push({ file: 'blank', ...(await discoverScanPanels(worker, blank)) })
          const header = { text: 'SCAN RESULTS', bbox: { x0: 100, y0: 100, x1: 200, y1: 110 } }
          output.push({ file: 'unsupported-heading', ...locateScanPanels([header], 640, 360) })
          output.push({ file: 'ambiguous', ...locateScanPanels([header, { ...header, bbox: { x0: 350, y0: 100, x1: 450, y1: 110 } }], 640, 360) })
        } finally { await worker.terminate() }
        return output
      }, manifest.examples.map((example) => example.file))
      for (const detection of detections) {
        context.diagnostic(`${detection.file}: discovered ${Object.entries(detection.regions).filter(([, region]) => region).map(([target]) => target).join(', ') || 'no panels'}`)
        for (const region of Object.values(detection.regions).filter(Boolean)) {
          assert.ok(region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0)
          assert.ok(region.x + region.width <= 1.00001 && region.y + region.height <= 1.00001)
        }
      }
      for (const file of ['Example2.avif', 'Example3.avif', 'Example5.avif']) {
        const detection = detections.find((entry) => entry.file === file)
        assert.ok(detection.regions.scan, `${file}: supported scan must be found without a preset`)
        assert.ok(detection.scan.composition.length >= 4, `${file}: detected crop must include the composition rows`)
      }
      for (const file of ['blank', 'unsupported-heading', 'ambiguous']) assert.deepEqual(detections.find((entry) => entry.file === file).regions, { scan: null, cargo: null })
      assert.equal(detections.find((entry) => entry.file === 'Example5.avif').regions.cargo, null, 'A clipped cargo heading is not a usable panel')
    })
    await context.test('captures one discovery frame followed by three distinct cropped frames', async () => {
      const result = await page.evaluate(async () => {
        const { createScanWorker, captureScreenBurst, waitForCaptureFrame } = await import('/src/scanRecognition.ts')
        const image = new Image()
        image.src = '/Examples/Example5.avif'
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const drawing = canvas.getContext('2d')
        let animation
        const draw = () => {
          drawing.drawImage(image, 0, 0)
          drawing.fillStyle = Math.floor(performance.now() / 100) % 2 ? 'black' : 'white'
          drawing.fillRect(0, 0, 4, 4)
          animation = requestAnimationFrame(draw)
        }
        draw()
        const stream = canvas.captureStream(10)
        const video = document.createElement('video')
        video.muted = true
        video.srcObject = stream
        document.body.append(video)
        const worker = await createScanWorker({ workerPath: `${location.origin}/node_modules/tesseract.js/dist/worker.min.js`, corePath: `${location.origin}/node_modules/tesseract.js-core`, langPath: `${location.origin}/node_modules/@tesseract.js-data/eng/4.0.0_best_int`, cacheMethod: 'none' })
        const progress = []
        let regions
        try {
          await video.play()
          const burst = await captureScreenBurst(worker, video, ['Tungsten (Ore)', 'Diamond (Raw)', 'Aluminum (Ore)', 'Beryl (Raw)', 'Titanium (Ore)', 'Quartz (Raw)'], { signal: new AbortController().signal, onProgress: (message) => progress.push(message), onRegions: (value) => { regions = value } })
          const cancelled = new AbortController()
          const pending = waitForCaptureFrame(video, cancelled.signal, 1e9)
          cancelled.abort()
          let cancellation
          try { await pending } catch (error) { cancellation = error.name }
          return { ...burst, progress, regions, cancellation }
        } finally {
          cancelAnimationFrame(animation)
          stream.getTracks().forEach((track) => track.stop())
          video.remove()
          await worker.terminate()
        }
      })
      assert.equal(result.frameTimes.length, 4)
      assert.equal(new Set(result.frameTimes).size, 4)
      assert.ok(result.frameTimes.every((time, index) => index === 0 || time > result.frameTimes[index - 1]))
      assert.equal(result.progress.filter((message) => message.startsWith('Capturing cropped snapshot')).length, 3)
      assert.equal(result.progress.filter((message) => message.startsWith('Reading cropped snapshot')).length, 3)
      assert.ok(result.regions.scan.width * result.regions.scan.height < 0.2, 'Only a small detected area is retained for readings')
      assert.equal(result.parsed.massKg, 8450)
      assert.equal(result.parsed.instabilityPercent, 0.74, 'Numeric retries must not drop a decimal point from an existing panel value')
      assert.equal(result.parsed.composition.length, 7)
      assert.equal(result.cancellation, 'AbortError')
    })
    await context.test('image source choices, crop alignment, and uploads preserve user settings', async () => {
      const savedRegion = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
      await page.evaluate((region) => {
        localStorage.setItem('sc-command-hub.setup-profile-v1', JSON.stringify({ skipped: true, completedAt: new Date().toISOString() }))
        localStorage.setItem('sc-command-hub.scan-reader-region-v1', JSON.stringify(region))
      }, savedRegion)
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.goto(origin)
      await page.getByRole('button', { name: 'Mining & refining', exact: true }).click()
      await page.getByRole('tab', { name: /Rock scan log/ }).click()
      const picker = page.getByLabel('IMAGE SOURCE')
      assert.deepEqual(await picker.locator('option').allTextContents(), ['Primary screen', 'Running apps', 'Star Citizen'])
      assert.equal(await picker.inputValue(), 'primary')
      assert.equal(await page.getByLabel('APP WINDOW').count(), 0)
      assert.equal(await page.getByLabel('EXAMPLE SCREENSHOT').count(), 0)
      assert.equal(await page.getByLabel('CAPTURE SOURCE').count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Take picture', exact: true }).count(), 0)
      for (const example of manifest.examples) {
        await loadFixture(page, example.file)
        await page.waitForFunction(() => {
          const image = document.querySelector('.scan-reader-preview img')
          return image?.complete && image.naturalWidth > 0
        })
        const dimensions = await page.locator('.scan-reader-preview img').evaluate((image) => [image.naturalWidth, image.naturalHeight])
        assert.deepEqual(dimensions, [example.width, example.height])
      }
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 1920, height: 600 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport)
        const bounds = await page.locator('.scan-reader-preview').evaluate((preview) => {
          const image = preview.querySelector('img')
          const imageBounds = image.getBoundingClientRect()
          const overlayBounds = preview.querySelector('.scan-reader-overlay').getBoundingClientRect()
          return { image: { x: imageBounds.x, y: imageBounds.y, width: imageBounds.width, height: imageBounds.height }, overlay: { x: overlayBounds.x, y: overlayBounds.y, width: overlayBounds.width, height: overlayBounds.height }, ratio: image.naturalWidth / image.naturalHeight }
        })
        for (const coordinate of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(bounds.image[coordinate] - bounds.overlay[coordinate]) < 1, `Overlay ${coordinate} must match actual image pixels`)
        assert.ok(Math.abs(bounds.image.width / bounds.image.height - bounds.ratio) < 0.01, 'Preview must not letterbox the selectable image')
        assert.ok(bounds.image.width <= viewport.width && bounds.image.height <= viewport.height * 0.7 + 1)
        await page.locator('.scan-reader-section').screenshot({ path: join(tmpdir(), `sc-reader-${viewport.width}.png`) })
      }
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('sc-command-hub.scan-reader-region-v1'))), savedRegion)
      await page.locator('.scan-reader-file input').setInputFiles(fileURLToPath(new URL('../Examples/Example6.png', import.meta.url)))
      assert.equal(await picker.inputValue(), 'primary')
      const restored = await page.locator('.scan-reader-region.scan').evaluate((region) => [region.style.left, region.style.top, region.style.width, region.style.height])
      assert.deepEqual(restored, ['10%', '20%', '30%', '40%'])
      assert.equal(await page.getByText('No rock scans recorded', { exact: true }).count(), 1, 'Loading screenshots must not save scans')
    })
    await context.test('reads require review, preserve edits, and ignore obsolete results', async () => {
      const read = page.getByRole('button', { name: 'Read now', exact: true })
      await loadFixture(page, 'Example5.avif', true)
      await read.click()
      const review = page.locator('.scan-reader-review').filter({ hasText: 'Review scan' })
      await review.waitFor({ timeout: 30_000 })
      const mass = review.getByLabel(/^MASS/)
      assert.equal(await mass.inputValue(), '8450')
      assert.equal(await page.getByText('No rock scans recorded', { exact: true }).count(), 1, 'OCR must not automatically persist a scan')
      await mass.fill('9999')
      await loadFixture(page, 'Example6.png', true)
      assert.equal(await mass.inputValue(), '9999', 'Source switches must preserve manual corrections')
      await read.click()
      assert.match(await page.locator('.scan-reader-status').textContent(), /Save or discard your edits/)
      await review.getByRole('button', { name: 'Discard', exact: true }).click()
      await read.click()
      await loadFixture(page, 'Example5.avif', true)
      await page.waitForFunction(() => !document.querySelector('.scan-reader-actions button').disabled)
      assert.equal(await page.locator('.scan-reader-review').count(), 0, 'A result from the previous source must not populate a new source')
      await page.locator('.scan-reader-file input').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not a PNG') })
      await page.getByText('This image could not be decoded. Try a PNG or JPEG screenshot.', { exact: true }).waitFor()
      assert.equal(await read.isDisabled(), true, 'An undecodable image must not be read')
    })
    await context.test('Capture screen respects primary, app, and game choices and only fills review', async () => {
      await page.setViewportSize({ width: 1440, height: 1000 })
      const saved = await page.evaluate(() => localStorage.getItem('sc-command-hub.scan-reader-region-v1'))
      await page.evaluate(async () => {
        const image = new Image()
        image.src = '/Examples/Example5.avif'
        await image.decode()
        window.captureTest = { gameAvailable: true, primaryAvailable: true, appAvailable: true, calls: 0, selected: '', frames: 0 }
        window.starCitizenBridge = {
          listScreenSources: async () => [
            { id: 'screen:0:0', name: 'Secondary monitor', kind: 'screen', isPrimary: false },
            ...(window.captureTest.primaryAvailable ? [{ id: 'screen:1:0', name: 'Primary monitor', kind: 'screen', isPrimary: true }] : []),
            ...(window.captureTest.appAvailable ? [{ id: 'window:456:0', name: 'Reference app', kind: 'window' }] : []),
            ...(window.captureTest.gameAvailable ? [{ id: 'window:123:0', name: 'Star Citizen', kind: 'window', isGame: true }] : []),
          ],
          selectScreenSource: async (source) => { window.captureTest.selected = source; return true },
        }
        navigator.mediaDevices.getDisplayMedia = async () => {
          window.captureTest.calls += 1
          const canvas = document.createElement('canvas')
          canvas.width = image.naturalWidth
          canvas.height = image.naturalHeight
          const drawing = canvas.getContext('2d')
          const stream = canvas.captureStream(10)
          const draw = () => {
            drawing.drawImage(image, 0, 0)
            drawing.fillStyle = window.captureTest.frames++ % 2 ? 'black' : 'white'
            drawing.fillRect(0, 0, 4, 4)
            if (stream.getVideoTracks()[0].readyState === 'live') requestAnimationFrame(draw)
          }
          draw()
          return stream
        }
      })
      const capture = page.getByRole('button', { name: 'Capture screen', exact: true })
      const picker = page.getByLabel('IMAGE SOURCE')
      await capture.click()
      const review = page.locator('.scan-reader-review').filter({ hasText: 'Review scan' })
      await review.waitFor({ timeout: 30_000 })
      assert.equal(await page.evaluate(() => window.captureTest.selected), 'screen:1:0', 'Primary screen must win over a running game and the first enumerated screen')
      assert.equal(await picker.isDisabled(), true, 'Source selection must not imply a different source while capture is live')
      assert.equal(await review.getByLabel(/^MASS/).inputValue(), '8450')
      assert.equal(await review.getByLabel('INSTABILITY', { exact: true }).inputValue(), '0.74')
      assert.equal(await page.getByText('No rock scans recorded', { exact: true }).count(), 1)
      assert.equal(await page.evaluate(() => localStorage.getItem('sc-command-hub.scan-reader-region-v1')), saved, 'Detected boxes must not overwrite saved areas')
      assert.match(await page.locator('.scan-reader-status').textContent(), /Three cropped captures compared/)
      await page.locator('.scan-reader-section').screenshot({ path: join(tmpdir(), 'sc-capture-review-desktop.png') })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.locator('.scan-reader-section').screenshot({ path: join(tmpdir(), 'sc-capture-review-mobile.png') })
      await review.getByLabel(/^MASS/).fill('9999')
      await page.getByRole('button', { name: 'Stop capture', exact: true }).click()
      await picker.selectOption('apps')
      const appPicker = page.getByLabel('APP WINDOW')
      await appPicker.focus()
      await page.waitForFunction(() => Array.from(document.querySelectorAll('select option')).some((option) => option.value === 'window:456:0'))
      assert.deepEqual(await appPicker.locator('option').allTextContents(), ['Choose an app window', 'Reference app', 'Star Citizen'])
      const callsBeforeSelection = await page.evaluate(() => window.captureTest.calls)
      await appPicker.selectOption('window:456:0')
      assert.equal(await page.evaluate(() => window.captureTest.calls), callsBeforeSelection, 'Choosing a source must not start capture')
      await capture.click()
      await page.getByText('Save or discard your edits before loading a new reading.', { exact: true }).waitFor({ timeout: 30_000 })
      assert.equal(await page.evaluate(() => window.captureTest.selected), 'window:456:0', 'An explicit app must not be overridden by Star Citizen')
      assert.equal(await review.getByLabel(/^MASS/).inputValue(), '9999', 'A capture burst must preserve existing manual edits')
      await page.getByRole('button', { name: 'Stop capture', exact: true }).click()
      await review.getByRole('button', { name: 'Discard', exact: true }).click()
      await page.evaluate(() => { window.captureTest.appAvailable = false })
      await capture.click()
      await page.getByText('Choose an available app window, then click Capture screen.', { exact: true }).waitFor()
      assert.equal(await appPicker.inputValue(), '', 'A closed app must clear the stale selection')
      assert.equal(await page.evaluate(() => window.captureTest.calls), callsBeforeSelection + 1, 'A closed app must not capture another source')
      await picker.selectOption('game')
      assert.equal(await appPicker.count(), 0, 'App window selector is only shown in Running apps mode')
      await page.evaluate(() => { window.captureTest.gameAvailable = false })
      await capture.click()
      await page.getByText('Star Citizen was not found unambiguously. Select another image source.', { exact: true }).waitFor()
      assert.equal(await page.evaluate(() => window.captureTest.calls), callsBeforeSelection + 1)
      await page.evaluate(() => { window.captureTest.gameAvailable = true })
      await capture.click()
      await review.waitFor({ timeout: 30_000 })
      assert.equal(await page.evaluate(() => window.captureTest.selected), 'window:123:0')
      await page.getByRole('button', { name: 'Stop capture', exact: true }).click()
      await review.getByRole('button', { name: 'Discard', exact: true }).click()
      await picker.selectOption('primary')
      await page.evaluate(() => { window.captureTest.primaryAvailable = false })
      await capture.click()
      await page.getByText('The primary screen is unavailable. Select another image source.', { exact: true }).waitFor()
      assert.equal(await page.evaluate(() => window.captureTest.calls), callsBeforeSelection + 2, 'Missing primary metadata must not use a secondary monitor')
      await page.evaluate(() => { window.captureTest.primaryAvailable = true })
      await capture.click()
      await page.getByRole('button', { name: 'Stop capture', exact: true }).click()
      await loadFixture(page, 'Example5.avif', true)
      await page.waitForFunction(() => !document.querySelector('.scan-reader-actions button').disabled)
      assert.equal(await page.locator('.scan-reader-review').count(), 0, 'Cancelled capture work must not populate an image source')
      await picker.selectOption('apps')
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport)
        const bounds = await appPicker.boundingBox()
        assert.ok(bounds.width > 0 && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width, 'Conditional app selector must fit the viewport')
        await page.locator('.scan-reader-section').screenshot({ path: join(tmpdir(), `sc-image-source-${viewport.width}.png`) })
      }
    })
    await context.test('browser capture keeps the native picker in the click activation path', async () => {
      await page.evaluate(() => {
        window.starCitizenBridge = undefined
        const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)
        navigator.mediaDevices.getDisplayMedia = async (...args) => {
          window.captureTest.browserPickerActive = navigator.userActivation.isActive
          return original(...args)
        }
      })
      const picker = page.getByLabel('IMAGE SOURCE')
      await picker.selectOption('game')
      await page.waitForFunction(() => document.querySelector('select option[value="apps"]').disabled)
      assert.equal(await page.getByLabel('APP WINDOW').count(), 0)
      assert.equal(await picker.locator('option[value="apps"]').evaluate((option) => option.disabled), true, 'Browser cannot enumerate arbitrary app windows')
      await page.getByRole('button', { name: 'Capture screen', exact: true }).click()
      await page.getByRole('button', { name: 'Stop capture', exact: true }).waitFor()
      assert.equal(await page.evaluate(() => window.captureTest.browserPickerActive), true, 'Browser screen picker must be invoked from the user gesture')
      await page.getByRole('button', { name: 'Stop capture', exact: true }).click()
    })
  } finally {
    await browser?.close()
    await server.close()
  }
})