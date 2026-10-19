const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  registerIpcHandlers,
  configureCaptionPersistence,
} = require('../src/main/ipc-handlers')

const SRC = path.join(__dirname, '..', 'src')

/** A fake ipcMain that records the registered handlers in a Map. */
function fakeIpcMain() {
  const handlers = new Map()
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
  }
}

const fakeEvent = { sender: {} }
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: () => {} },
}

/**
 * Forgiving stub dependencies. Any db method not named here resolves through the
 * Proxy to a benign default (list* -> [], everything else -> {}), so a handler
 * body reaches every dependency it touches. Individual tests override what they
 * need to assert.
 */
function buildDeps(overrides = {}) {
  const dbBase = {
    getDbPath: () => '/data/app.db',
    getFirm: () => ({ id: 1, client: 'Firm' }),
    getProject: () => ({ id: 1, client: 'Client' }),
    getBuilding: () => ({ id: 1, project_id: 1, property_name: 'Prop', hidden: 0 }),
    getAssetRow: () => ({ id: 1, building_id: 1, asset_name: 'Asset', hidden: 0, uniformat_pricing_id: 1 }),
    getExecutiveSummary: () => ({ id: 1 }),
    getExecutiveSummaryRow: () => ({ hidden: 0 }),
    getBuildingImageRow: () => ({ building_id: 1, hidden: 0, original_name: 'p.jpg' }),
    getAssetImageRow: () => ({ asset_id: 1, hidden: 0, original_name: 'a.jpg' }),
    getImageRowByKind: () => ({ hidden: 0, file_path: '', building_id: 1, asset_id: 1 }),
    getVisibleAssetImageIds: () => [],
    getAssetLevel1GroupName: () => 'A — Substructure',
    getLevel1GroupForPricingId: () => 'A — Substructure',
    getBuildingCapitalPlan: () => null,
    getPropertyReportData: () => ({}),
    previewAssetPlan: () => ({}),
    ensureDatabaseCurrent: () => ({ changed: false }),
    listImagesNeedingCaptions: () => ({ building: [], asset: [] }),
    listBlankExecutiveSummaryFields: () => [],
    createBuilding: () => ({ id: 2 }),
    createAsset: () => ({ id: 2 }),
    createProject: () => ({ id: 2 }),
    createBuildingImage: () => ({ id: 2 }),
    createAssetImage: () => ({ id: 2 }),
    deleteProject: () => ({ projectId: 1 }),
    deleteBuilding: () => {},
    deleteAsset: () => {},
    deleteBuildingImage: () => {},
    deleteAssetImage: () => {},
    deleteExecutiveSummary: () => {},
    captureBuildingDeleteSnapshot: () => ({ buildingId: 1 }),
    restoreDeletedProject: () => ({ id: 1, client: 'Client', snapshot: {} }),
    updateFirm: () => ({ id: 1 }),
    updateProject: () => ({ id: 1 }),
    updateBuilding: () => ({ id: 1 }),
    updateAsset: () => ({ id: 1 }),
    updateExecutiveSummary: () => ({ id: 1 }),
    updateImageCaption: () => ({}),
    updateImageBoundingBoxes: () => ({}),
    updateAssetImageIncludeInReport: () => ({}),
    removeFirmLogo: () => {},
    seedUniformatPricing: () => {},
    openDatabase: () => ({}),
    closeDatabase: () => {},
    backupDatabaseTo: () => {},
    // Snapshots truthy; equality true so the default path skips the undo push
    // (individual tests flip equality to false to assert a push happens).
    firmFieldsSnapshot: () => ({}),
    buildingFieldsSnapshot: () => ({}),
    projectFieldsSnapshot: () => ({}),
    assetFieldsSnapshot: () => ({}),
    executiveSummaryFieldsSnapshot: () => ({}),
    firmPayloadEqualsSnapshot: () => true,
    buildingPayloadEqualsSnapshot: () => true,
    projectPayloadEqualsSnapshot: () => true,
    assetPayloadEqualsSnapshot: () => true,
    executiveSummaryPayloadEqualsSnapshot: () => true,
    restoreAssetVisibility: () => {},
    restoreImageVisibility: () => {},
    restoreBuildingDeleteSnapshot: () => {},
    restoreProjectDeleteSnapshot: () => true,
    restoreExecutiveSummaryVisibility: () => {},
    ...overrides.db,
  }
  const db = new Proxy(dbBase, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'string' && prop.startsWith('list')) return () => []
      return () => ({})
    },
  })

  const undoHistory = {
    clear() {}, clearRedo() {}, pop: () => null, popRedo: () => null,
    push() {}, pushRedo() {}, requeue() {}, requeueRedo() {},
    pushAssetUpdate() {}, pushBuildingUpdate() {}, pushProjectUpdate() {},
    pushExecutiveSummaryUpdate() {}, pushFirmUpdate() {},
    ...overrides.undoHistory,
  }

  const captionService = {
    AI_KEY_UNAVAILABLE: 'AI key unavailable',
    getAiStatus: () => ({
      unlocked: true,
      modelConfigured: true,
      visionModelConfigured: true,
      summaryModelConfigured: true,
    }),
    getOpenRouterUsage: () => ({}),
    enqueueCaptionJobs: () => ({ queued: 0, alreadyGenerating: 0, jobs: [] }),
    enqueueSummaryJobs: () => ({ queued: 0, alreadyGenerating: 0, jobs: [] }),
    generateExecutiveSummarySection: () => ({ ok: true, text: '' }),
    configureCaptionPersistence() {},
    ...overrides.captionService,
  }

  const dialog = {
    showMessageBox: async () => ({ response: 1 }), // Cancel by default
    showMessageBoxSync: () => 1,
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showErrorBox() {},
    ...overrides.dialog,
  }

  return {
    ipcMain: overrides.ipcMain,
    app: {
      getVersion: () => '1.4.0',
      getName: () => 'Condition Assessment Report Generator',
      isPackaged: false,
      getLocale: () => 'en-CA',
      getPath: () => '/tmp/userData',
      getAppPath: () => '/app',
      ...overrides.app,
    },
    dialog,
    shell: { showItemInFolder() {}, ...overrides.shell },
    db,
    undoHistory,
    captionService,
    appSettings: {
      getUniformatPricingCsvInfo: () => ({ path: null, fileName: null, isDefault: true }),
      getUniformatPricingCsvPath: () => '/csv/uniformat.csv',
      setUniformatPricingCsvPath() {},
      ...overrides.appSettings,
    },
    appDataIo: {
      defaultExportFileName: () => 'export.projectdata',
      exportAppData: async () => ({ filePath: '/tmp/export.projectdata' }),
      importAppData: async () => ({}),
      recoverInterruptedImport: () => ({ recovered: false }),
      ...overrides.appDataIo,
    },
    readUniformatPricingRows: overrides.readUniformatPricingRows ?? (() => []),
    loadPage: overrides.loadPage ?? (() => {}),
    getWindow: overrides.getWindow ?? (() => fakeWindow),
    copyFirmLogo: () => '/tmp/firm-logo.png',
    copyBuildingImage: () => '/tmp/building.png',
    copyAssetImage: () => '/tmp/asset.png',
    setBusyTask: overrides.setBusyTask ?? (() => ({ ok: true, busy: false, task: null })),
    respondToCloseRequest:
      overrides.respondToCloseRequest ?? (() => ({ accepted: false })),
    buildReportDocxBuffer:
      overrides.buildReportDocxBuffer ?? (async () => Buffer.from('DOCX')),
    writeReportFileAtomically:
      overrides.writeReportFileAtomically ?? (() => {}),
  }
}

