/**
 * Session load of the encrypted OpenRouter key + background caption queue.
 * Main-process only. AI is on by default when the secret package is present;
 * there is no user unlock password (OpenRouter per-key spend cap is the bound).
 */

const fs = require('node:fs')
const path = require('node:path')
const { BrowserWindow, nativeImage } = require('electron')
const {
  decryptSecret,
  isSecretPackage,
  getAppWrapSecret,
} = require('./secret-crypto')
const {
  VISION_MODEL,
  SUMMARY_MODEL,
  SECRET_PATH,
  IMAGE_MAX_EDGE,
  IMAGE_JPEG_QUALITY,
  CAPTION_MAX_CONCURRENT,
  CAPTION_FREE_MIN_INTERVAL_MS,
  SUMMARY_MAX_CONCURRENT,
  SUMMARY_FREE_MIN_INTERVAL_MS,
} = require('./openrouter-config')
const {
  captionImageWithOpenRouter,
  completeTextWithOpenRouter,
  fetchOpenRouterKeyUsage,
  formatOpenRouterCredits,
  formatOpenRouterKeyLimitRemaining,
  buildAssetCaptionPrompt,
  buildBuildingCaptionPrompt,
  buildExecutiveSummaryPrompt,
  isExecutiveSummaryField,
} = require('./openrouter-client')

/** @type {string|null} */
let sessionApiKey = null

/**
 * Refusal message for every AI action taken without a session key.
 *
 * There is no user action that fixes this — no unlock password to enter — so it
 * names the cause instead of asking for one. Shared with `src/main.js` so the
 * IPC guards and the service cannot drift into two different explanations.
 */
const AI_KEY_UNAVAILABLE =
  'AI key is not available (secret package missing or failed to load).'

/** @type {Array<object>} */
const queue = []
/** Jobs that are queued or currently calling the model, keyed by image. */
const activeCaptionJobs = new Map()
/** In-flight caption HTTP workers (bounded by CAPTION_MAX_CONCURRENT). */
let activeWorkers = 0
/** Earliest time the next free-model caption may start (RPM pacing). */
let nextCaptionSlotAt = 0

/** @type {Array<object>} */
const summaryQueue = []
/** Summary jobs queued or in-flight, keyed by buildingId:field. */
const activeSummaryJobs = new Map()
let activeSummaryWorkers = 0
let nextSummarySlotAt = 0

// Monotonic identity for the open workspace. Importing/replacing app data can
// reuse numeric row ids; an old HTTP response must never land in that new set.
let workspaceEpoch = 0

