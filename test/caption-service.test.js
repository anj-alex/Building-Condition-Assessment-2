const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const captionServiceSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'ai', 'caption-service.js'),
  'utf8',
)

function loadCaptionService() {
  const broadcasts = []
  const module = { exports: {} }
  const context = vm.createContext({
    Buffer,
    console,
    module,
    exports: module.exports,
    require(request) {
      if (request === 'node:fs') {
        return {
          existsSync: () => false,
        }
      }
      if (request === 'node:path') return path
      if (request === 'electron') {
        return {
          BrowserWindow: {
            getAllWindows: () => [
              {
                isDestroyed: () => false,
                webContents: {
                  send: (_channel, payload) => broadcasts.push(payload),
                },
              },
            ],
          },
          nativeImage: {},
        }
      }
      if (request === './secret-crypto') {
        return {
          decryptSecret: () => 'unused',
          isSecretPackage: () => false,
          getAppWrapSecret: () => 'test-wrap',
        }
      }
      if (request === './openrouter-config') {
        return {
          VISION_MODEL: 'test/vision-model',
          SUMMARY_MODEL: 'test/summary-model',
          SECRET_PATH: '/unused/openrouter-secret.json',
          IMAGE_MAX_EDGE: 1280,
          IMAGE_JPEG_QUALITY: 80,
          CAPTION_MAX_CONCURRENT: 3,
          CAPTION_FREE_MIN_INTERVAL_MS: 0,
          SUMMARY_MAX_CONCURRENT: 3,
          SUMMARY_FREE_MIN_INTERVAL_MS: 0,
        }
      }
      if (request === './openrouter-client') {
        return {
          captionImageWithOpenRouter: async () => 'Generated caption',
          completeTextWithOpenRouter: async () => 'Generated summary',
          fetchOpenRouterKeyUsage: async () => ({}),
          formatOpenRouterCredits: () => '',
          formatOpenRouterKeyLimitRemaining: () => '',
          buildAssetCaptionPrompt: () => '',
          buildBuildingCaptionPrompt: () => '',
          buildExecutiveSummaryPrompt: () => ({
            system: 'sys',
            prompt: 'user',
            sectionTitle: 'Test',
          }),
          isExecutiveSummaryField: (field) => field === 'accessibility',
        }
      }
      throw new Error(`Unexpected require: ${request}`)
    },
  })
  new vm.Script(captionServiceSource, {
    filename: 'src/ai/caption-service.js',
  }).runInContext(context)
  vm.runInContext("sessionApiKey = 'test-key'", context)
  module.exports.configureCaptionPersistence({
    updateImageCaption() {},
    getImageRow: () => ({ caption: 'Existing caption' }),
  })
  return { broadcasts, service: module.exports }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function loadRaceHarness({ captionImpl, summaryImpl } = {}) {
  const broadcasts = []
  const captionWrites = []
  const summaryWrites = []
  const imageRow = { caption: null, hidden: 0 }
  const summaryState = { exists: true, value: null }
  const module = { exports: {} }
  const context = vm.createContext({
    Buffer,
    console,
    module,
    exports: module.exports,
    setTimeout,
    clearTimeout,
    require(request) {
      if (request === 'node:fs') return { existsSync: () => true }
      if (request === 'node:path') return path
      if (request === 'electron') {
        return {
          BrowserWindow: {
            getAllWindows: () => [
              {
                isDestroyed: () => false,
                webContents: {
                  send: (channel, payload) => broadcasts.push({ channel, ...payload }),
                },
              },
            ],
          },
          nativeImage: {
            createFromPath: () => {
              const image = {
                isEmpty: () => false,
                getSize: () => ({ width: 64, height: 64 }),
                resize: () => image,
                toJPEG: () => Buffer.from('jpeg'),
              }
              return image
            },
          },
        }
      }
      if (request === './secret-crypto') {
        return {
          decryptSecret: () => 'unused',
          isSecretPackage: () => false,
          getAppWrapSecret: () => 'test-wrap',
        }
      }
      if (request === './openrouter-config') {
        return {
          VISION_MODEL: 'test/vision-model',
          SUMMARY_MODEL: 'test/summary-model',
          SECRET_PATH: '/unused/openrouter-secret.json',
          IMAGE_MAX_EDGE: 1280,
          IMAGE_JPEG_QUALITY: 80,
          CAPTION_MAX_CONCURRENT: 3,
          CAPTION_FREE_MIN_INTERVAL_MS: 0,
          SUMMARY_MAX_CONCURRENT: 3,
          SUMMARY_FREE_MIN_INTERVAL_MS: 0,
        }
      }
      if (request === './openrouter-client') {
        return {
          captionImageWithOpenRouter: captionImpl ?? (async () => 'Generated caption'),
          completeTextWithOpenRouter: summaryImpl ?? (async () => 'Generated summary'),
          fetchOpenRouterKeyUsage: async () => ({}),
          formatOpenRouterCredits: () => '',
          formatOpenRouterKeyLimitRemaining: () => '',
          buildAssetCaptionPrompt: () => '',
          buildBuildingCaptionPrompt: () => '',
          buildExecutiveSummaryPrompt: () => ({ system: 'sys', prompt: 'user' }),
          isExecutiveSummaryField: (field) => field === 'accessibility',
        }
      }
      throw new Error(`Unexpected require: ${request}`)
    },
  })
  new vm.Script(captionServiceSource, {
    filename: 'src/ai/caption-service.js',
  }).runInContext(context)
  vm.runInContext("sessionApiKey = 'test-key'", context)
  module.exports.configureCaptionPersistence({
    updateImageCaption: (_kind, _imageId, caption) => {
      captionWrites.push(caption)
      imageRow.caption = caption
    },
    getImageRow: () => ({ ...imageRow }),
    updateExecutiveSummaryField: (_buildingId, _field, text) => {
      summaryWrites.push(text)
      summaryState.value = text
    },
    getExecutiveSummaryState: () => ({ ...summaryState }),
  })
  return {
    broadcasts,
    captionWrites,
    summaryWrites,
    imageRow,
    summaryState,
    service: module.exports,
  }
}

test('caption service exposes generating jobs and broadcasts a terminal state', async () => {
  const { broadcasts, service } = loadCaptionService()
  const job = {
    kind: 'asset',
    imageId: 42,
    assetId: 7,
    filePath: '/unused/photo.jpg',
  }

  const result = service.enqueueCaptionJobs([job])
  const activeStatus = service.getAiStatus()

  assert.equal(result.queued, 1)
  assert.equal(activeStatus.captionJobs.length, 1)
  assert.equal(activeStatus.captionJobs[0].imageId, 42)
  assert.equal(activeStatus.captionJobs[0].state, 'generating')
  assert.equal(broadcasts[0].state, 'generating')

  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(service.getAiStatus().captionJobs.length, 0)
  assert.equal(broadcasts.length, 2)
  assert.equal(broadcasts[1].state, 'finished')
  assert.equal(broadcasts[1].ok, true)
  assert.equal(broadcasts[1].skipped, true)
})

test('caption service ignores a duplicate job while the image is generating', async () => {
  const { broadcasts, service } = loadCaptionService()
  const job = {
    kind: 'asset',
    imageId: 42,
    assetId: 7,
    filePath: '/unused/photo.jpg',
  }

  const result = service.enqueueCaptionJobs([job, { ...job }])

  assert.equal(result.queued, 1)
  assert.equal(result.alreadyGenerating, 1)
  assert.equal(broadcasts.filter((payload) => payload.state === 'generating').length, 1)

  await new Promise((resolve) => setImmediate(resolve))
})

test('caption service runs at most CAPTION_MAX_CONCURRENT jobs at once', async () => {
  const broadcasts = []
  const module = { exports: {} }
  let resolveSlow
  const slowPromise = new Promise((resolve) => {
    resolveSlow = resolve
  })
  let inFlight = 0
  let peakInFlight = 0
  const captionServiceSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'ai', 'caption-service.js'),
    'utf8',
  )
  const context = vm.createContext({
    Buffer,
    console,
    module,
    exports: module.exports,
    setTimeout,
    clearTimeout,
    require(request) {
      if (request === 'node:fs') {
        return { existsSync: () => true }
      }
      if (request === 'node:path') return path
      if (request === 'electron') {
        return {
          BrowserWindow: {
            getAllWindows: () => [
              {
                isDestroyed: () => false,
                webContents: {
                  send: (_channel, payload) => broadcasts.push(payload),
                },
              },
            ],
          },
          nativeImage: {
            createFromPath: () => {
              const image = {
                isEmpty: () => false,
                getSize: () => ({ width: 64, height: 64 }),
                resize() {
                  return image
                },
                toJPEG: () => Buffer.from('fake-jpeg'),
              }
              return image
            },
          },
        }
      }
      if (request === './secret-crypto') {
        return {
          decryptSecret: () => 'unused',
          isSecretPackage: () => false,
          getAppWrapSecret: () => 'test-wrap',
        }
      }
      if (request === './openrouter-config') {
        return {
          VISION_MODEL: 'test/vision-model',
          SUMMARY_MODEL: 'test/summary-model',
          SECRET_PATH: '/unused/openrouter-secret.json',
          IMAGE_MAX_EDGE: 1280,
          IMAGE_JPEG_QUALITY: 80,
          CAPTION_MAX_CONCURRENT: 2,
          CAPTION_FREE_MIN_INTERVAL_MS: 0,
          SUMMARY_MAX_CONCURRENT: 2,
          SUMMARY_FREE_MIN_INTERVAL_MS: 0,
        }
      }
      if (request === './openrouter-client') {
        return {
          captionImageWithOpenRouter: async () => {
            inFlight += 1
            peakInFlight = Math.max(peakInFlight, inFlight)
            await slowPromise
            inFlight -= 1
            return 'Generated caption'
          },
          completeTextWithOpenRouter: async () => 'Generated summary',
          fetchOpenRouterKeyUsage: async () => ({}),
          formatOpenRouterCredits: () => '',
          formatOpenRouterKeyLimitRemaining: () => '',
          buildAssetCaptionPrompt: () => '',
          buildBuildingCaptionPrompt: () => '',
          buildExecutiveSummaryPrompt: () => ({
            system: 'sys',
            prompt: 'user',
            sectionTitle: 'Test',
          }),
          isExecutiveSummaryField: () => false,
        }
      }
      throw new Error(`Unexpected require: ${request}`)
    },
  })
  new vm.Script(captionServiceSource, {
    filename: 'src/ai/caption-service.js',
  }).runInContext(context)
  vm.runInContext("sessionApiKey = 'test-key'", context)
  module.exports.configureCaptionPersistence({
    updateImageCaption() {},
    getImageRow: () => ({ caption: null }),
  })

  const jobs = [1, 2, 3, 4].map((imageId) => ({
    kind: 'asset',
    imageId,
    assetId: imageId,
    filePath: `/unused/photo-${imageId}.jpg`,
  }))
  const result = module.exports.enqueueCaptionJobs(jobs)
  assert.equal(result.queued, 4)

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(inFlight, 2)
  assert.equal(peakInFlight, 2)

  resolveSlow()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(module.exports.getAiStatus().captionJobs.length, 0)
  assert.ok(peakInFlight <= 2)
})

