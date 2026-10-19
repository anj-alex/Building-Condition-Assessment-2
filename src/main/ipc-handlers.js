// Every main-process IPC handler, registered against a real `ipcMain` inside
// registerIpcHandlers so the whole surface can be exercised with a fake ipcMain
// and stub dependencies (test/ipc-handlers.test.js). Handler bodies are moved
// verbatim from src/main.js; the dependencies they used to close over — db,
// dialog, the window helpers, the image-copy helpers — arrive through `deps`.

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const { buildProjectReportDocxBuffer } = require('../docx-report')
const { writeFileAtomically } = require('./atomic-file')
const {
  createPreparedReportArtifacts,
  createReportExportCapabilities,
  findRelevantReportAiJob,
  fingerprintReportSnapshot,
} = require('./report-export')

/**
 * Register every renderer-facing IPC channel.
 * @param {object} deps real Electron objects and main.js window/state helpers
 */
function registerIpcHandlers(deps) {
  const {
    ipcMain,
    app,
    dialog,
    shell,
    db,
    undoHistory,
    captionService,
    appSettings,
    appDataIo,
    readUniformatPricingRows,
    loadPage,
    getWindow,
    copyFirmLogo,
    copyBuildingImage,
    copyAssetImage,
    setBusyTask,
    respondToCloseRequest,
    buildReportDocxBuffer = buildProjectReportDocxBuffer,
    writeReportFileAtomically = writeFileAtomically,
  } = deps
  const preparedReportArtifacts = createPreparedReportArtifacts()
  const reportExportCapabilities = createReportExportCapabilities()
  const reportExportChoices = new WeakMap()

  async function confirmDelete(event, message) {
    const win = getWindow(event)
    if (!win) return false
    const result = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Confirm delete',
      message,
    })
    return result.response === 0
  }

  function handleChannel(channel, handler) {
    ipcMain.handle(channel, handler)
  }

  function invalidateWorkspaceState(reason) {
    undoHistory.clear()
    captionService.invalidateWorkspace?.(reason)
  }

  function ensureCurrentWorkspace() {
    const result = db.ensureDatabaseCurrent()
    if (result?.changed) {
      invalidateWorkspaceState(
        'The database file changed — queued AI work was canceled.',
      )
    }
    return result
  }

  handleChannel('app:getVersion', () => app.getVersion())

  handleChannel('app:close-response', (event, requestId, result) =>
    respondToCloseRequest(getWindow(event), requestId, result),
  )

  /** Expanded identity for Settings / support (paths, runtime, packaging). */
  handleChannel('app:getInfo', () => ({
    version: app.getVersion(),
    name: app.getName(),
    packaged: app.isPackaged,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    osType: os.type(),
    locale: app.getLocale(),
    userDataPath: app.getPath('userData'),
    dbPath: db.getDbPath(),
    appPath: app.getAppPath(),
    execPath: process.execPath,
    ai: captionService.getAiStatus(),
  }))

  handleChannel('ai:getStatus', () => captionService.getAiStatus())

  handleChannel('ai:getUsage', () => captionService.getOpenRouterUsage())

  handleChannel('ai:setBulkBusy', (_event, busy) =>
    setBusyTask(busy ? 'AI generation' : null),
  )

  // Preparing the Word-backed preview owns the window the same way bulk AI
  // does: the renderer shows progress and locks navigation/quit while the
  // document is built and laid out. Saving the prepared bytes uses the same
  // lock briefly so a destination cannot be left half-written.
  handleChannel('report:setExportBusy', (_event, busy) =>
    setBusyTask(busy ? 'Report preparation' : null),
  )

  handleChannel('ai:previewBlankFields', () => {
    const status = captionService.getAiStatus()
    if (!status.unlocked) {
      return { ok: false, error: captionService.AI_KEY_UNAVAILABLE }
    }
    const canCaptions = Boolean(status.visionModelConfigured ?? status.modelConfigured)
    const canSummaries = Boolean(status.summaryModelConfigured)
    if (!canCaptions && !canSummaries) {
      return { ok: false, error: 'AI models are not configured.' }
    }

    let captions = 0
    let missingFiles = 0
    if (canCaptions) {
      const needing = db.listImagesNeedingCaptions()
      for (const row of needing.building) {
        if (!row?.file_path || !fs.existsSync(row.file_path)) {
          missingFiles += 1
          continue
        }
        captions += 1
      }
      for (const row of needing.asset) {
        if (!row?.file_path || !fs.existsSync(row.file_path)) {
          missingFiles += 1
          continue
        }
        captions += 1
      }
    }

    let summaries = 0
    if (canSummaries) {
      summaries = db.listBlankExecutiveSummaryFields().length
    }

    return {
      ok: true,
      captions,
      summaries,
      missingFiles,
      canCaptions,
      canSummaries,
      total: captions + summaries,
    }
  })

  handleChannel('db:updateImageCaption', (_event, kind, imageId, caption) => {
    const result = db.updateImageCaption(String(kind), Number(imageId), caption)
    undoHistory.clearRedo()
    return result
  })

  handleChannel('db:updateImageBoundingBoxes', (_event, kind, imageId, boxes) => {
    const result = db.updateImageBoundingBoxes(
      String(kind),
      Number(imageId),
      Array.isArray(boxes) ? boxes : [],
    )
    undoHistory.clearRedo()
    return result
  })

  handleChannel('db:updateAssetImageIncludeInReport', (_event, imageId, includeInReport) => {
    const result = db.updateAssetImageIncludeInReport(Number(imageId), includeInReport)
    undoHistory.clearRedo()
    return result
  })

  /**
   * Force a new vision caption for one image (overwrites existing caption when done).
   */
  handleChannel('ai:regenerateCaption', async (_event, kind, imageId) => {
    const status = captionService.getAiStatus()
    if (!status.unlocked) {
      return { ok: false, error: captionService.AI_KEY_UNAVAILABLE }
    }
    if (!status.modelConfigured) {
      return { ok: false, error: 'AI model is not configured.' }
    }

    const type = String(kind) === 'building' ? 'building' : 'asset'
    const id = Number(imageId)
    const row = db.getImageRowByKind(type, id)
    if (!row || Number(row.hidden) === 1) {
      return { ok: false, error: 'Image not found.' }
    }
    if (!row.file_path || !fs.existsSync(row.file_path)) {
      return { ok: false, error: 'Image file is missing on disk.' }
    }

    if (type === 'building') {
      const buildingId = Number(row.building_id)
      const building = db.getBuilding(buildingId)
      captionService.enqueueCaptionJobs([
        {
          kind: 'building',
          imageId: id,
          buildingId,
          filePath: row.file_path,
          force: true,
          context: {
            propertyName: building?.property_name ?? null,
            address: [
              building?.address,
              building?.city,
              building?.province_short || building?.province,
              building?.postal_code,
            ]
              .filter(Boolean)
              .join(', '),
          },
        },
      ])
      return { ok: true, queued: true }
    }

    const assetId = Number(row.asset_id)
    const assetRow = db.getAssetRow(assetId)
    const building =
      assetRow?.building_id != null ? db.getBuilding(Number(assetRow.building_id)) : null
    captionService.enqueueCaptionJobs([
      {
        kind: 'asset',
        imageId: id,
        assetId,
        buildingId: assetRow?.building_id != null ? Number(assetRow.building_id) : null,
        filePath: row.file_path,
        force: true,
        context: {
          propertyName: building?.property_name ?? null,
          assetName: assetRow?.asset_name ?? null,
          condition: assetRow?.condition_rating ?? null,
          level1Group: db.getAssetLevel1GroupName(assetId) ?? null,
        },
      },
    ])
    return { ok: true, queued: true }
  })

  /**
   * Queue AI for every blank photo caption and executive-summary section.
   * Respects caption/summary concurrency and free-model RPM caps.
   */
  handleChannel('ai:generateBlankFields', async () => {
    const status = captionService.getAiStatus()
    if (!status.unlocked) {
      return { ok: false, error: captionService.AI_KEY_UNAVAILABLE }
    }

    const canCaptions = Boolean(status.visionModelConfigured ?? status.modelConfigured)
    const canSummaries = Boolean(status.summaryModelConfigured)
    if (!canCaptions && !canSummaries) {
      return { ok: false, error: 'AI models are not configured.' }
    }

    let captionsQueued = 0
    let captionsAlreadyGenerating = 0
    let captionsBlank = 0
    let missingFiles = 0
    let summariesQueued = 0
    let summariesAlreadyGenerating = 0
    let summariesBlank = 0
    /** @type {Array<{ kind: string, imageId: number }>} */
    let captionJobs = []
    /** @type {Array<{ buildingId: number, field: string }>} */
    let summaryJobsQueued = []

    if (canCaptions) {
      const needing = db.listImagesNeedingCaptions()
      captionsBlank = needing.building.length + needing.asset.length
      const jobs = []

      /** @type {Map<number, object|null>} */
      const buildingCache = new Map()
      function cachedBuilding(buildingId) {
        const id = Number(buildingId)
        if (!Number.isFinite(id) || id <= 0) return null
        if (!buildingCache.has(id)) buildingCache.set(id, db.getBuilding(id))
        return buildingCache.get(id)
      }

      for (const row of needing.building) {
        if (!row?.file_path || !fs.existsSync(row.file_path)) {
          missingFiles += 1
          continue
        }
        const buildingId = Number(row.building_id)
        const building = cachedBuilding(buildingId)
        jobs.push({
          kind: 'building',
          imageId: Number(row.id),
          buildingId,
          filePath: row.file_path,
          context: {
            propertyName: building?.property_name ?? null,
            address: [
              building?.address,
              building?.city,
              building?.province_short || building?.province,
              building?.postal_code,
            ]
              .filter(Boolean)
              .join(', '),
          },
        })
      }

      /** @type {Map<number, object|null>} */
      const assetCache = new Map()
      /** @type {Map<number, string|null>} */
      const level1Cache = new Map()
      for (const row of needing.asset) {
        if (!row?.file_path || !fs.existsSync(row.file_path)) {
          missingFiles += 1
          continue
        }
        const assetId = Number(row.asset_id)
        if (!assetCache.has(assetId)) assetCache.set(assetId, db.getAssetRow(assetId))
        const assetRow = assetCache.get(assetId)
        const buildingId =
          row.building_id != null
            ? Number(row.building_id)
            : assetRow?.building_id != null
              ? Number(assetRow.building_id)
              : null
        const building = buildingId != null ? cachedBuilding(buildingId) : null
        if (!level1Cache.has(assetId)) {
          level1Cache.set(assetId, db.getAssetLevel1GroupName(assetId) ?? null)
        }
        jobs.push({
          kind: 'asset',
          imageId: Number(row.id),
          assetId,
          buildingId,
          filePath: row.file_path,
          context: {
            propertyName: building?.property_name ?? null,
            assetName: assetRow?.asset_name ?? null,
            condition: assetRow?.condition_rating ?? null,
            level1Group: level1Cache.get(assetId) ?? null,
          },
        })
      }

      if (jobs.length > 0) {
        const result = captionService.enqueueCaptionJobs(jobs)
        captionsQueued = result.queued
        captionsAlreadyGenerating = result.alreadyGenerating ?? 0
        captionJobs = result.jobs ?? []
      }
    }

    if (canSummaries) {
      const blanks = db.listBlankExecutiveSummaryFields()
      summariesBlank = blanks.length

      /** @type {Map<number, { building: object, assets: object[], capitalPlan: object|null }>} */
      const contextCache = new Map()
      function cachedSummaryContext(buildingId) {
        const id = Number(buildingId)
        if (!contextCache.has(id)) {
          const building = db.getBuilding(id)
          contextCache.set(id, {
            building,
            assets: db.listBuildingAssets(id),
            capitalPlan: db.getBuildingCapitalPlan(id),
          })
        }
        return contextCache.get(id)
      }

      const summaryJobs = []
      for (const blank of blanks) {
        const ctx = cachedSummaryContext(blank.buildingId)
        if (!ctx?.building || Number(ctx.building.hidden) === 1) continue
        summaryJobs.push({
          buildingId: Number(blank.buildingId),
          field: String(blank.field),
          building: ctx.building,
          assets: ctx.assets,
          capitalPlan: ctx.capitalPlan,
        })
      }

      if (summaryJobs.length > 0) {
        const result = captionService.enqueueSummaryJobs(summaryJobs)
        summariesQueued = result.queued
        summariesAlreadyGenerating = result.alreadyGenerating ?? 0
        summaryJobsQueued = result.jobs ?? []
      }
    }

    const totalQueued = captionsQueued + summariesQueued
    const totalAlready =
      captionsAlreadyGenerating + summariesAlreadyGenerating
    if (totalQueued === 0 && totalAlready === 0) {
      const parts = []
      if (canCaptions && captionsBlank === 0) parts.push('no blank captions')
      else if (canCaptions && captionsBlank > 0 && missingFiles >= captionsBlank) {
        parts.push('blank captions missing files')
      }
      if (canSummaries && summariesBlank === 0) parts.push('no blank summary sections')
      return {
        ok: true,
        captionsQueued: 0,
        summariesQueued: 0,
        captionsBlank,
        summariesBlank,
        missingFiles,
        captionsAlreadyGenerating: 0,
        summariesAlreadyGenerating: 0,
        captionJobs: [],
        summaryJobs: [],
        message:
          parts.length > 0
            ? `Nothing to generate (${parts.join('; ')}).`
            : 'Nothing to generate.',
      }
    }

    return {
      ok: true,
      captionsQueued,
      summariesQueued,
      captionsBlank,
      summariesBlank,
      missingFiles,
      captionsAlreadyGenerating,
      summariesAlreadyGenerating,
      captionJobs,
      summaryJobs: summaryJobsQueued,
    }
  })

  /**
   * AI-generate one executive summary section from building, asset, and capital-plan context.
   * Returns text for the renderer form (does not persist).
   */
  handleChannel(
    'ai:generateExecutiveSummarySection',
    async (_event, buildingId, field) => {
      // Consume a replacement that already happened before paying for a model
      // request. The post-await check below then distinguishes a change during
      // generation from the current workspace we intentionally started with.
      ensureCurrentWorkspace()
      const status = captionService.getAiStatus()
      if (!status.unlocked) {
        return { ok: false, error: captionService.AI_KEY_UNAVAILABLE }
      }
      if (!status.summaryModelConfigured) {
        return {
          ok: false,
          error: 'Executive summary model is not configured (OPENROUTER_SUMMARY_MODEL).',
        }
      }

      const id = Number(buildingId)
      if (!Number.isFinite(id) || id <= 0) {
        return { ok: false, error: 'Invalid building.' }
      }
      const building = db.getBuilding(id)
      if (!building || Number(building.hidden) === 1) {
        return { ok: false, error: 'Property not found.' }
      }

      const assets = db.listBuildingAssets(id)
      const startingWorkspaceEpoch = captionService.getWorkspaceEpoch?.()
      let result
      let generationError
      try {
        result = await captionService.generateExecutiveSummarySection({
          field: String(field ?? ''),
          building,
          assets,
          capitalPlan: db.getBuildingCapitalPlan(id),
        })
      } catch (error) {
        generationError = error
      }
      const workspaceCheck = ensureCurrentWorkspace()
      const endingWorkspaceEpoch = captionService.getWorkspaceEpoch?.()
      const workspaceWasInvalidated =
        startingWorkspaceEpoch != null &&
        endingWorkspaceEpoch != null &&
        startingWorkspaceEpoch !== endingWorkspaceEpoch
      if (workspaceCheck?.changed || workspaceWasInvalidated) {
        return {
          ok: false,
          canceled: true,
          stale: true,
          error:
            'The database changed while the summary was being generated. The old result was discarded.',
        }
      }
      if (generationError) throw generationError
      return result
    },
  )

  handleChannel('project-setup:open', async (event) => {
    loadPage(getWindow(event), 'project-setup.html')
  })

  handleChannel('project-setup:edit', async (event, projectId) => {
    const id = projectId != null ? String(projectId) : ''
    loadPage(getWindow(event), 'project-setup.html', id)
  })

  handleChannel('firm-setup:open', async (event) => {
    loadPage(getWindow(event), 'firm-setup.html')
  })

  handleChannel('settings:open', async (event) => {
    loadPage(getWindow(event), 'settings.html')
  })

  function safeUniformatPricingCsvInfo() {
    try {
      return appSettings.getUniformatPricingCsvInfo()
    } catch {
      return {
        path: null,
        fileName: null,
        sourcePath: null,
        customPath: null,
        isDefault: true,
      }
    }
  }

  // Serialize choose/reload so a focus-triggered reseed cannot interleave with
  // a file-dialog import (dialog close fires window focus while choose still runs).
  let uniformatPricingCsvOp = Promise.resolve()

  function withUniformatPricingCsvLock(fn) {
    const run = uniformatPricingCsvOp.then(fn, fn)
    uniformatPricingCsvOp = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  handleChannel('uniformat-pricing:getCsvPath', () =>
    appSettings.getUniformatPricingCsvInfo(),
  )

  /**
   * Re-read the working CSV from disk and reseed the DB catalogue.
   * Used when Settings opens/regains focus so Explorer edits take effect.
   */
  handleChannel('uniformat-pricing:reloadFromDisk', async (event) => {
    const win = getWindow(event)
    return withUniformatPricingCsvLock(async () => {
      try {
        const csvPath = appSettings.getUniformatPricingCsvPath()
        const records = readUniformatPricingRows(csvPath)
        db.seedUniformatPricingRecords(db.openDatabase(), records)
        return { ok: true, ...appSettings.getUniformatPricingCsvInfo() }
      } catch (err) {
        if (win) {
          await dialog.showMessageBox(win, {
            type: 'error',
            title: 'Invalid Uniformat pricing CSV',
            message: String(err?.message ?? err),
          })
        }
        return {
          ok: false,
          error: String(err?.message ?? err),
          ...safeUniformatPricingCsvInfo(),
        }
      }
    })
  })

  handleChannel('uniformat-pricing:showInFolder', async (event) => {
    const win = getWindow(event)
    try {
      const csvPath = appSettings.getUniformatPricingCsvPath()
      shell.showItemInFolder(csvPath)
      return { ok: true, path: csvPath, ...appSettings.getUniformatPricingCsvInfo() }
    } catch (err) {
      if (win) {
        await dialog.showMessageBox(win, {
          type: 'error',
          title: 'Could not open folder',
          message: String(err?.message ?? err),
        })
      }
      return {
        ok: false,
        error: String(err?.message ?? err),
        ...safeUniformatPricingCsvInfo(),
      }
    }
  })

  handleChannel('app-data:export', async (event) => {
    const win = getWindow(event)
    if (!win) return { canceled: true }

    const result = await dialog.showSaveDialog(win, {
      title: 'Export app data',
      defaultPath: appDataIo.defaultExportFileName(),
      filters: [
        { name: 'Project data', extensions: ['projectdata'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled || !result.filePath) return { canceled: true }

    let destPath = result.filePath
    if (!path.extname(destPath)) destPath = `${destPath}.projectdata`

    try {
      const exported = await appDataIo.exportAppData(destPath, {
        backupDatabaseTo: db.backupDatabaseTo,
      })
      return { canceled: false, filePath: exported.filePath }
    } catch (err) {
      await dialog.showMessageBox(win, {
        type: 'error',
        title: 'Export failed',
        message: String(err?.message ?? err),
      })
      return { canceled: true, error: String(err?.message ?? err) }
    }
  })

  handleChannel('app-data:import', async (event) => {
    const win = getWindow(event)
    if (!win) return { canceled: true }

    const openResult = await dialog.showOpenDialog(win, {
      title: 'Import app data',
      properties: ['openFile'],
      filters: [
        { name: 'Project data', extensions: ['projectdata'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (openResult.canceled || !openResult.filePaths[0]) {
      return { canceled: true }
    }

    const confirm = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Import and replace', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Replace all app data?',
      message:
        'Importing a save file replaces all projects, properties, photos, firm details, and pricing catalogue choice on this computer.',
      detail: 'This cannot be undone. Export a save file first if you want a backup of the current data.',
    })
    if (confirm.response !== 0) return { canceled: true }

    // Numeric ids can be reused by the imported workspace. Cancel before the
    // swap begins so an old HTTP response can never write into a same-id row.
    invalidateWorkspaceState(
      'App data is being replaced — queued AI work was canceled.',
    )

    try {
      await appDataIo.importAppData(openResult.filePaths[0], {
        closeDatabase: db.closeDatabase,
        openDatabase: db.openDatabase,
        getDbPath: db.getDbPath,
      })
      // Reload to home so every renderer view picks up the new data set.
      loadPage(win, 'index.html')
      return { canceled: false }
    } catch (err) {
      // importAppData normally restores and reopens itself. If an unusual error
      // escaped that path, never open SQLite until the durable journal has been
      // resolved — a missing live app.db during swap must not become a fresh DB.
      try {
        if (typeof appDataIo.recoverInterruptedImport === 'function') {
          appDataIo.recoverInterruptedImport({ getDbPath: db.getDbPath })
        }
        db.openDatabase()
      } catch {
        // Surface the import error; startup will retry journal recovery.
      }
      await dialog.showMessageBox(win, {
        type: 'error',
        title: 'Import failed',
        message: String(err?.message ?? err),
      })
      return { canceled: true, error: String(err?.message ?? err) }
    }
  })

  // Settings-only project recovery.
  handleChannel('db:listDeletedProjects', () => db.listDeletedProjects())

  handleChannel('db:restoreDeletedProject', (_event, projectId) => {
    const restored = db.restoreDeletedProject(Number(projectId))
    if (!restored) {
      return {
        ok: false,
        error: 'This deleted project is no longer available to recover.',
      }
    }

    const label = restored.client?.trim() || `Project #${restored.id}`
    undoHistory.push({
      type: 'project-recovery',
      snapshot: restored.snapshot,
      label,
    })
    return { ok: true, id: restored.id, label }
  })

  handleChannel('uniformat-pricing:chooseCsv', async (event) => {
    const win = getWindow(event)
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose Uniformat pricing CSV',
      properties: ['openFile'],
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    })
    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true, ...appSettings.getUniformatPricingCsvInfo() }
    }

    const sourcePath = result.filePaths[0]
    // Hold the lock for the full validate/seed/persist so a concurrent
    // reloadFromDisk (window focus after the dialog closes) cannot reseed the
    // previous working copy over the file that was just chosen.
    return withUniformatPricingCsvLock(async () => {
      try {
        const records = readUniformatPricingRows(sourcePath)
        const database = db.openDatabase()
        appSettings.installUniformatPricingCsv(sourcePath, () => {
          database.transaction(() => {
            db.seedUniformatPricingRecords(database, records)
          })()
        })
        return { canceled: false, ...appSettings.getUniformatPricingCsvInfo() }
      } catch (err) {
        if (win) {
          await dialog.showMessageBox(win, {
            type: 'error',
            title: 'Invalid Uniformat pricing CSV',
            message: String(err?.message ?? err),
          })
        }
        return {
          canceled: true,
          error: String(err?.message ?? err),
          ...appSettings.getUniformatPricingCsvInfo(),
        }
      }
    })
  })

  handleChannel('navigate:home', async (event, opts) => {
    const projectId = Number(opts?.selectProjectId)
    const buildingId = Number(opts?.selectBuildingId)
    let hash = ''
    if (Number.isFinite(projectId) && projectId > 0) {
      hash =
        Number.isFinite(buildingId) && buildingId > 0
          ? `${projectId}:${buildingId}`
          : String(projectId)
    }
    loadPage(getWindow(event), 'index.html', hash)
  })

  handleChannel('building-info:open', async (event, projectId) => {
    const id = projectId != null ? String(projectId) : ''
    loadPage(getWindow(event), 'building-info.html', id)
  })

  handleChannel('building-info:edit', async (event, projectId, buildingId) => {
    const project = Number(projectId)
    const building = Number(buildingId)
    const hash =
      Number.isFinite(project) && project > 0 && Number.isFinite(building) && building > 0
        ? `${project}:${building}`
        : ''
    loadPage(getWindow(event), 'building-info.html', hash)
  })

  handleChannel('executive-summary:edit', async (event, projectId, buildingId) => {
    const project = Number(projectId)
    const building = Number(buildingId)
    const hash =
      Number.isFinite(project) && project > 0 && Number.isFinite(building) && building > 0
        ? `${project}:${building}`
        : ''
    loadPage(getWindow(event), 'executive-summary.html', hash)
  })

  // `buildingIds` is one id or a list — a multi-building report becomes one
  // Word file, a binder of complete per-building reports.
  handleChannel('property-report:open', async (event, projectId, buildingIds) => {
    const project = Number(projectId)
    const buildings = (Array.isArray(buildingIds) ? buildingIds : [buildingIds])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
    const hash =
      Number.isFinite(project) && project > 0 && buildings.length > 0
        ? `${project}:${buildings.join(',')}`
        : ''
    loadPage(getWindow(event), 'property-report.html', hash)
  })

  function normalizeReportRequest(projectId, buildingIds) {
    const project = Number(projectId)
    const buildings = []
    for (const value of Array.isArray(buildingIds) ? buildingIds : [buildingIds]) {
      const id = Number(value)
      if (Number.isFinite(id) && id > 0 && !buildings.includes(id)) buildings.push(id)
    }
    return {
      projectId: Number.isFinite(project) && project > 0 ? project : null,
      buildingIds: buildings,
    }
  }

  // Report data for a set of building ids, in request order (blank buildings
  // dropped). This one snapshot feeds both the Word builder and review panel.
  function collectReportData(projectId, buildingIds) {
    const request = normalizeReportRequest(projectId, buildingIds)
    if (!request.projectId) return []
    return request.buildingIds
      .map((id) => db.getPropertyReportData(request.projectId, id))
      .filter(Boolean)
  }

  function compactReportReview(reports) {
    return reports.map((report) => ({
      project: { client: report?.project?.client ?? null },
      building: {
        id: report?.building?.id ?? null,
        property_name: report?.building?.property_name ?? null,
      },
      validation: report?.validation ?? {
        findings: [],
        errorCount: 0,
        warningCount: 0,
      },
    }))
  }

  function activeReportAiError() {
    return {
      ok: false,
      code: 'AI_ACTIVE',
      waitingForAi: true,
      error:
        'AI is still updating an included property. The Word preview will rebuild when it finishes.',
    }
  }

  // Build the authoritative artifact before anything is displayed. `begin`
  // invalidates an older artifact immediately; `commit` is latest-wins so two
  // AI completion events cannot make the main cache disagree with the page.
  handleChannel('property-report:prepare', async (event, projectId, buildingIds) => {
    const win = getWindow(event)
    if (!win) return { ok: false, code: 'NO_WINDOW', error: 'The report window closed.' }

    const previewId = preparedReportArtifacts.begin(win)
    reportExportCapabilities.revoke(win)
    const request = normalizeReportRequest(projectId, buildingIds)
    const reports = collectReportData(request.projectId, request.buildingIds)
    if (reports.length === 0) {
      return {
        ok: false,
        code: 'NO_REPORT_DATA',
        error: 'No report data was available for the selected properties.',
      }
    }

    if (findRelevantReportAiJob(captionService.getAiStatus(), reports)) {
      return activeReportAiError()
    }

    const fingerprint = fingerprintReportSnapshot(reports)
    if (!win.isDestroyed()) {
      win.webContents.send('report:export-phase', 'Building the Word preview…')
    }

    let buffer
    try {
      buffer = await buildReportDocxBuffer({
        project: reports[0].project,
        firm: reports[0].firm,
        reports,
      })
    } catch (error) {
      return {
        ok: false,
        code: 'BUILD_FAILED',
        error: error?.message || 'The Word document could not be built.',
      }
    }

    if (win.isDestroyed()) {
      preparedReportArtifacts.revoke(win)
      return { ok: false, code: 'NO_WINDOW', error: 'The report window closed.' }
    }

    // The builder awaits ZIP packing, so database writes and AI completion can
    // run before it resolves. Re-read and reject that obsolete artifact rather
    // than showing bytes made from a snapshot that is no longer current.
    const currentReports = collectReportData(request.projectId, request.buildingIds)
    if (findRelevantReportAiJob(captionService.getAiStatus(), currentReports)) {
      return activeReportAiError()
    }
    if (fingerprintReportSnapshot(currentReports) !== fingerprint) {
      return {
        ok: false,
        code: 'SNAPSHOT_CHANGED',
        retry: true,
        error: 'Report data changed while the Word preview was being built.',
      }
    }

    const errorCount = reports.reduce(
      (total, report) => total + Number(report?.validation?.errorCount ?? 0),
      0,
    )
    const committed = preparedReportArtifacts.commit(win, previewId, {
      buffer,
      projectId: request.projectId,
      buildingIds: request.buildingIds,
      fingerprint,
      validationErrorCount: errorCount,
    })
    if (!committed) {
      return {
        ok: false,
        code: 'SUPERSEDED',
        superseded: true,
        error: 'A newer Word preview replaced this build.',
      }
    }

    const artifact = preparedReportArtifacts.resolve(win, previewId)
    return {
      ok: true,
      previewId,
      // Copy only the committed artifact across IPC. These are therefore the
      // same bytes the save handler later writes, not the builder's old buffer.
      docxBytes: Uint8Array.from(artifact.buffer),
      reviewReports: compactReportReview(reports),
      requestedCount: request.buildingIds.length,
    }
  })

  // The save location is selected only after the Word artifact exists, so
  // canceling leaves the reviewed preview intact and nothing half-written.
  handleChannel('property-report:chooseExportPath', async (event, suggestedName) => {
    const win = getWindow(event)
    if (!win) return { canceled: true }
    const choice = {}
    reportExportChoices.set(win, choice)
    reportExportCapabilities.revoke(win)

    // Automation hook: no driver can dismiss an OS dialog. See docs/ui-driver.md.
    const autoDocx = process.env.CONDITION_ASSESSMENT_AUTO_DOCX
    if (typeof autoDocx === 'string' && autoDocx.trim()) {
      const docxPath = path.resolve(autoDocx.trim())
      fs.mkdirSync(path.dirname(docxPath), { recursive: true })
      if (reportExportChoices.get(win) !== choice) return { canceled: true }
      reportExportChoices.delete(win)
      return {
        canceled: false,
        exportId: reportExportCapabilities.issue(win, docxPath),
      }
    }

    const result = await dialog.showSaveDialog(win, {
      title: 'Save the property report',
      defaultPath: suggestedName || 'property-condition-assessment.docx',
      filters: [{ name: 'Word Document', extensions: ['docx'] }],
    })
    if (reportExportChoices.get(win) !== choice) return { canceled: true }
    reportExportChoices.delete(win)
    if (result.canceled || !result.filePath) return { canceled: true }
    if (win.isDestroyed()) return { canceled: true }
    return {
      canceled: false,
      exportId: reportExportCapabilities.issue(win, result.filePath),
    }
  })

  // Resolve the exact sender-bound bytes that produced the preview, then
  // consume the opaque destination authorization. The renderer can supply
  // neither arbitrary report ids nor a filesystem path at this boundary.
  handleChannel(
    'property-report:export',
    async (event, previewId, exportId, options = {}) => {
      const win = getWindow(event)
      if (!win) return { canceled: true }
      const artifact = preparedReportArtifacts.resolve(win, previewId)
      if (!artifact) {
        return {
          canceled: false,
          code: 'STALE_PREVIEW',
          error: 'This Word preview is no longer current. Rebuild it before saving.',
        }
      }

      const currentReports = collectReportData(
        artifact.projectId,
        artifact.buildingIds,
      )
      if (findRelevantReportAiJob(captionService.getAiStatus(), currentReports)) {
        return { canceled: false, ...activeReportAiError() }
      }
      if (
        fingerprintReportSnapshot(currentReports) !== artifact.fingerprint
      ) {
        return {
          canceled: false,
          code: 'STALE_PREVIEW',
          error: 'Report data changed after this Word preview was built. Rebuild it before saving.',
        }
      }
      if (
        artifact.validationErrorCount > 0 &&
        options?.allowValidationErrors !== true
      ) {
        return {
          canceled: false,
          code: 'VALIDATION_BLOCKED',
          error: 'The pre-export review still contains errors.',
        }
      }

      const docxPath = reportExportCapabilities.consume(win, exportId)
      if (!docxPath) {
        return {
          canceled: true,
          error: 'The save selection is missing or has already been used.',
        }
      }

      if (!win.isDestroyed()) {
        win.webContents.send('report:export-phase', 'Saving the reviewed Word document…')
      }

      try {
        writeReportFileAtomically(docxPath, artifact.buffer)
      } catch (error) {
        return {
          canceled: false,
          docxPath: null,
          code: 'WRITE_FAILED',
          error: error?.message || 'The Word file could not be saved.',
        }
      }
      return { canceled: false, docxPath }
    },
  )

  // Import a client BCA Excel workbook into the selected project. One handler
  // runs the whole flow with native dialogs (matching app-data:import): pick a
  // file, parse it, show a preview + choose how to apply, commit, and report.
  // The heavy libs are required lazily so they stay out of the startup path.
  // See src/lib/bca-workbook.js, src/import-bca.js, and docs/excel-import.md.
  handleChannel('bca:import', async (event, projectId) => {
    const win = getWindow(event)
    if (!win) return { canceled: true }
    const id = Number(projectId)
    if (!Number.isFinite(id) || id <= 0) {
      return { canceled: true, error: 'Choose a project before importing.' }
    }

    // Automation hook, mirroring CONDITION_ASSESSMENT_AUTO_DOCX: a preset file
    // path skips the native open dialog and CONDITION_ASSESSMENT_AUTO_IMPORT_MODE
    // skips the New/Update prompt — no driver can dismiss an OS dialog, so this
    // is how the UI-driver import scenario exercises the real handler. See
    // docs/ui-driver.md and docs/excel-import.md.
    const autoImportPath = process.env.CONDITION_ASSESSMENT_AUTO_IMPORT
    const isAutoImport = typeof autoImportPath === 'string' && autoImportPath.trim() !== ''

    /*
     * Reading a ~4 MB workbook and committing thousands of rows both block the
     * main process for seconds, so the window stops repainting and looks hung.
     * Tell the renderer when real work starts and stops so it can own the screen
     * with a modal, the way the report export and bulk AI do.
     *
     * `null` clears it — sent before every native dialog, so the user is never
     * answering a question with a "working…" overlay behind it.
     */
    const phase = (label) => {
      if (win.isDestroyed()) return
      win.webContents.send('bca:import-phase', label)
      setBusyTask(label ? 'Excel import' : null)
    }

    try {
      let filePath
      if (isAutoImport) {
        filePath = path.resolve(autoImportPath.trim())
      } else {
        const open = await dialog.showOpenDialog(win, {
          title: 'Import BCA workbook',
          properties: ['openFile'],
          filters: [{ name: 'Excel workbook', extensions: ['xlsx', 'xlsm', 'xls'] }],
        })
        if (open.canceled || !open.filePaths?.[0]) return { canceled: true }
        filePath = open.filePaths[0]
      }

      const XLSX = require('xlsx')
      const { parseBcaWorkbook } = require('../lib/bca-workbook')
      const { previewImport, applyImport } = require('../import-bca')

      let parsed
      phase('Reading the workbook…')
      try {
        // Only the two sheets the parser reads — the sample is ~4 MB / 18 sheets.
        const workbook = XLSX.readFile(filePath, { sheets: ['Worksheet', 'Legend'] })
        parsed = parseBcaWorkbook(workbook)
      } catch (err) {
        phase(null)
        await dialog.showMessageBox(win, {
          type: 'error',
          title: 'Could not read workbook',
          message: 'The Excel file could not be read.',
          detail: String(err?.message ?? err),
        })
        return { canceled: true, error: String(err?.message ?? err) }
      }

      if (parsed.errors.length > 0) {
        phase(null)
        const detail = parsed.errors.slice(0, 12).map((e) => e.message).join('\n')
        await dialog.showMessageBox(win, {
          type: 'error',
          title: 'Workbook cannot be imported',
          message: `The workbook has ${parsed.errors.length} problem(s) that must be fixed first.`,
          detail: parsed.errors.length > 12 ? `${detail}\n…and ${parsed.errors.length - 12} more.` : detail,
        })
        return { canceled: true, error: 'workbook_errors' }
      }
      if (parsed.rows.length === 0) {
        phase(null)
        await dialog.showMessageBox(win, {
          type: 'warning',
          title: 'Nothing to import',
          message: 'No asset rows were found in the workbook’s "Worksheet" sheet.',
        })
        return { canceled: true }
      }

      const database = db.openDatabase()

      let mode
      if (isAutoImport) {
        mode = process.env.CONDITION_ASSESSMENT_AUTO_IMPORT_MODE === 'update' ? 'update' : 'new'
      } else {
        phase('Checking the workbook against this project…')
        const preview = previewImport({ database, parsed, projectId: id })
        const t = preview.totals
        const detailLines = [
          `Buildings: ${t.buildings} (${t.newBuildings} new)`,
          `New assets: ${t.newAssets}`,
          `Existing assets that would be updated: ${t.updateAssets}`,
        ]
        if (t.unresolved > 0) detailLines.push(`Rows with no catalogue match (skipped): ${t.unresolved}`)
        if ((parsed.warnings?.length ?? 0) > 0) detailLines.push(`Warnings: ${parsed.warnings.length}`)
        // Any missing column here is optional (a required one would have errored
        // out above) — surface renamed/absent optional columns so a changed
        // template is visible before committing.
        if ((parsed.missingColumns?.length ?? 0) > 0) {
          const cols = parsed.missingColumns
            .map((c) => `${c.column} (“${c.expected}” — found “${c.found}”)`)
            .join(', ')
          detailLines.push(`Optional columns missing/renamed (imported blank): ${cols}`)
        }

        phase(null)
        const choice = await dialog.showMessageBox(win, {
          type: 'question',
          title: 'Import BCA workbook',
          message: `Import ${parsed.rows.length} rows from ${path.basename(filePath)}?`,
          detail: `${detailLines.join('\n')}\n\nChoose how to apply the import:`,
          buttons: ['Add new only', 'Update existing + add new', 'Cancel'],
          defaultId: 0,
          cancelId: 2,
        })
        if (choice.response === 2) {
          phase(null)
          return { canceled: true }
        }
        mode = choice.response === 1 ? 'update' : 'new'
      }

      let result
      phase(`Importing ${parsed.rows.length} rows…`)
      try {
        result = applyImport({ database, parsed, projectId: id, mode })
      } catch (err) {
        phase(null)
        // Under the automation hook there is nobody to dismiss a native dialog,
        // and a driver cannot see one — an import that failed here looked
        // exactly like one that silently did nothing. Return the error instead
        // and let the renderer surface it; the UI path still gets the dialog.
        if (!isAutoImport) {
          await dialog.showMessageBox(win, {
            type: 'error',
            title: 'Import failed',
            message: 'The import could not be completed.',
            detail: String(err?.message ?? err),
          })
        }
        return { canceled: true, error: String(err?.message ?? err) }
      }
      phase(null)

      return {
        canceled: false,
        projectId: id,
        mode,
        summary: result.summary,
        buildingIds: result.buildingIds,
      }
    } finally {
      // Never strand the busy lock. Anything throwing above — a preview that
      // hits bad data, a database error — would otherwise leave the app
      // locked against navigation and quit with no way back.
      phase(null)
    }
  })

  handleChannel('db:ensureCurrent', () => {
    return ensureCurrentWorkspace()
  })

  handleChannel('db:listProjects', () => db.listProjects())

  handleChannel('db:getProject', (_event, projectId) =>
    db.getProject(Number(projectId)),
  )

  handleChannel('db:getFirm', () => db.getFirm())

  handleChannel('db:updateFirm', (_event, payload) => {
    const before = db.firmFieldsSnapshot(db.getFirm())
    const result = db.updateFirm(payload ?? {})
    if (before && !db.firmPayloadEqualsSnapshot(result, before)) {
      undoHistory.pushFirmUpdate(before)
    }
    return result
  })

  handleChannel('firm-logo:import', async (event) => {
    const result = await dialog.showOpenDialog(getWindow(event), {
      title: 'Choose firm logo',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] },
      ],
    })
    if (result.canceled || !result.filePaths[0]) return db.getFirm()

    const before = db.firmFieldsSnapshot(db.getFirm())
    const sourcePath = result.filePaths[0]
    const firm = db.updateFirm({
      ...db.getFirm(),
      logo_path: copyFirmLogo(sourcePath),
      logo_original_name: path.basename(sourcePath),
    })
    if (before && !db.firmPayloadEqualsSnapshot(firm, before)) {
      undoHistory.pushFirmUpdate(before)
    }
    return firm
  })

  handleChannel('db:listBuildings', (_event, projectId) =>
    db.listBuildings(Number(projectId)),
  )

  handleChannel('db:listUniformatLevel1Groups', () =>
    db.listUniformatLevel1Groups(),
  )

  handleChannel('db:listUniformatLevel2Groups', (_event, level1GroupName) =>
    db.listUniformatLevel2Groups(String(level1GroupName ?? '')),
  )

  handleChannel(
    'db:listUniformatLevel3Groups',
    (_event, level1GroupName, level2Code) =>
      db.listUniformatLevel3Groups(
        String(level1GroupName ?? ''),
        String(level2Code ?? ''),
      ),
  )

  handleChannel(
    'db:listUniformatLevel4Groups',
    (_event, level1GroupName, level2Code, level3Code) =>
      db.listUniformatLevel4Groups(
        String(level1GroupName ?? ''),
        String(level2Code ?? ''),
        String(level3Code ?? ''),
      ),
  )

  handleChannel(
    'db:listUniformatPricingItems',
    (_event, level1GroupName, level2Code, level3Code, level4Code) =>
      db.listUniformatPricingItems(
        String(level1GroupName ?? ''),
        String(level2Code ?? ''),
        String(level3Code ?? ''),
        String(level4Code ?? ''),
      ),
  )

  handleChannel('db:getBuilding', (_event, buildingId) =>
    db.getBuilding(Number(buildingId)),
  )

  handleChannel('db:createBuilding', (_event, payload) => {
    const result = db.createBuilding(payload)
    undoHistory.clearRedo()
    return result
  })

  handleChannel('db:updateBuilding', (_event, buildingId, payload) => {
    const id = Number(buildingId)
    const beforeRow = db.getBuilding(id)
    const before = db.buildingFieldsSnapshot(beforeRow)
    const projectId =
      beforeRow?.project_id != null ? Number(beforeRow.project_id) || null : null
    const result = db.updateBuilding(id, payload ?? {})
    if (before && !db.buildingPayloadEqualsSnapshot(payload ?? {}, before)) {
      undoHistory.pushBuildingUpdate(id, before, { projectId })
    }
    return result
  })

  handleChannel('db:listLocationFactors', () => db.listLocationFactors())

  handleChannel('db:previewAssetPlan', (_event, assetId, formValues) =>
    db.previewAssetPlan(assetId, formValues),
  )

  handleChannel('db:getExecutiveSummary', (_event, buildingId) =>
    db.getExecutiveSummary(Number(buildingId)),
  )

  handleChannel('db:updateExecutiveSummary', (_event, buildingId, payload) => {
    const id = Number(buildingId)
    const before = db.executiveSummaryFieldsSnapshot(db.getExecutiveSummary(id))
    const projectId = Number(db.getBuilding(id)?.project_id) || null
    const result = db.updateExecutiveSummary(id, payload ?? {})
    if (
      before &&
      !db.executiveSummaryPayloadEqualsSnapshot(payload ?? {}, before)
    ) {
      undoHistory.pushExecutiveSummaryUpdate(id, before, { projectId })
    }
    return result
  })

  handleChannel('db:getPropertyReportData', (_event, projectId, buildingId) =>
    db.getPropertyReportData(Number(projectId), Number(buildingId)),
  )

  handleChannel('db:listBuildingImages', (_event, buildingId) =>
    db.listBuildingImages(Number(buildingId)),
  )

  handleChannel('property-images:import', async (event, buildingId) => {
    const id = Number(buildingId)
    if (!Number.isFinite(id) || id <= 0) return []
    const result = await dialog.showOpenDialog(getWindow(event), {
      title: 'Add property images',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] },
      ],
    })
    if (result.canceled) return db.listBuildingImages(id)

    const sortOffset = db.listBuildingImages(id).length
    const building = db.getBuilding(id)
    const captionJobs = []
    for (const [index, sourcePath] of result.filePaths.entries()) {
      const targetPath = copyBuildingImage(id, sourcePath)
      const created = db.createBuildingImage({
        building_id: id,
        file_path: targetPath,
        original_name: path.basename(sourcePath),
        sort_order: sortOffset + index,
      })
      captionJobs.push({
        kind: 'building',
        imageId: created.id,
        buildingId: id,
        filePath: targetPath,
        context: {
          propertyName: building?.property_name ?? null,
          address: [
            building?.address,
            building?.city,
            building?.province_short || building?.province,
            building?.postal_code,
          ]
            .filter(Boolean)
            .join(', '),
        },
      })
    }
    undoHistory.clearRedo()
    captionService.enqueueCaptionJobs(captionJobs)
    return db.listBuildingImages(id)
  })

  handleChannel('db:listAssets', (_event, buildingId, level1GroupName) =>
    db.listBuildingAssets(Number(buildingId), String(level1GroupName ?? '')),
  )

  handleChannel('db:createAsset', (_event, buildingId, level1GroupName) => {
    const result = db.createAsset(Number(buildingId), String(level1GroupName ?? ''))
    undoHistory.clearRedo()
    return result
  })

  handleChannel('db:updateAsset', (_event, assetId, payload) => {
    const id = Number(assetId)
    const beforeRow = db.getAssetRow(id)
    const before = db.assetFieldsSnapshot(beforeRow)
    const buildingId =
      beforeRow?.building_id != null ? Number(beforeRow.building_id) : null
    const projectId =
      buildingId != null ? Number(db.getBuilding(buildingId)?.project_id) || null : null
    const result = db.updateAsset(id, payload ?? {})
    if (before && !db.assetPayloadEqualsSnapshot(payload ?? {}, before)) {
      undoHistory.pushAssetUpdate(id, before, {
        buildingId,
        projectId,
        level1Group: db.getLevel1GroupForPricingId(before.uniformat_pricing_id),
      })
    }
    return result
  })

  handleChannel('db:listAssetImages', (_event, assetId) =>
    db.listAssetImages(Number(assetId)),
  )

  handleChannel('asset-images:import', async (event, assetId) => {
    const id = Number(assetId)
    if (!Number.isFinite(id) || id <= 0) return []
    const result = await dialog.showOpenDialog(getWindow(event), {
      title: 'Add asset images',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] },
      ],
    })
    if (result.canceled) return []

    const sortOffset = db.listAssetImages(id).length
    const assetRow = db.getAssetRow(id)
    const building =
      assetRow?.building_id != null ? db.getBuilding(Number(assetRow.building_id)) : null
    const level1Group = db.getAssetLevel1GroupName(id)
    const captionJobs = []
    for (const [index, sourcePath] of result.filePaths.entries()) {
      const targetPath = copyAssetImage(id, sourcePath)
      const created = db.createAssetImage({
        asset_id: id,
        file_path: targetPath,
        original_name: path.basename(sourcePath),
        sort_order: sortOffset + index,
      })
      captionJobs.push({
        kind: 'asset',
        imageId: created.id,
        assetId: id,
        buildingId: assetRow?.building_id != null ? Number(assetRow.building_id) : null,
        filePath: targetPath,
        context: {
          propertyName: building?.property_name ?? null,
          assetName: assetRow?.asset_name ?? null,
          condition: assetRow?.condition_rating ?? null,
          level1Group: level1Group ?? null,
        },
      })
    }
    undoHistory.clearRedo()
    captionService.enqueueCaptionJobs(captionJobs)
    return db.listAssetImages(id)
  })

  handleChannel('db:createProject', (_event, payload) => {
    const result = db.createProject(payload)
    undoHistory.clearRedo()
    return result
  })

  handleChannel('db:updateProject', (_event, projectId, payload) => {
    const id = Number(projectId)
    const before = db.projectFieldsSnapshot(db.getProject(id))
    const result = db.updateProject(id, payload ?? {})
    if (before && !db.projectPayloadEqualsSnapshot(payload ?? {}, before)) {
      undoHistory.pushProjectUpdate(id, before)
    }
    return result
  })

  handleChannel('db:deleteProject', async (event, projectId) => {
    const id = Number(projectId)
    const project = db.getProject(id)
    const label = project?.client ? `project "${project.client}"` : `project #${id}`
    if (!(await confirmDelete(event, `Delete ${label} and all its properties, assets, and photos?`))) {
      return { canceled: true }
    }
    const snapshot = db.deleteProject(id)
    if (snapshot) {
      undoHistory.push({
        type: 'project-delete',
        snapshot,
        label: project?.client?.trim() || `Project #${id}`,
      })
    }
    return { canceled: false }
  })

  handleChannel('db:deleteBuilding', async (event, buildingId) => {
    const id = Number(buildingId)
    const building = db.getBuilding(id)
    const label = building?.property_name ? `"${building.property_name}"` : `property #${id}`
    if (!(await confirmDelete(event, `Delete property ${label} and all its assets, photos, and executive summary?`))) {
      return { canceled: true }
    }
    const snapshot = db.captureBuildingDeleteSnapshot(id)
    db.deleteBuilding(id)
    if (snapshot) {
      undoHistory.push({
        type: 'building-delete',
        snapshot,
        label: building?.property_name?.trim() || `Property #${id}`,
      })
    }
    return { canceled: false }
  })

  handleChannel('db:deleteAsset', async (event, assetId) => {
    const id = Number(assetId)
    if (!(await confirmDelete(event, 'Delete this asset and all its photos?'))) {
      return { canceled: true }
    }
    const row = db.getAssetRow(id)
    if (!row || Number(row.hidden) === 1) {
      return { canceled: false }
    }
    const imageIds = db.getVisibleAssetImageIds(id)
    const label = row.asset_name?.trim() || `Asset #${id}`
    const level1Group = db.getAssetLevel1GroupName(id)
    const buildingId = row.building_id != null ? Number(row.building_id) : null
    const projectId =
      buildingId != null ? Number(db.getBuilding(buildingId)?.project_id) || null : null
    db.deleteAsset(id)
    undoHistory.push({
      type: 'asset-delete',
      assetId: id,
      buildingId,
      projectId,
      level1Group,
      imageIds,
      label,
    })
    return { canceled: false }
  })

  handleChannel('db:deleteBuildingImage', async (event, imageId) => {
    const id = Number(imageId)
    if (!(await confirmDelete(event, 'Delete this property photo?'))) {
      return { canceled: true }
    }
    const row = db.getBuildingImageRow(id)
    db.deleteBuildingImage(id)
    if (row && Number(row.hidden) === 0) {
      undoHistory.push({
        type: 'building-image-delete',
        imageId: id,
        buildingId: Number(row.building_id),
        label: row.original_name || row.caption || `Photo #${id}`,
      })
    }
    return { canceled: false }
  })

  handleChannel('db:deleteAssetImage', async (event, imageId) => {
    const id = Number(imageId)
    if (!(await confirmDelete(event, 'Delete this asset photo?'))) {
      return { canceled: true }
    }
    const row = db.getAssetImageRow(id)
    db.deleteAssetImage(id)
    if (row && Number(row.hidden) === 0) {
      const assetRow = db.getAssetRow(row.asset_id)
      const buildingId =
        assetRow?.building_id != null ? Number(assetRow.building_id) : null
      const projectId =
        buildingId != null ? Number(db.getBuilding(buildingId)?.project_id) || null : null
      undoHistory.push({
        type: 'asset-image-delete',
        imageId: id,
        assetId: Number(row.asset_id),
        buildingId,
        projectId,
        level1Group: assetRow
          ? db.getLevel1GroupForPricingId(assetRow.uniformat_pricing_id)
          : null,
        label: row.original_name || row.caption || `Photo #${id}`,
      })
    }
    return { canceled: false }
  })

  handleChannel('db:deleteExecutiveSummary', async (event, buildingId) => {
    const id = Number(buildingId)
    if (!(await confirmDelete(event, 'Clear the executive summary for this property?'))) {
      return { canceled: true }
    }
    const row = db.getExecutiveSummaryRow(id)
    const wasVisible = Boolean(row && Number(row.hidden) === 0)
    db.deleteExecutiveSummary(id)
    if (wasVisible) {
      undoHistory.push({
        type: 'executive-summary-delete',
        buildingId: id,
        label: `Property #${id}`,
      })
    }
    return { canceled: false }
  })

  /**
   * Build the standard success payload shared by undo and redo responses.
   * @param {object} entry
   * @param {{ undone?: boolean, redone?: boolean, message: string, notify?: string, level1Group?: string|null, label?: string }} extra
   */
  function historySuccess(entry, extra) {
    const base = {
      type: entry.type,
      assetId: entry.assetId ?? null,
      buildingId:
        entry.buildingId ??
        entry.snapshot?.buildingId ??
        null,
      projectId:
        entry.projectId ??
        entry.snapshot?.projectId ??
        null,
      imageId: entry.imageId ?? null,
      level1Group: extra.level1Group ?? entry.level1Group ?? null,
      label: extra.label ?? entry.label ?? null,
      message: extra.message,
    }
    if (extra.notify) base.notify = extra.notify
    if (extra.undone) base.undone = true
    if (extra.redone) base.redone = true
    return base
  }

  /**
   * Undo the most recent recorded edit or delete.
   * Asset-delete undos show a blocking info dialog so restoration is never silent.
   * On failure the entry is requeued so the step is not lost.
   * Successful undos move the entry onto the redo stack.
   */
  handleChannel('history:undo', async (event) => {
    const win = getWindow(event)
    ensureCurrentWorkspace()
    const entry = undoHistory.pop()
    if (!entry) {
      return { undone: false, empty: true }
    }

    const putBack = () => {
      undoHistory.requeue(entry)
    }

    try {
      switch (entry.type) {
        case 'asset-update': {
          // Capture current values so redo can re-apply the undone edit.
          // Without an after-snapshot the step is not redoable — fail closed.
          const after = db.assetFieldsSnapshot(db.getAssetRow(entry.assetId))
          if (!after) {
            putBack()
            return {
              undone: false,
              error: 'Cannot undo asset edit: asset is missing.',
              type: entry.type,
            }
          }
          entry.after = after
          db.updateAsset(entry.assetId, entry.before)
          const name = entry.before?.asset_name?.trim() || `Asset #${entry.assetId}`
          const level1Group =
            entry.level1Group ??
            db.getLevel1GroupForPricingId(entry.before?.uniformat_pricing_id)
          undoHistory.pushRedo(entry)
          return historySuccess(entry, {
            undone: true,
            level1Group,
            message: `Undid edits to ${name}.`,
          })
        }
        case 'building-update': {
          const after = db.buildingFieldsSnapshot(db.getBuilding(entry.buildingId))
          if (!after) {
            putBack()
            return {
              undone: false,
              error: 'Cannot undo property edit: property is missing.',
              type: entry.type,
            }
          }
          entry.after = after
          db.updateBuilding(entry.buildingId, entry.before)
          const name =
            entry.before?.property_name?.trim() || `Property #${entry.buildingId}`
          undoHistory.pushRedo(entry)
          return historySuccess(entry, {
            undone: true,
            message: `Undid edits to ${name}.`,
          })
        }
        case 'project-update': {
          const after = db.projectFieldsSnapshot(db.getProject(entry.projectId))
          if (!after) {
            putBack()
            return {
              undone: false,
              error: 'Cannot undo project edit: project is missing.',
              type: entry.type,
            }
          }
          entry.after = after
          db.updateProject(entry.projectId, entry.before)
          const name = entry.before?.client?.trim() || `Project #${entry.projectId}`
          undoHistory.pushRedo(entry)
          return historySuccess(entry, {
            undone: true,
            message: `Undid edits to ${name}.`,
          })
        }
        case 'executive-summary-update': {
          const after = db.executiveSummaryFieldsSnapshot(
            db.getExecutiveSummary(entry.buildingId),
          )
          if (!after) {
            putBack()
            return {
              undone: false,
              error: 'Cannot undo executive summary edit.',
              type: entry.type,
            }
          }
          entry.after = after
          db.updateExecutiveSummary(entry.buildingId, entry.before)
          undoHistory.pushRedo(entry)
          return historySuccess(entry, {
            undone: true,
            message: 'Undid executive summary edits.',
          })
        }
        case 'firm-update': {
          const after = db.firmFieldsSnapshot(db.getFirm())
          if (!after) {
            putBack()
            return {
              undone: false,
              error: 'Cannot undo firm edit.',
              type: entry.type,
            }
          }
          entry.after = after
          db.updateFirm(entry.before)
          undoHistory.pushRedo(entry)
          return historySuccess(entry, {
            undone: true,
            message: 'Undid firm details edits.',
          })
        }
        case 'asset-delete': {
          db.restoreAssetVisibility(entry.assetId, entry.imageIds ?? [])
          const label = entry.label || `Asset #${entry.assetId}`
          const level1Group =
            entry.level1Group ?? db.getAssetLevel1GroupName(entry.assetId)
          if (win) {
            await dialog.showMessageBox(win, {
              type: 'info',
              buttons: ['OK'],
              defaultId: 0,
              title: 'Asset restored',
              message: `You undid the deletion of “${label}”.`,
              detail: 'The asset and its photos are back in the workspace.',
            })
          }
          undoHistory.pushRedo(entry)
          return historySuccess(entry, {
            undone: true,
            level1Group,
            label,
            message: `Restored deleted asset “${label}”.`,
            notify: 'dialog',
          })
        }
        case 'asset-image-delete': {
          db.restoreImageVisibility('asset_image', entry.imageId)
          const level1Group =
            entry.level1Group ??
            (entry.assetId != null ? db.getAssetLevel1GroupName(entry.assetId) : null)
          undoHistory.pushRedo(entry)
          return historySuccess(entry, {
            undone: true,
            level1Group,
            message: `Restored deleted asset photo “${entry.label}”.`,
          })
        }
        case 'building-image-delete': {
          db.restoreImageVisibility('building_image', entry.imageId)
          undoHistory.pushRedo(entry)
          return historySuccess(entry, {
            undone: true,
            message: `Restored deleted property photo “${entry.label}”.`,
          })
        }
        case 'building-delete': {
          db.restoreBuildingDeleteSnapshot(entry.snapshot)
          undoHistory.pushRedo(entry)
          return historySuccess(entry, {
            undone: true,
            message: `Restored deleted property “${entry.label}”.`,
          })
        }
        case 'project-delete': {
          db.restoreProjectDeleteSnapshot(entry.snapshot)
          undoHistory.pushRedo(entry)
          return historySuccess(entry, {
            undone: true,
            message: `Restored deleted project “${entry.label}”.`,
          })
        }
        case 'project-recovery': {
          const projectId = entry.snapshot?.projectId
          // Re-capture instead of reusing the original snapshot: a new asset or
          // property may have been added after recovery, and undo must not make
          // that later work disappear on the next redo.
          const snapshot = projectId == null ? null : db.deleteProject(projectId)
          if (!snapshot) {
            putBack()
            return { undone: false, error: 'Cannot undo project recovery: project is missing.' }
          }
          entry.snapshot = snapshot
          undoHistory.pushRedo(entry)
          return historySuccess(entry, {
            undone: true,
            message: `Undid recovery of project “${entry.label}”.`,
          })
        }
        case 'executive-summary-delete': {
          db.restoreExecutiveSummaryVisibility(entry.buildingId)
          undoHistory.pushRedo(entry)
          return historySuccess(entry, {
            undone: true,
            message: 'Restored the cleared executive summary.',
          })
        }
        default:
          putBack()
          return {
            undone: false,
            error: `Unknown undo entry type: ${entry.type}`,
          }
      }
    } catch (err) {
      putBack()
      return {
        undone: false,
        error: String(err?.message ?? err),
        type: entry.type,
      }
    }
  })

  /**
   * Redo the most recently undone edit or delete.
   * On failure the entry is requeued on the redo stack so the step is not lost.
   * Successful redos move the entry back onto the undo stack.
   */
  handleChannel('history:redo', async () => {
    ensureCurrentWorkspace()
    const entry = undoHistory.popRedo()
    if (!entry) {
      return { redone: false, empty: true }
    }

    const putBack = () => {
      undoHistory.requeueRedo(entry)
    }

    try {
      switch (entry.type) {
        case 'asset-update': {
          if (!entry.after) {
            putBack()
            return {
              redone: false,
              error: 'Cannot redo asset edit: missing after-snapshot.',
            }
          }
          db.updateAsset(entry.assetId, entry.after)
          const name =
            entry.after?.asset_name?.trim() ||
            entry.before?.asset_name?.trim() ||
            `Asset #${entry.assetId}`
          const level1Group =
            entry.level1Group ??
            db.getLevel1GroupForPricingId(entry.after?.uniformat_pricing_id) ??
            db.getLevel1GroupForPricingId(entry.before?.uniformat_pricing_id)
          undoHistory.requeue(entry)
          return historySuccess(entry, {
            redone: true,
            level1Group,
            message: `Redid edits to ${name}.`,
          })
        }
        case 'building-update': {
          if (!entry.after) {
            putBack()
            return {
              redone: false,
              error: 'Cannot redo property edit: missing after-snapshot.',
            }
          }
          db.updateBuilding(entry.buildingId, entry.after)
          const name =
            entry.after?.property_name?.trim() ||
            entry.before?.property_name?.trim() ||
            `Property #${entry.buildingId}`
          undoHistory.requeue(entry)
          return historySuccess(entry, {
            redone: true,
            message: `Redid edits to ${name}.`,
          })
        }
        case 'project-update': {
          if (!entry.after) {
            putBack()
            return {
              redone: false,
              error: 'Cannot redo project edit: missing after-snapshot.',
            }
          }
          db.updateProject(entry.projectId, entry.after)
          const name =
            entry.after?.client?.trim() ||
            entry.before?.client?.trim() ||
            `Project #${entry.projectId}`
          undoHistory.requeue(entry)
          return historySuccess(entry, {
            redone: true,
            message: `Redid edits to ${name}.`,
          })
        }
        case 'executive-summary-update': {
          if (!entry.after) {
            putBack()
            return {
              redone: false,
              error: 'Cannot redo executive summary edit: missing after-snapshot.',
            }
          }
          db.updateExecutiveSummary(entry.buildingId, entry.after)
          undoHistory.requeue(entry)
          return historySuccess(entry, {
            redone: true,
            message: 'Redid executive summary edits.',
          })
        }
        case 'firm-update': {
          if (!entry.after) {
            putBack()
            return {
              redone: false,
              error: 'Cannot redo firm edit: missing after-snapshot.',
            }
          }
          db.updateFirm(entry.after)
          undoHistory.requeue(entry)
          return historySuccess(entry, {
            redone: true,
            message: 'Redid firm details edits.',
          })
        }
        case 'asset-delete': {
          db.deleteAsset(entry.assetId)
          const label = entry.label || `Asset #${entry.assetId}`
          const level1Group =
            entry.level1Group ?? db.getAssetLevel1GroupName(entry.assetId)
          undoHistory.requeue(entry)
          return historySuccess(entry, {
            redone: true,
            level1Group,
            label,
            message: `Re-deleted asset “${label}”.`,
          })
        }
        case 'asset-image-delete': {
          db.deleteAssetImage(entry.imageId)
          const level1Group =
            entry.level1Group ??
            (entry.assetId != null ? db.getAssetLevel1GroupName(entry.assetId) : null)
          undoHistory.requeue(entry)
          return historySuccess(entry, {
            redone: true,
            level1Group,
            message: `Re-deleted asset photo “${entry.label}”.`,
          })
        }
        case 'building-image-delete': {
          db.deleteBuildingImage(entry.imageId)
          undoHistory.requeue(entry)
          return historySuccess(entry, {
            redone: true,
            message: `Re-deleted property photo “${entry.label}”.`,
          })
        }
        case 'building-delete': {
          const buildingId = entry.snapshot?.buildingId
          if (buildingId == null) {
            putBack()
            return { redone: false, error: 'Cannot redo property delete: missing snapshot.' }
          }
          db.deleteBuilding(buildingId)
          undoHistory.requeue(entry)
          return historySuccess(entry, {
            redone: true,
            message: `Re-deleted property “${entry.label}”.`,
          })
        }
        case 'project-delete': {
          const projectId = entry.snapshot?.projectId
          if (projectId == null) {
            putBack()
            return { redone: false, error: 'Cannot redo project delete: missing snapshot.' }
          }
          db.deleteProject(projectId)
          undoHistory.requeue(entry)
          return historySuccess(entry, {
            redone: true,
            message: `Re-deleted project “${entry.label}”.`,
          })
        }
        case 'project-recovery': {
          if (!db.restoreProjectDeleteSnapshot(entry.snapshot)) {
            putBack()
            return { redone: false, error: 'Cannot redo project recovery: project is missing.' }
          }
          undoHistory.requeue(entry)
          return historySuccess(entry, {
            redone: true,
            message: `Recovered deleted project “${entry.label}”.`,
          })
        }
        case 'executive-summary-delete': {
          db.deleteExecutiveSummary(entry.buildingId)
          undoHistory.requeue(entry)
          return historySuccess(entry, {
            redone: true,
            message: 'Re-cleared the executive summary.',
          })
        }
        default:
          putBack()
          return {
            redone: false,
            error: `Unknown redo entry type: ${entry.type}`,
          }
      }
    } catch (err) {
      putBack()
      return {
        redone: false,
        error: String(err?.message ?? err),
        type: entry.type,
      }
    }
  })

  handleChannel('firm-logo:remove', async () => {
    const before = db.firmFieldsSnapshot(db.getFirm())
    // Keep the file on disk so undo can restore logo_path.
    db.removeFirmLogo()
    const firm = db.getFirm()
    if (before && !db.firmPayloadEqualsSnapshot(firm, before)) {
      undoHistory.pushFirmUpdate(before)
    }
    return firm
  })
}