function getWorkspaceEpoch() {
  return workspaceEpoch
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function captionJobKey(job) {
  if (job?.imageId == null) return null
  const kind = job.kind === 'building' ? 'building' : 'asset'
  const imageId = Number(job.imageId)
  if (!Number.isFinite(imageId) || imageId <= 0) return null
  return `${kind}:${imageId}`
}

function captionJobStatus(job) {
  return {
    kind: job.kind === 'building' ? 'building' : 'asset',
    imageId: Number(job.imageId),
    assetId: job.assetId != null ? Number(job.assetId) : null,
    buildingId: job.buildingId != null ? Number(job.buildingId) : null,
    state: 'generating',
  }
}

function completeCaptionJob(job, outcome) {
  const key = captionJobKey(job)
  if (
    job?.workspaceEpoch !== workspaceEpoch ||
    !key ||
    activeCaptionJobs.get(key) !== job
  ) {
    return
  }
  activeCaptionJobs.delete(key)
  broadcastCaptionUpdate({
    ...captionJobStatus(job),
    state: 'finished',
    ...outcome,
  })
}

function loadSecretPackage() {
  try {
    if (!fs.existsSync(SECRET_PATH)) return null
    const raw = JSON.parse(fs.readFileSync(SECRET_PATH, 'utf8'))
    return isSecretPackage(raw) ? raw : null
  } catch {
    return null
  }
}

function getAiStatus() {
  const secret = loadSecretPackage()
  return {
    configured: Boolean(secret) || Boolean(sessionApiKey),
    unlocked: Boolean(sessionApiKey),
    /** Same as visionModel; used by caption regenerate IPC. */
    model: VISION_MODEL || null,
    modelConfigured: Boolean(VISION_MODEL),
    visionModel: VISION_MODEL || null,
    visionModelConfigured: Boolean(VISION_MODEL),
    summaryModel: SUMMARY_MODEL || null,
    summaryModelConfigured: Boolean(SUMMARY_MODEL),
    captionJobs: [...activeCaptionJobs.values()].map(captionJobStatus),
    summaryJobs: [...activeSummaryJobs.values()].map(summaryJobStatus),
  }
}

/**
 * Live key usage from OpenRouter (requires the loaded session key).
 * @returns {Promise<object>}
 */
async function getOpenRouterUsage() {
  if (!sessionApiKey) {
    return {
      ok: false,
      unlocked: false,
      error: AI_KEY_UNAVAILABLE,
    }
  }
  try {
    const usage = await fetchOpenRouterKeyUsage(sessionApiKey)
    const hasKeyLimit = usage.limit != null && Number.isFinite(Number(usage.limit))
    return {
      ok: true,
      unlocked: true,
      ...usage,
      // Preformatted for Settings (renderer cannot require openrouter-client).
      display: {
        usage: formatOpenRouterCredits(usage.usage),
        usageMonthly: formatOpenRouterCredits(usage.usageMonthly),
        limitRemaining: formatOpenRouterKeyLimitRemaining(
          usage.limit,
          usage.limitRemaining,
        ),
        limit: hasKeyLimit ? formatOpenRouterCredits(usage.limit) : null,
      },
    }
  } catch (err) {
    return {
      ok: false,
      unlocked: true,
      error: String(err?.message ?? err),
    }
  }
}

/**
 * Decrypt the shipped secret into memory for this process lifetime.
 * Uses the app wrap secret (not a user password). Safe to call repeatedly.
 * @returns {{ ok: boolean, error?: string, attempted: boolean } & object}
 */
function ensureSessionKey() {
  if (sessionApiKey) {
    return { ok: true, attempted: false, reason: 'already loaded', ...getAiStatus() }
  }
  const secret = loadSecretPackage()
  if (!secret) {
    return {
      ok: false,
      attempted: true,
      error:
        'AI is not configured. Run scripts/encrypt-openrouter-key.js to ship an encrypted OpenRouter key.',
      ...getAiStatus(),
    }
  }
  try {
    const key = decryptSecret(secret, getAppWrapSecret())
    if (!key?.trim()) {
      return {
        ok: false,
        attempted: true,
        error: 'Decrypted key is empty',
        ...getAiStatus(),
      }
    }
    sessionApiKey = key.trim()
    return { ok: true, attempted: true, ...getAiStatus() }
  } catch (err) {
    return {
      ok: false,
      attempted: true,
      error: String(err?.message ?? err),
      ...getAiStatus(),
    }
  }
}

function broadcastCaptionUpdate(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('ai:caption-updated', payload)
  }
}

function broadcastSummaryUpdate(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('ai:summary-updated', payload)
  }
}

function summaryJobKey(job) {
  const buildingId = Number(job?.buildingId)
  const field = String(job?.field ?? '')
  if (!Number.isFinite(buildingId) || buildingId <= 0 || !field) return null
  return `${buildingId}:${field}`
}

function summaryJobStatus(job) {
  return {
    buildingId: Number(job.buildingId),
    field: String(job.field),
    state: 'generating',
  }
}