/** Register against a fresh fake ipcMain and return { ipc, deps }. */
function register(overrides = {}) {
  const ipc = fakeIpcMain()
  const deps = buildDeps({ ...overrides, ipcMain: ipc })
  registerIpcHandlers(deps)
  return { ipc, deps }
}

test('registers exactly the channels the renderer surface invokes', () => {
  const { ipc } = register()
  const registered = new Set(ipc.handlers.keys())

  const surfaceSource = fs.readFileSync(path.join(SRC, 'ipc-surface.js'), 'utf8')
  const surfaceChannels = new Set()
  for (const match of surfaceSource.matchAll(/\binvoke\(\s*'([^']+)'/g)) {
    surfaceChannels.add(match[1])
  }

  assert.ok(registered.size > 50, `expected the whole surface, found ${registered.size}`)
  const missing = [...surfaceChannels].filter((c) => !registered.has(c))
  const extra = [...registered].filter((c) => !surfaceChannels.has(c))
  assert.deepEqual(missing, [], 'surface methods with no registered handler')
  assert.deepEqual(extra, [], 'registered handlers no surface method reaches')
})

test('no handler references an unwired dependency (ReferenceError sweep)', async () => {
  // A dependency the extraction forgot to pass shows up as a ReferenceError when
  // the handler runs — an undefined free variable. Stub-shape mismatches surface
  // as TypeError and are tolerated here; only ReferenceError fails the sweep.
  const { ipc } = register()
  const refErrors = []
  for (const [channel, handler] of ipc.handlers) {
    try {
      await handler(fakeEvent, 1, {}, [1])
    } catch (err) {
      if (err instanceof ReferenceError) refErrors.push(`${channel}: ${err.message}`)
    }
  }
  assert.deepEqual(refErrors, [], `handlers hit undefined dependencies:\n${refErrors.join('\n')}`)
})

