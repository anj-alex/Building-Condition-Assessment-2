/**
 * In-memory undo/redo stacks for the main process (session lifetime only).
 * Consecutive field updates for the same entity are coalesced so autosave
 * does not create one undo step per keystroke batch.
 *
 * New user actions clear the redo stack (including mutations that are not
 * themselves recorded as undo steps). Successful undo moves the entry to
 * redo; successful redo moves it back to undo.
 */

const MAX_ENTRIES = 50
/** Shared coalesce window for asset / building / project / firm / summary edits. */
const UPDATE_COALESCE_MS = 4000
/** @deprecated Use UPDATE_COALESCE_MS */
const ASSET_UPDATE_COALESCE_MS = UPDATE_COALESCE_MS

/** @type {object[]} */
const stack = []

/** @type {object[]} */
const redoStack = []

function clear() {
  stack.length = 0
  redoStack.length = 0
}

/** Drop redo only (branching history after a new mutation). */
function clearRedo() {
  redoStack.length = 0
}

function size() {
  return stack.length
}

function redoSize() {
  return redoStack.length
}

function peek() {
  return stack.length ? stack[stack.length - 1] : null
}

function peekRedo() {
  return redoStack.length ? redoStack[redoStack.length - 1] : null
}

function pop() {
  return stack.length ? stack.pop() : null
}

function popRedo() {
  return redoStack.length ? redoStack.pop() : null
}

/**
 * Record a new user action. Clears the redo stack (branching history).
 * @param {object} entry
 */
function push(entry) {
  if (!entry || typeof entry !== 'object') return
  stack.push({ ...entry, recordedAt: Date.now() })
  while (stack.length > MAX_ENTRIES) stack.shift()
  clearRedo()
}

/**
 * Put an entry back on the undo stack without clearing redo
 * (failed undo recovery, or successful redo).
 * @param {object} entry
 */
function requeue(entry) {
  if (!entry || typeof entry !== 'object') return
  stack.push(entry)
  while (stack.length > MAX_ENTRIES) stack.shift()
}

/**
 * Append an entry to the redo stack (successful undo, or failed-redo recovery).
 * @param {object} entry
 */
function pushRedo(entry) {
  if (!entry || typeof entry !== 'object') return
  redoStack.push(entry)
  while (redoStack.length > MAX_ENTRIES) redoStack.shift()
}

/** Alias for pushRedo — keeps call sites explicit about recovery intent. */
function requeueRedo(entry) {
  pushRedo(entry)
}

/**
 * Record a coalesced field-update undo step.
 * Keeps the earliest `before` while the user keeps editing the same entity
 * within the coalesce window. Does not merge into an entry that already has
 * an `after` snapshot (those have been through undo/redo).
 *
 * @param {string} type e.g. 'asset-update', 'building-update'
 * @param {Record<string, number|string|null>} identity keys that must match the top entry
 * @param {object} beforeSnapshot
 * @param {object} [extra] additional fields stored on the entry (buildingId, label, …)
 */
function pushCoalescedUpdate(type, identity, beforeSnapshot, extra = {}) {
  if (!type || !beforeSnapshot || !identity || typeof identity !== 'object') return

  const now = Date.now()
  const top = peek()
  if (
    top?.type === type &&
    top.after == null &&
    now - (top.updatedAt ?? top.recordedAt ?? 0) < UPDATE_COALESCE_MS
  ) {
    let same = true
    for (const [key, value] of Object.entries(identity)) {
      if (top[key] !== value && Number(top[key]) !== Number(value)) {
        same = false
        break
      }
    }
    if (same) {
      top.updatedAt = now
      clearRedo()
      return
    }
  }

  push({
    type,
    ...identity,
    before: { ...beforeSnapshot },
    ...extra,
    updatedAt: now,
  })
}

/**
 * Record an asset field update (coalesced).
 * @param {number} assetId
 * @param {object} beforeSnapshot
 * @param {{ buildingId?: number|null, projectId?: number|null, level1Group?: string|null }} [meta]
 */
function pushAssetUpdate(assetId, beforeSnapshot, meta = {}) {
  const id = Number(assetId)
  if (!Number.isFinite(id) || id <= 0 || !beforeSnapshot) return

  const buildingId =
    meta.buildingId != null && Number.isFinite(Number(meta.buildingId))
      ? Number(meta.buildingId)
      : null
  const projectId =
    meta.projectId != null && Number.isFinite(Number(meta.projectId))
      ? Number(meta.projectId)
      : null
  pushCoalescedUpdate(
    'asset-update',
    { assetId: id },
    beforeSnapshot,
    {
      buildingId,
      projectId,
      level1Group: meta.level1Group ?? null,
    },
  )
}

/**
 * @param {number} buildingId
 * @param {object} beforeSnapshot
 * @param {{ projectId?: number|null }} [meta]
 */
function pushBuildingUpdate(buildingId, beforeSnapshot, meta = {}) {
  const id = Number(buildingId)
  if (!Number.isFinite(id) || id <= 0 || !beforeSnapshot) return
  const projectId =
    meta.projectId != null && Number.isFinite(Number(meta.projectId))
      ? Number(meta.projectId)
      : null
  pushCoalescedUpdate(
    'building-update',
    { buildingId: id },
    beforeSnapshot,
    { projectId },
  )
}

/**
 * @param {number} projectId
 * @param {object} beforeSnapshot
 */
function pushProjectUpdate(projectId, beforeSnapshot) {
  const id = Number(projectId)
  if (!Number.isFinite(id) || id <= 0 || !beforeSnapshot) return
  pushCoalescedUpdate('project-update', { projectId: id }, beforeSnapshot)
}

/**
 * @param {number} buildingId
 * @param {object} beforeSnapshot
 * @param {{ projectId?: number|null }} [meta]
 */
function pushExecutiveSummaryUpdate(buildingId, beforeSnapshot, meta = {}) {
  const id = Number(buildingId)
  if (!Number.isFinite(id) || id <= 0 || !beforeSnapshot) return
  const projectId =
    meta.projectId != null && Number.isFinite(Number(meta.projectId))
      ? Number(meta.projectId)
      : null
  pushCoalescedUpdate(
    'executive-summary-update',
    { buildingId: id },
    beforeSnapshot,
    { projectId },
  )
}

/**
 * @param {object} beforeSnapshot full firm field snapshot
 */
function pushFirmUpdate(beforeSnapshot) {
  if (!beforeSnapshot) return
  // Single firm row — identity is just the type.
  pushCoalescedUpdate('firm-update', {}, beforeSnapshot)
}

module.exports = {
  clear,
  clearRedo,
  size,
  redoSize,
  peek,
  peekRedo,
  pop,
  popRedo,
  push,
  requeue,
  pushRedo,
  requeueRedo,
  pushCoalescedUpdate,
  pushAssetUpdate,
  pushBuildingUpdate,
  pushProjectUpdate,
  pushExecutiveSummaryUpdate,
  pushFirmUpdate,
  UPDATE_COALESCE_MS,
  ASSET_UPDATE_COALESCE_MS,
  MAX_ENTRIES,
}
