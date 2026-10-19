const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

// The behavioural tests in caption-service.test.js run the source in a vm with
// injected dependencies so they can control config constants and async timing;
// that copy is not the instrumented module. This file requires the real module
// and exercises only its offline surface — the paths that never reach the
// network or load a live key — so the shipped code is actually measured.
//
// Must load before the module (which requires electron).
require('./helpers/electron-stub')
const captionService = require('../src/ai/caption-service')

test('getAiStatus reports the shipped models and a locked, idle session', () => {
  const status = captionService.getAiStatus()
  // The dev repo ships an encrypted secret package, so AI reads as configured,
  // but no key is decrypted into memory until ensureSessionKey runs.
  assert.equal(status.configured, true)
  assert.equal(status.unlocked, false)
  assert.equal(typeof status.visionModel, 'string')
  assert.equal(typeof status.summaryModel, 'string')
  assert.deepEqual(status.captionJobs, [])
  assert.deepEqual(status.summaryJobs, [])
})

test('usage and job queues are inert while the session is locked', async () => {
  const usage = await captionService.getOpenRouterUsage()
  assert.equal(usage.ok, false)
  assert.equal(usage.unlocked, false)
  assert.ok(usage.error)

  // With no session key, enqueue is a no-op that never touches OpenRouter.
  const caption = captionService.enqueueCaptionJobs([
    { kind: 'asset', imageId: 1, assetId: 1, filePath: '/nope.jpg' },
  ])
  assert.equal(caption.queued, 0)
  assert.equal(caption.skipped, true)

  const summary = captionService.enqueueSummaryJobs([
    { buildingId: 1, field: 'plumbing' },
  ])
  assert.equal(summary.queued, 0)
  assert.equal(summary.skipped, true)

  // The synchronous summary generator refuses up front when locked.
  const section = await captionService.generateExecutiveSummarySection({
    field: 'plumbing',
    building: {},
  })
  assert.equal(section.ok, false)
  assert.equal(section.error, captionService.AI_KEY_UNAVAILABLE)

  assert.deepEqual(captionService.getAiStatus().captionJobs, [])
})

test('persistence hooks can be wired without a live session', () => {
  // Exercises the injection seam the main process uses at whenReady time.
  assert.doesNotThrow(() =>
    captionService.configureCaptionPersistence({
      updateImageCaption() {},
      getImageRow: () => ({ caption: null }),
      updateExecutiveSummaryField() {},
      getExecutiveSummaryField: () => null,
    }),
  )
})

test('fileToVisionDataUrl falls back to raw bytes when the image will not decode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cara-caption-boot-'))
  const file = path.join(dir, 'photo.png')
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  try {
    // nativeImage in the stub reports isEmpty, so this exercises the fallback.
    const url = captionService.fileToVisionDataUrl(file)
    assert.match(url, /^data:image\/png;base64,/)
    assert.throws(() => captionService.fileToVisionDataUrl('/does/not/exist.jpg'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