test('app:getVersion and app:getInfo report identity', async () => {
  const { ipc } = register()
  assert.equal(await ipc.handlers.get('app:getVersion')(fakeEvent), '1.4.0')
  const info = await ipc.handlers.get('app:getInfo')(fakeEvent)
  assert.equal(info.version, '1.4.0')
  assert.equal(info.dbPath, '/data/app.db')
  assert.ok('ai' in info)
})

test('app:close-response is scoped to the sending BrowserWindow', async () => {
  const calls = []
  const senderWindow = { id: 7 }
  const { ipc } = register({
    getWindow: () => senderWindow,
    respondToCloseRequest: (...args) => {
      calls.push(args)
      return { accepted: true }
    },
  })

  const result = await ipc.handlers.get('app:close-response')(
    fakeEvent,
    42,
    { ok: true },
  )
  assert.deepEqual(result, { accepted: true })
  assert.deepEqual(calls, [[senderWindow, 42, { ok: true }]])
})

test('AI persistence invalidates reused row ids before reading or writing them', () => {
  const order = []
  let persistence
  const captionService = {
    configureCaptionPersistence(hooks) {
      persistence = hooks
    },
    invalidateWorkspace() {
      order.push('invalidate AI')
    },
  }
  const undoHistory = {
    clear() {
      order.push('clear undo')
    },
  }
  const db = {
    ensureDatabaseCurrent() {
      order.push('ensure')
      return { changed: true }
    },
    getImageRowByKind() {
      order.push('read image')
      return { id: 1, caption: null }
    },
    updateImageCaption() {
      order.push('write image')
    },
  }

  configureCaptionPersistence({ db, captionService, undoHistory })
  assert.deepEqual(persistence.getImageRow('asset', 1), {
    id: 1,
    caption: null,
  })
  assert.deepEqual(order, ['ensure', 'clear undo', 'invalidate AI', 'read image'])

  order.length = 0
  persistence.updateImageCaption('asset', 1, 'Old workspace response')
  assert.deepEqual(order, ['ensure', 'clear undo', 'invalidate AI'])
})

test('db:listProjects reads through to the database', async () => {
  const projects = [{ id: 1 }, { id: 2 }]
  const { ipc } = register({ db: { listProjects: () => projects } })
  assert.deepEqual(await ipc.handlers.get('db:listProjects')(fakeEvent), projects)
})

test('db:updateProject records an undo step only when values change', async () => {
  const pushes = []
  const { ipc } = register({
    db: { projectPayloadEqualsSnapshot: () => false },
    undoHistory: { pushProjectUpdate: (...args) => pushes.push(args) },
  })
  await ipc.handlers.get('db:updateProject')(fakeEvent, 1, { client: 'New' })
  assert.equal(pushes.length, 1)

  const noPush = []
  const second = register({
    db: { projectPayloadEqualsSnapshot: () => true },
    undoHistory: { pushProjectUpdate: (...args) => noPush.push(args) },
  })
  await second.ipc.handlers.get('db:updateProject')(fakeEvent, 1, { client: 'Same' })
  assert.equal(noPush.length, 0)
})