function completeSummaryJob(job, outcome) {
  const key = summaryJobKey(job)
  if (
    job?.workspaceEpoch !== workspaceEpoch ||
    !key ||
    activeSummaryJobs.get(key) !== job
  ) {
    return
  }
  activeSummaryJobs.delete(key)
  broadcastSummaryUpdate({
    ...summaryJobStatus(job),
    state: 'finished',
    ...outcome,
  })
}

/**
 * Resize/compress local image for vision APIs using Electron nativeImage.
 * @param {string} filePath
 * @returns {string} data URL
 */
function fileToVisionDataUrl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('Image file not found')
  }
  let image = nativeImage.createFromPath(filePath)
  if (image.isEmpty()) {
    // Fallback: raw base64 with mime from extension (no resize).
    const ext = path.extname(filePath).toLowerCase()
    const mime =
      ext === '.png'
        ? 'image/png'
        : ext === '.webp'
          ? 'image/webp'
          : ext === '.gif'
            ? 'image/gif'
            : 'image/jpeg'
    const buf = fs.readFileSync(filePath)
    return `data:${mime};base64,${buf.toString('base64')}`
  }

  const { width, height } = image.getSize()
  const longEdge = Math.max(width, height)
  if (longEdge > IMAGE_MAX_EDGE && longEdge > 0) {
    const scale = IMAGE_MAX_EDGE / longEdge
    image = image.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: 'good',
    })
  }

  const jpeg = image.toJPEG(IMAGE_JPEG_QUALITY)
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`
}

/**
 * Enqueue caption jobs. No-ops when AI is locked or unconfigured.
 * @param {Array<{ kind: 'asset'|'building', imageId: number, filePath: string, context?: object }>} jobs
 */
function enqueueCaptionJobs(jobs) {
  if (!sessionApiKey || !VISION_MODEL) {
    return { queued: 0, alreadyGenerating: 0, skipped: true, jobs: [] }
  }
  let queued = 0
  let alreadyGenerating = 0
  /** @type {Array<{ kind: string, imageId: number }>} */
  const queuedJobs = []
  for (const candidate of jobs ?? []) {
    const job = { ...candidate, workspaceEpoch }
    const key = captionJobKey(job)
    if (!key || !job.filePath) continue
    if (activeCaptionJobs.has(key)) {
      alreadyGenerating += 1
      continue
    }
    // Only fill empty captions — skip if already set (caller should filter).
    activeCaptionJobs.set(key, job)
    queue.push(job)
    queued += 1
    queuedJobs.push({
      kind: job.kind === 'building' ? 'building' : 'asset',
      imageId: Number(job.imageId),
    })
    broadcastCaptionUpdate(captionJobStatus(job))
  }
  void pumpQueue()
  return { queued, alreadyGenerating, skipped: false, jobs: queuedJobs }
}

async function pumpQueue() {
  while (activeWorkers < CAPTION_MAX_CONCURRENT && queue.length > 0) {
    if (!sessionApiKey) {
      const dropped = queue.splice(0, queue.length)
      for (const job of dropped) {
        if (job?.imageId == null) continue
        completeCaptionJob(job, {
          ok: false,
          error: 'AI key unavailable — caption job canceled.',
        })
      }
      return
    }

    const job = queue.shift()
    activeWorkers += 1
    void (async () => {
      try {
        if (CAPTION_FREE_MIN_INTERVAL_MS > 0) {
          const now = Date.now()
          const startAt = Math.max(now, nextCaptionSlotAt)
          nextCaptionSlotAt = startAt + CAPTION_FREE_MIN_INTERVAL_MS
          const waitMs = startAt - now
          if (waitMs > 0) await sleep(waitMs)
        }
        if (!sessionApiKey) {
          completeCaptionJob(job, {
            ok: false,
            error: 'AI key unavailable — caption job canceled.',
          })
          return
        }
        const outcome = await processJob(job)
        completeCaptionJob(job, outcome)
      } catch (err) {
        console.error('AI caption failed', {
          kind: job?.kind,
          imageId: job?.imageId,
          error: String(err?.message ?? err),
        })
        completeCaptionJob(job, {
          ok: false,
          error: String(err?.message ?? err),
        })
      } finally {
        activeWorkers -= 1
        void pumpQueue()
      }
    })()
  }
}

/**
 * @param {object} job
 * @param {(table: string, imageId: number, caption: string) => void} updateCaption
 */
let updateCaptionFn = null
let getImageRowFn = null
let updateSummaryFieldFn = null
let getSummaryFieldFn = null
let getSummaryStateFn = null

function configureCaptionPersistence({
  updateImageCaption,
  getImageRow,
  updateExecutiveSummaryField,
  getExecutiveSummaryField,
  getExecutiveSummaryState,
}) {
  updateCaptionFn = updateImageCaption
  getImageRowFn = getImageRow
  updateSummaryFieldFn = updateExecutiveSummaryField ?? null
  getSummaryFieldFn = getExecutiveSummaryField ?? null
  getSummaryStateFn = getExecutiveSummaryState ?? null
}

function sameStoredText(left, right) {
  return (left == null ? null : String(left)) === (right == null ? null : String(right))
}

async function processJob(job) {
  if (!sessionApiKey || job.workspaceEpoch !== workspaceEpoch) {
    return { ok: false, error: 'AI key unavailable — caption job canceled.' }
  }
  const startingRow = getImageRowFn ? getImageRowFn(job.kind, job.imageId) : null
  // Persistence hooks may discover an out-of-band database replacement and
  // invalidate the workspace. Recheck after every hook, especially the final
  // read immediately before a same-numeric-id write.
  if (job.workspaceEpoch !== workspaceEpoch) {
    return { ok: false, canceled: true, stale: true }
  }
  if (getImageRowFn && (!startingRow || Number(startingRow.hidden) === 1)) {
    return { ok: true, skipped: true, stale: true }
  }
  const startingCaption = startingRow?.caption ?? null
  // Skip if caption already filled (user edit or prior run), unless force regenerate.
  if (!job.force && startingCaption && String(startingCaption).trim()) {
    return { ok: true, skipped: true, caption: String(startingCaption) }
  }

  const dataUrl = fileToVisionDataUrl(job.filePath)
  const prompt =
    job.kind === 'building'
      ? buildBuildingCaptionPrompt(job.context || {})
      : buildAssetCaptionPrompt(job.context || {})

  const caption = await captionImageWithOpenRouter({
    apiKey: sessionApiKey,
    imageDataUrl: dataUrl,
    prompt,
    model: VISION_MODEL,
  })

  if (job.workspaceEpoch !== workspaceEpoch) {
    return { ok: false, canceled: true, stale: true }
  }
  const currentRow = getImageRowFn ? getImageRowFn(job.kind, job.imageId) : startingRow
  if (job.workspaceEpoch !== workspaceEpoch) {
    return { ok: false, canceled: true, stale: true }
  }
  if (
    getImageRowFn &&
    (!currentRow ||
      Number(currentRow.hidden) === 1 ||
      !sameStoredText(currentRow.caption, startingCaption))
  ) {
    return {
      ok: true,
      skipped: true,
      stale: true,
      caption: currentRow?.caption == null ? null : String(currentRow.caption),
    }
  }
  if (updateCaptionFn) {
    updateCaptionFn(job.kind, job.imageId, caption)
    if (job.workspaceEpoch !== workspaceEpoch) {
      return { ok: false, canceled: true, stale: true }
    }
  }

  return { ok: true, caption }
}

/**
 * Enqueue executive-summary jobs. Persists via configureCaptionPersistence when set.
 * @param {Array<{
 *   buildingId: number,
 *   field: string,
 *   building?: object,
 *   assets?: object[],
 *   capitalPlan?: object|null,
 *   force?: boolean,
 * }>} jobs
 */
function enqueueSummaryJobs(jobs) {
  if (!sessionApiKey || !SUMMARY_MODEL) {
    return { queued: 0, alreadyGenerating: 0, skipped: true, jobs: [] }
  }
  let queued = 0
  let alreadyGenerating = 0
  /** @type {Array<{ buildingId: number, field: string }>} */
  const queuedJobs = []
  for (const candidate of jobs ?? []) {
    const job = { ...candidate, workspaceEpoch }
    const key = summaryJobKey(job)
    if (!key) continue
    if (activeSummaryJobs.has(key)) {
      alreadyGenerating += 1
      continue
    }
    activeSummaryJobs.set(key, job)
    summaryQueue.push(job)
    queued += 1
    queuedJobs.push({
      buildingId: Number(job.buildingId),
      field: String(job.field),
    })
    broadcastSummaryUpdate(summaryJobStatus(job))
  }
  void pumpSummaryQueue()
  return { queued, alreadyGenerating, skipped: false, jobs: queuedJobs }
}

async function pumpSummaryQueue() {
  while (
    activeSummaryWorkers < SUMMARY_MAX_CONCURRENT &&
    summaryQueue.length > 0
  ) {
    if (!sessionApiKey) {
      const dropped = summaryQueue.splice(0, summaryQueue.length)
      for (const job of dropped) {
        completeSummaryJob(job, {
          ok: false,
          error: 'AI key unavailable — summary job canceled.',
        })
      }
      return
    }

    const job = summaryQueue.shift()
    activeSummaryWorkers += 1
    void (async () => {
      try {
        if (SUMMARY_FREE_MIN_INTERVAL_MS > 0) {
          const now = Date.now()
          const startAt = Math.max(now, nextSummarySlotAt)
          nextSummarySlotAt = startAt + SUMMARY_FREE_MIN_INTERVAL_MS
          const waitMs = startAt - now
          if (waitMs > 0) await sleep(waitMs)
        }
        if (!sessionApiKey) {
          completeSummaryJob(job, {
            ok: false,
            error: 'AI key unavailable — summary job canceled.',
          })
          return
        }
        const outcome = await processSummaryJob(job)
        completeSummaryJob(job, outcome)
      } catch (err) {
        console.error('AI summary failed', {
          buildingId: job?.buildingId,
          field: job?.field,
          error: String(err?.message ?? err),
        })
        completeSummaryJob(job, {
          ok: false,
          error: String(err?.message ?? err),
        })
      } finally {
        activeSummaryWorkers -= 1
        void pumpSummaryQueue()
      }
    })()
  }
}

async function processSummaryJob(job) {
  if (!sessionApiKey || job.workspaceEpoch !== workspaceEpoch) {
    return { ok: false, error: 'AI key unavailable — summary job canceled.' }
  }
  const field = String(job.field ?? '')
  if (!isExecutiveSummaryField(field)) {
    return { ok: false, error: 'Unknown executive summary section.' }
  }

  const startingState = getSummaryStateFn
    ? getSummaryStateFn(job.buildingId, field)
    : {
        exists: true,
        value: getSummaryFieldFn
          ? getSummaryFieldFn(job.buildingId, field)
          : null,
      }
  if (job.workspaceEpoch !== workspaceEpoch) {
    return { ok: false, canceled: true, stale: true, field }
  }
  if (!startingState?.exists) {
    return { ok: true, skipped: true, stale: true, field }
  }
  const startingText = startingState.value ?? null
  if (!job.force && startingText && String(startingText).trim()) {
    return { ok: true, skipped: true, text: String(startingText), field }
  }

  const result = await generateExecutiveSummarySection({
    field,
    building: job.building ?? null,
    assets: job.assets ?? [],
    capitalPlan: job.capitalPlan ?? null,
  })
  if (!result.ok) return result

  if (job.workspaceEpoch !== workspaceEpoch) {
    return { ok: false, canceled: true, stale: true, field }
  }
  const currentState = getSummaryStateFn
    ? getSummaryStateFn(job.buildingId, field)
    : {
        exists: true,
        value: getSummaryFieldFn
          ? getSummaryFieldFn(job.buildingId, field)
          : startingText,
      }
  if (job.workspaceEpoch !== workspaceEpoch) {
    return { ok: false, canceled: true, stale: true, field }
  }
  if (!currentState?.exists || !sameStoredText(currentState.value, startingText)) {
    return {
      ok: true,
      skipped: true,
      stale: true,
      text: currentState?.value == null ? null : String(currentState.value),
      field,
    }
  }

  if (updateSummaryFieldFn) {
    updateSummaryFieldFn(job.buildingId, field, result.text)
    if (job.workspaceEpoch !== workspaceEpoch) {
      return { ok: false, canceled: true, stale: true, field }
    }
  }

  return {
    ok: true,
    text: result.text,
    field,
    buildingId: Number(job.buildingId),
    model: result.model,
  }
}

/**
 * Cancel every queued/in-flight job against the old database identity. HTTP
 * requests already on the wire are allowed to finish, but their results are
 * suppressed and cannot delete a newly queued same-id job from the maps.
 */
function invalidateWorkspace(reason = 'Workspace changed — AI job canceled.') {
  workspaceEpoch += 1
  queue.splice(0, queue.length)
  summaryQueue.splice(0, summaryQueue.length)
  const captionJobs = [...activeCaptionJobs.values()]
  const summaryJobs = [...activeSummaryJobs.values()]
  activeCaptionJobs.clear()
  activeSummaryJobs.clear()
  for (const job of captionJobs) {
    broadcastCaptionUpdate({
      ...captionJobStatus(job),
      state: 'finished',
      ok: false,
      canceled: true,
      error: reason,
    })
  }
  for (const job of summaryJobs) {
    broadcastSummaryUpdate({
      ...summaryJobStatus(job),
      state: 'finished',
      ok: false,
      canceled: true,
      error: reason,
    })
  }
  return { captionJobs: captionJobs.length, summaryJobs: summaryJobs.length }
}

/**
 * Generate one executive-summary section from building + asset context.
 * Does not write to the database — the renderer places the text in the form.
 *
 * @param {object} options
 * @param {string} options.field executive_summary column key
 * @param {object|null} options.building
 * @param {Array<object>} [options.assets]
 * @param {object|null} [options.capitalPlan] result of `calculateCapitalPlan`, for cost context
 * @returns {Promise<{ ok: true, text: string, field: string, model: string } | { ok: false, error: string }>}
 */
async function generateExecutiveSummarySection({
  field,
  building,
  assets = [],
  capitalPlan = null,
}) {
  if (!sessionApiKey) {
    return { ok: false, error: AI_KEY_UNAVAILABLE }
  }
  if (!SUMMARY_MODEL) {
    return {
      ok: false,
      error: 'Summary model is not configured (set OPENROUTER_SUMMARY_MODEL).',
    }
  }
  if (!isExecutiveSummaryField(field)) {
    return { ok: false, error: 'Unknown executive summary section.' }
  }

  try {
    const { system, prompt } = buildExecutiveSummaryPrompt({
      field,
      building,
      assets,
      capitalPlan,
    })
    const text = await completeTextWithOpenRouter({
      apiKey: sessionApiKey,
      system,
      prompt,
      model: SUMMARY_MODEL,
    })
    return { ok: true, text, field: String(field), model: SUMMARY_MODEL }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}

module.exports = {
  AI_KEY_UNAVAILABLE,
  getAiStatus,
  getOpenRouterUsage,
  ensureSessionKey,
  enqueueCaptionJobs,
  enqueueSummaryJobs,
  generateExecutiveSummarySection,
  configureCaptionPersistence,
  invalidateWorkspace,
  getWorkspaceEpoch,
  loadSecretPackage,
  fileToVisionDataUrl,
}