test('a manual caption edit wins over an in-flight model response', async () => {
  const response = deferred()
  const harness = loadRaceHarness({ captionImpl: () => response.promise })
  harness.service.enqueueCaptionJobs([
    { kind: 'asset', imageId: 8, filePath: '/photo.jpg' },
  ])
  await new Promise((resolve) => setImmediate(resolve))

  harness.imageRow.caption = 'Assessor caption'
  response.resolve('Stale generated caption')
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(harness.captionWrites, [])
  assert.equal(harness.imageRow.caption, 'Assessor caption')
  const finished = harness.broadcasts.find(
    (payload) => payload.state === 'finished' && payload.imageId === 8,
  )
  assert.equal(finished.stale, true)
  assert.equal(finished.skipped, true)
})

test('a manual summary edit wins over an in-flight model response', async () => {
  const response = deferred()
  const harness = loadRaceHarness({ summaryImpl: () => response.promise })
  harness.service.enqueueSummaryJobs([
    { buildingId: 4, field: 'accessibility' },
  ])
  await new Promise((resolve) => setImmediate(resolve))

  harness.summaryState.value = 'Assessor summary'
  response.resolve('Stale generated summary')
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(harness.summaryWrites, [])
  assert.equal(harness.summaryState.value, 'Assessor summary')
  const finished = harness.broadcasts.find(
    (payload) => payload.state === 'finished' && payload.buildingId === 4,
  )
  assert.equal(finished.stale, true)
  assert.equal(finished.skipped, true)
})