test('db:deleteProject respects the confirm dialog', async () => {
  // Cancel -> nothing deleted.
  const deletedCancel = []
  const cancel = register({
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    db: { deleteProject: (id) => { deletedCancel.push(id); return { projectId: id } } },
  })
  assert.deepEqual(await cancel.ipc.handlers.get('db:deleteProject')(fakeEvent, 5), { canceled: true })
  assert.equal(deletedCancel.length, 0)

  // Confirm -> deletes and records an undo step.
  const deletedOk = []
  const pushes = []
  const ok = register({
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    db: { deleteProject: (id) => { deletedOk.push(id); return { projectId: id } } },
    undoHistory: { push: (entry) => pushes.push(entry) },
  })
  assert.deepEqual(await ok.ipc.handlers.get('db:deleteProject')(fakeEvent, 5), { canceled: false })
  assert.deepEqual(deletedOk, [5])
  assert.equal(pushes[0].type, 'project-delete')
})

test('history:undo and history:redo report an empty stack', async () => {
  const { ipc } = register()
  assert.deepEqual(await ipc.handlers.get('history:undo')(fakeEvent), { undone: false, empty: true })
  assert.deepEqual(await ipc.handlers.get('history:redo')(fakeEvent), { redone: false, empty: true })
})

test('property-report:chooseExportPath cancels when the save dialog is dismissed', async () => {
  const { ipc } = register({ dialog: { showSaveDialog: async () => ({ canceled: true }) } })
  assert.deepEqual(
    await ipc.handlers.get('property-report:chooseExportPath')(fakeEvent, 'report.docx'),
    { canceled: true },
  )
})

test('report preparation builds once and every save writes the exact previewed bytes', async () => {
  const senderA = {}
  const senderB = {}
  const eventA = { sender: senderA }
  const eventB = { sender: senderB }
  const windowA = { ...fakeWindow }
  const windowB = { ...fakeWindow }
  const writes = []
  const order = []
  const report = {
    project: { id: 3 },
    firm: { id: 1 },
    building: { id: 7 },
    buildingImages: [],
    assets: [],
    validation: { findings: [], errorCount: 0, warningCount: 0 },
  }
  let builds = 0
  const { ipc } = register({
    getWindow: (event) => (event.sender === senderA ? windowA : windowB),
    dialog: {
      showSaveDialog: async () => ({
        canceled: false,
        filePath: '/private/user-selected/report.docx',
      }),
    },
    db: {
      getPropertyReportData: () => {
        order.push('snapshot')
        return report
      },
    },
    captionService: {
      getAiStatus: () => {
        order.push('AI status')
        return { captionJobs: [], summaryJobs: [] }
      },
    },
    buildReportDocxBuffer: async () => {
      builds += 1
      order.push('build')
      return Buffer.from('DOCX bytes')
    },
    writeReportFileAtomically: (filePath, bytes) => {
      order.push('write')
      writes.push({ filePath, bytes: bytes.toString() })
    },
  })

  const prepared = await ipc.handlers.get('property-report:prepare')(
    eventA,
    3,
    [7],
  )
  assert.equal(prepared.ok, true)
  assert.equal(typeof prepared.previewId, 'string')
  assert.equal(Buffer.from(prepared.docxBytes).toString(), 'DOCX bytes')
  assert.equal(prepared.reviewReports[0].building.id, 7)
  assert.equal(builds, 1)

  const chosen = await ipc.handlers.get('property-report:chooseExportPath')(
    eventA,
    'report.docx',
  )
  assert.equal(chosen.canceled, false)
  assert.equal(typeof chosen.exportId, 'string')
  assert.equal('docxPath' in chosen, false, 'the selected path must not cross IPC')

  const wrongSender = await ipc.handlers.get('property-report:export')(
    eventB,
    prepared.previewId,
    chosen.exportId,
  )
  assert.equal(wrongSender.code, 'STALE_PREVIEW')
  assert.deepEqual(writes, [])

  const exported = await ipc.handlers.get('property-report:export')(
    eventA,
    prepared.previewId,
    chosen.exportId,
  )
  assert.deepEqual(exported, {
    canceled: false,
    docxPath: '/private/user-selected/report.docx',
  })
  assert.deepEqual(writes, [
    {
      filePath: '/private/user-selected/report.docx',
      bytes: 'DOCX bytes',
    },
  ])
  assert.equal(builds, 1, 'saving must not rebuild the previewed document')
  assert.equal(order.at(-1), 'write')

  const reused = await ipc.handlers.get('property-report:export')(
    eventA,
    prepared.previewId,
    chosen.exportId,
  )
  assert.equal(reused.canceled, true)
  assert.equal(writes.length, 1)

  const chosenAgain = await ipc.handlers.get('property-report:chooseExportPath')(
    eventA,
    'report-again.docx',
  )
  const exportedAgain = await ipc.handlers.get('property-report:export')(
    eventA,
    prepared.previewId,
    chosenAgain.exportId,
  )
  assert.equal(exportedAgain.docxPath, '/private/user-selected/report.docx')
  assert.equal(writes.length, 2)
  assert.equal(builds, 1, 'a prepared artifact is reusable across save locations')
})

