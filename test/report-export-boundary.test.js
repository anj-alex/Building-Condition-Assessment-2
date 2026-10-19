const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')

const {
  createPreparedReportArtifacts,
  createReportExportCapabilities,
  findRelevantReportAiJob,
  fingerprintReportSnapshot,
} = require('../src/main/report-export')

test('report save capabilities are opaque, sender-bound, replaceable, and one-shot', () => {
  const ids = ['first', 'second']
  const capabilities = createReportExportCapabilities({ createId: () => ids.shift() })
  const firstWindow = {}
  const otherWindow = {}

  assert.equal(capabilities.issue(firstWindow, '/private/first.docx'), 'first')
  assert.equal(capabilities.consume(otherWindow, 'first'), null)
  assert.equal(capabilities.consume(firstWindow, 'wrong'), null)

  assert.equal(capabilities.issue(firstWindow, '/private/second.docx'), 'second')
  assert.equal(capabilities.consume(firstWindow, 'first'), null)
  assert.equal(capabilities.consume(firstWindow, 'second'), '/private/second.docx')
  assert.equal(capabilities.consume(firstWindow, 'second'), null)
})

test('prepared report artifacts are immutable, sender-bound, reusable, and latest-wins', () => {
  const ids = ['preview-1', 'preview-2']
  const artifacts = createPreparedReportArtifacts({ createId: () => ids.shift() })
  const owner = new EventEmitter()
  owner.webContents = new EventEmitter()
  const otherOwner = new EventEmitter()
  otherOwner.webContents = new EventEmitter()

  const firstId = artifacts.begin(owner)
  const source = Buffer.from('first DOCX')
  assert.equal(
    artifacts.commit(owner, firstId, { buffer: source, fingerprint: 'one' }),
    true,
  )
  source.fill(0)
  assert.equal(artifacts.resolve(owner, firstId).buffer.toString(), 'first DOCX')
  assert.equal(artifacts.resolve(owner, firstId).buffer.toString(), 'first DOCX')
  assert.equal(artifacts.resolve(otherOwner, firstId), null)

  const secondId = artifacts.begin(owner)
  assert.equal(artifacts.resolve(owner, firstId), null)
  assert.equal(
    artifacts.commit(owner, firstId, { buffer: Buffer.from('late') }),
    false,
    'an older asynchronous build cannot replace the newer slot',
  )
  assert.equal(
    artifacts.commit(owner, secondId, {
      buffer: Buffer.from('second DOCX'),
      fingerprint: 'two',
    }),
    true,
  )
  assert.equal(artifacts.resolve(owner, secondId).buffer.toString(), 'second DOCX')

  owner.webContents.emit('did-navigate')
  assert.equal(artifacts.resolve(owner, secondId), null, 'full navigation releases bytes')
})

test('report snapshot fingerprints are deterministic and data-sensitive', () => {
  const reports = [{ building: { id: 7, name: 'A' }, assets: [{ id: 8 }] }]
  assert.equal(
    fingerprintReportSnapshot(reports),
    fingerprintReportSnapshot(structuredClone(reports)),
  )
  const changed = structuredClone(reports)
  changed[0].assets[0].id = 9
  assert.notEqual(fingerprintReportSnapshot(reports), fingerprintReportSnapshot(changed))
})

test('report AI relevance uses building identity with image and asset fallbacks', () => {
  const reports = [
    {
      building: { id: 7 },
      buildingImages: [{ id: 70 }],
      assets: [{ id: 8, images: [{ id: 80 }] }],
    },
  ]

  assert.equal(
    findRelevantReportAiJob({ summaryJobs: [{ buildingId: 7 }] }, reports)?.buildingId,
    7,
  )
  assert.equal(
    findRelevantReportAiJob(
      { captionJobs: [{ kind: 'building', imageId: 70, buildingId: null }] },
      reports,
    )?.imageId,
    70,
  )
  assert.equal(
    findRelevantReportAiJob(
      { captionJobs: [{ kind: 'asset', imageId: 999, assetId: 8 }] },
      reports,
    )?.assetId,
    8,
  )
  assert.equal(
    findRelevantReportAiJob(
      { captionJobs: [{ kind: 'asset', imageId: 800, assetId: 81, buildingId: 17 }] },
      reports,
    ),
    null,
  )
})