test('workspace invalidation suppresses old results without deleting a new same-id job', async () => {
  const responses = [deferred(), deferred()]
  let call = 0
  const harness = loadRaceHarness({
    captionImpl: () => responses[call++].promise,
  })
  const job = { kind: 'asset', imageId: 11, filePath: '/photo.jpg', force: true }

  harness.service.enqueueCaptionJobs([job])
  await new Promise((resolve) => setImmediate(resolve))
  const canceled = harness.service.invalidateWorkspace()
  assert.equal(canceled.captionJobs, 1)
  harness.service.enqueueCaptionJobs([job])
  await new Promise((resolve) => setImmediate(resolve))

  responses[0].resolve('Old workspace caption')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.service.getAiStatus().captionJobs.length, 1)
  assert.deepEqual(harness.captionWrites, [])

  responses[1].resolve('New workspace caption')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(harness.captionWrites, ['New workspace caption'])
  assert.equal(harness.service.getAiStatus().captionJobs.length, 0)
})

test('a replacement discovered by the final caption read cannot write to a reused id', async () => {
  const response = deferred()
  const harness = loadRaceHarness({ captionImpl: () => response.promise })
  let reads = 0
  harness.service.configureCaptionPersistence({
    getImageRow: () => {
      reads += 1
      if (reads === 2) harness.service.invalidateWorkspace('Database replaced')
      return { ...harness.imageRow }
    },
    updateImageCaption: (_kind, _imageId, caption) => {
      harness.captionWrites.push(caption)
    },
  })

  harness.service.enqueueCaptionJobs([
    { kind: 'asset', imageId: 11, filePath: '/photo.jpg', force: true },
  ])
  await new Promise((resolve) => setImmediate(resolve))
  response.resolve('Old workspace caption')
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(reads, 2)
  assert.deepEqual(harness.captionWrites, [])
})

test('a replacement discovered by the final summary read cannot write to a reused id', async () => {
  const response = deferred()
  const harness = loadRaceHarness({ summaryImpl: () => response.promise })
  let reads = 0
  harness.service.configureCaptionPersistence({
    getExecutiveSummaryState: () => {
      reads += 1
      if (reads === 2) harness.service.invalidateWorkspace('Database replaced')
      return { ...harness.summaryState }
    },
    updateExecutiveSummaryField: (_buildingId, _field, text) => {
      harness.summaryWrites.push(text)
    },
  })

  harness.service.enqueueSummaryJobs([
    { buildingId: 4, field: 'accessibility', force: true },
  ])
  await new Promise((resolve) => setImmediate(resolve))
  response.resolve('Old workspace summary')
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(reads, 2)
  assert.deepEqual(harness.summaryWrites, [])
})