test('main rejects a relevant AI job before preparing a Word preview', async () => {
  let builds = 0
  const report = {
    project: { id: 3 },
    firm: { id: 1 },
    building: { id: 7 },
    buildingImages: [],
    assets: [],
    validation: { findings: [], errorCount: 0, warningCount: 0 },
  }
  const { ipc } = register({
    db: { getPropertyReportData: () => report },
    captionService: {
      getAiStatus: () => ({
        captionJobs: [],
        summaryJobs: [{ buildingId: 7, field: 'mechanical' }],
      }),
    },
    buildReportDocxBuffer: async () => {
      builds += 1
      return Buffer.from('must not build')
    },
  })

  const result = await ipc.handlers.get('property-report:prepare')(
    fakeEvent,
    3,
    [7],
  )
  assert.equal(result.code, 'AI_ACTIVE')
  assert.equal(result.waitingForAi, true)
  assert.match(result.error, /AI is still updating/i)
  assert.equal(builds, 0)
})

test('report preparation rejects a snapshot that changes during the DOCX build', async () => {
  const baseReport = {
    project: { id: 3 },
    firm: { id: 1 },
    building: { id: 7, property_name: 'Stable' },
    buildingImages: [],
    assets: [],
    validation: { findings: [], errorCount: 0, warningCount: 0 },
  }
  let currentReport = structuredClone(baseReport)
  let builds = 0
  let writes = 0
  const secondBuild = Promise.withResolvers()
  const { ipc } = register({
    dialog: {
      showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/report.docx' }),
    },
    db: { getPropertyReportData: () => structuredClone(currentReport) },
    captionService: {
      getAiStatus: () => ({ captionJobs: [], summaryJobs: [] }),
    },
    buildReportDocxBuffer: async () => {
      builds += 1
      if (builds === 1) return Buffer.from('first preview')
      return secondBuild.promise
    },
    writeReportFileAtomically: () => {
      writes += 1
    },
  })

  const first = await ipc.handlers.get('property-report:prepare')(fakeEvent, 3, [7])
  assert.equal(first.ok, true)

  const pending = ipc.handlers.get('property-report:prepare')(fakeEvent, 3, [7])
  assert.equal(builds, 2, 'the second build is in flight before data changes')
  currentReport.building.property_name = 'Changed during build'
  secondBuild.resolve(Buffer.from('obsolete preview'))

  const changed = await pending
  assert.equal(changed.ok, false)
  assert.equal(changed.code, 'SNAPSHOT_CHANGED')
  assert.equal(changed.retry, true)
  assert.equal(changed.docxBytes, undefined)

  const chosen = await ipc.handlers.get('property-report:chooseExportPath')(
    fakeEvent,
    'report.docx',
  )
  const stale = await ipc.handlers.get('property-report:export')(
    fakeEvent,
    first.previewId,
    chosen.exportId,
  )
  assert.equal(stale.code, 'STALE_PREVIEW')
  assert.equal(writes, 0, 'neither the old nor the changed artifact remains usable')
})

test('report preparation rejects AI that starts during the DOCX build', async () => {
  const report = {
    project: { id: 3 },
    firm: { id: 1 },
    building: { id: 7 },
    buildingImages: [],
    assets: [],
    validation: { findings: [], errorCount: 0, warningCount: 0 },
  }
  const build = Promise.withResolvers()
  let aiActive = false
  const { ipc } = register({
    db: { getPropertyReportData: () => structuredClone(report) },
    captionService: {
      getAiStatus: () => ({
        captionJobs: aiActive ? [{ buildingId: 7, imageId: 90 }] : [],
        summaryJobs: [],
      }),
    },
    buildReportDocxBuffer: () => build.promise,
  })

  const pending = ipc.handlers.get('property-report:prepare')(fakeEvent, 3, [7])
  aiActive = true
  build.resolve(Buffer.from('obsolete preview'))

  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.code, 'AI_ACTIVE')
  assert.equal(result.waitingForAi, true)
  assert.equal(result.docxBytes, undefined)
})