/**
 * Wire caption/summary persistence into the caption service. Called from the
 * main process once the database is open. Each hook consumes the database
 * replacement latch before touching a row so reused ids cannot receive stale
 * AI output; the caption service rechecks its epoch after the hook returns.
 */
function configureCaptionPersistence({ db, captionService, undoHistory }) {
  function ensureAiWorkspaceCurrent() {
    const result = db.ensureDatabaseCurrent()
    if (!result?.changed) return true
    undoHistory?.clear?.()
    captionService.invalidateWorkspace?.(
      'The database file changed — queued AI work was canceled.',
    )
    return false
  }

  captionService.configureCaptionPersistence({
    updateImageCaption: (kind, imageId, caption) => {
      if (!ensureAiWorkspaceCurrent()) return
      db.updateImageCaption(kind, imageId, caption)
    },
    getImageRow: (kind, imageId) => {
      ensureAiWorkspaceCurrent()
      return db.getImageRowByKind(kind, imageId)
    },
    updateExecutiveSummaryField: (buildingId, field, text) => {
      if (!ensureAiWorkspaceCurrent()) return
      db.updateExecutiveSummaryField(buildingId, field, text)
    },
    getExecutiveSummaryField: (buildingId, field) => {
      ensureAiWorkspaceCurrent()
      const summary = db.getExecutiveSummary(Number(buildingId))
      return summary?.[field] ?? null
    },
    getExecutiveSummaryState: (buildingId, field) => {
      ensureAiWorkspaceCurrent()
      const id = Number(buildingId)
      const building = db.getBuilding(id)
      const summary = db.getExecutiveSummaryRow(id)
      return {
        exists: Boolean(building) && (!summary || Number(summary.hidden) === 0),
        value:
          summary && Number(summary.hidden) === 0
            ? summary[field] ?? null
            : null,
      }
    },
  })
}

module.exports = {
  registerIpcHandlers,
  configureCaptionPersistence,
}