test('AI and snapshot races block saving without consuming the chosen path', async () => {
  const baseReport = {
    project: { id: 3 },
    firm: { id: 1 },
    building: { id: 7, property_name: 'Stable' },
    buildingImages: [],
    assets: [],
    validation: { findings: [], errorCount: 0, warningCount: 0 },
  }
  let currentReport = structuredClone(baseReport)
  let aiActive = false
  const writes = []
  const { ipc } = register({
    dialog: {
      showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/report.docx' }),
    },
    db: { getPropertyReportData: () => structuredClone(currentReport) },
    captionService: {
      getAiStatus: () => ({
        captionJobs: aiActive ? [{ buildingId: 7, imageId: 90 }] : [],
        summaryJobs: [],
      }),
    },
    buildReportDocxBuffer: async () => Buffer.from('stable bytes'),
    writeReportFileAtomically: (filePath, bytes) => {
      writes.push({ filePath, bytes: Buffer.from(bytes).toString() })
    },
  })

  const prepared = await ipc.handlers.get('property-report:prepare')(fakeEvent, 3, [7])
  const chosen = await ipc.handlers.get('property-report:chooseExportPath')(
    fakeEvent,
    'report.docx',
  )

  aiActive = true
  const aiBlocked = await ipc.handlers.get('property-report:export')(
    fakeEvent,
    prepared.previewId,
    chosen.exportId,
  )
  assert.equal(aiBlocked.code, 'AI_ACTIVE')
  assert.deepEqual(writes, [])

  aiActive = false
  currentReport.building.property_name = 'Changed after preview'
  const stale = await ipc.handlers.get('property-report:export')(
    fakeEvent,
    prepared.previewId,
    chosen.exportId,
  )
  assert.equal(stale.code, 'STALE_PREVIEW')
  assert.deepEqual(writes, [])

  currentReport = structuredClone(baseReport)
  const saved = await ipc.handlers.get('property-report:export')(
    fakeEvent,
    prepared.previewId,
    chosen.exportId,
  )
  assert.equal(saved.docxPath, '/tmp/report.docx')
  assert.deepEqual(writes, [{ filePath: '/tmp/report.docx', bytes: 'stable bytes' }])
})

test('validation errors require the same explicit override enforced by the renderer', async () => {
  const report = {
    project: { id: 3 },
    firm: { id: 1 },
    building: { id: 7 },
    buildingImages: [],
    assets: [],
    validation: {
      findings: [{ severity: 'error', message: 'Address is missing.' }],
      errorCount: 1,
      warningCount: 0,
    },
  }
  let writes = 0
  const { ipc } = register({
    dialog: {
      showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/report.docx' }),
    },
    db: { getPropertyReportData: () => structuredClone(report) },
    captionService: {
      getAiStatus: () => ({ captionJobs: [], summaryJobs: [] }),
    },
    buildReportDocxBuffer: async () => Buffer.from('reviewed bytes'),
    writeReportFileAtomically: () => {
      writes += 1
    },
  })
  const prepared = await ipc.handlers.get('property-report:prepare')(fakeEvent, 3, [7])
  const chosen = await ipc.handlers.get('property-report:chooseExportPath')(
    fakeEvent,
    'report.docx',
  )

  const blocked = await ipc.handlers.get('property-report:export')(
    fakeEvent,
    prepared.previewId,
    chosen.exportId,
  )
  assert.equal(blocked.code, 'VALIDATION_BLOCKED')
  assert.equal(writes, 0)

  const overridden = await ipc.handlers.get('property-report:export')(
    fakeEvent,
    prepared.previewId,
    chosen.exportId,
    { allowValidationErrors: true },
  )
  assert.equal(overridden.docxPath, '/tmp/report.docx')
  assert.equal(writes, 1)
})

test('direct summary generation discards old-context prose after a database change', async () => {
  const invalidations = []
  let clears = 0
  let workspaceChecks = 0
  const { ipc } = register({
    db: {
      ensureDatabaseCurrent: () => ({ changed: ++workspaceChecks === 2 }),
      getBuilding: () => ({ id: 7, hidden: 0 }),
      listBuildingAssets: () => [],
      getBuildingCapitalPlan: () => null,
    },
    undoHistory: {
      clear: () => {
        clears += 1
      },
    },
    captionService: {
      getAiStatus: () => ({ unlocked: true, summaryModelConfigured: true }),
      generateExecutiveSummarySection: async () => ({
        ok: true,
        text: 'Old database prose',
      }),
      invalidateWorkspace: (reason) => invalidations.push(reason),
    },
  })

  const result = await ipc.handlers.get('ai:generateExecutiveSummarySection')(
    fakeEvent,
    7,
    'mechanical',
  )
  assert.equal(result.ok, false)
  assert.equal(result.canceled, true)
  assert.equal(result.stale, true)
  assert.match(result.error, /database changed/i)
  assert.equal('text' in result, false)
  assert.equal(clears, 1)
  assert.equal(invalidations.length, 1)
})

test('direct summary consumes a prior database replacement before generation', async () => {
  let workspaceChecks = 0
  let generations = 0
  let invalidations = 0
  const { ipc } = register({
    db: {
      ensureDatabaseCurrent: () => ({ changed: ++workspaceChecks === 1 }),
      getBuilding: () => ({ id: 7, hidden: 0 }),
      listBuildingAssets: () => [],
      getBuildingCapitalPlan: () => null,
    },
    captionService: {
      getAiStatus: () => ({ unlocked: true, summaryModelConfigured: true }),
      getWorkspaceEpoch: () => invalidations,
      invalidateWorkspace: () => {
        invalidations += 1
      },
      generateExecutiveSummarySection: async () => {
        generations += 1
        return { ok: true, text: 'Current workspace prose' }
      },
    },
  })

  const result = await ipc.handlers.get('ai:generateExecutiveSummarySection')(
    fakeEvent,
    7,
    'mechanical',
  )
  assert.equal(result.ok, true)
  assert.equal(result.text, 'Current workspace prose')
  assert.equal(generations, 1)
  assert.equal(invalidations, 1)
  assert.equal(workspaceChecks, 2)
})

test('direct summary notices workspace invalidation consumed by another DB call', async () => {
  let workspaceEpoch = 11
  const { ipc } = register({
    db: {
      ensureDatabaseCurrent: () => ({ changed: false }),
      getBuilding: () => ({ id: 7, hidden: 0 }),
      listBuildingAssets: () => [],
      getBuildingCapitalPlan: () => null,
    },
    captionService: {
      getAiStatus: () => ({ unlocked: true, summaryModelConfigured: true }),
      getWorkspaceEpoch: () => workspaceEpoch,
      generateExecutiveSummarySection: async () => {
        // Another DB API consumed the replacement latch and invalidated the
        // shared service while this request was away at OpenRouter.
        workspaceEpoch += 1
        return { ok: true, text: 'Prose from the old workspace' }
      },
    },
  })

  const result = await ipc.handlers.get('ai:generateExecutiveSummarySection')(
    fakeEvent,
    7,
    'mechanical',
  )
  assert.equal(result.ok, false)
  assert.equal(result.canceled, true)
  assert.equal(result.stale, true)
  assert.equal('text' in result, false)
})

test('a failed app-data import resolves recovery metadata before reopening SQLite', async () => {
  const order = []
  const { ipc } = register({
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/bad.projectdata'] }),
      showMessageBox: async () => ({ response: 0 }),
    },
    appDataIo: {
      importAppData: async () => {
        throw new Error('bad backup')
      },
      recoverInterruptedImport: () => {
        order.push('recover')
      },
    },
    db: {
      openDatabase: () => {
        order.push('open')
      },
    },
  })

  const result = await ipc.handlers.get('app-data:import')(fakeEvent)
  assert.equal(result.canceled, true)
  assert.deepEqual(order, ['recover', 'open'])
})

test('ai:regenerateCaption fails closed when the key is locked', async () => {
  const { ipc } = register({
    captionService: { getAiStatus: () => ({ unlocked: false }) },
  })
  const result = await ipc.handlers.get('ai:regenerateCaption')(fakeEvent, 'asset', 1)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'AI key unavailable')
})
