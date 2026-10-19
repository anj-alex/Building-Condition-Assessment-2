function toFileUrl(filePath) {
  const normalized = String(filePath ?? '').replace(/\\/g, '/')
  if (!normalized) return ''
  if (/^file:\/\//i.test(normalized)) return normalized
  return `file://${encodeURI(normalized).replace(/[?#]/g, (char) => (char === '?' ? '%3F' : '%23'))}`
}

/**
 * Toggle the editable caption controls for one gallery image.
 * @param {number|string} imageId
 * @param {boolean} generating
 * @param {Document|HTMLElement} [root]
 */
function setImageCaptionGenerationControls(
  imageId,
  generating,
  root = document,
) {
  const id = Number(imageId)
  if (!Number.isFinite(id) || !root?.querySelector) return
  const busy = Boolean(generating)
  const input = root.querySelector(`[data-gallery-image-caption="${id}"]`)
  const generateButton = root.querySelector(`[data-gallery-image-regen="${id}"]`)
  if (input) {
    input.disabled = busy
    input.setAttribute('aria-busy', busy ? 'true' : 'false')
  }
  if (generateButton) {
    generateButton.disabled = busy
    generateButton.setAttribute('aria-busy', busy ? 'true' : 'false')
  }
}

function formTextValue(fd, name) {
  return String(fd.get(name) ?? '').trim() || null
}

function formNumberValue(fd, name) {
  const value = String(fd.get(name) ?? '').trim()
  return value ? Number(value) : null
}

function getActiveIds() {
  const [projectIdText = '', buildingIdText = ''] = String(location.hash || '')
    .replace(/^#/, '')
    .split(':')
  return {
    projectId: Number(projectIdText) || null,
    buildingId: Number(buildingIdText) || null,
  }
}

/**
 * Building ids from a `#<projectId>:<id1>,<id2>,...` hash, in hash order and
 * de-duplicated. The property report accepts several so one export can cover a
 * whole project; `getActiveIds` still returns a single `buildingId` for pages
 * that only ever open one building (it yields null on a comma-joined list).
 */
function getActiveBuildingIds() {
  const [, buildingIdText = ''] = String(location.hash || '')
    .replace(/^#/, '')
    .split(':')
  const ids = []
  for (const part of buildingIdText.split(',')) {
    const id = Number(part.trim())
    if (Number.isFinite(id) && id > 0 && !ids.includes(id)) ids.push(id)
  }
  return ids
}

function getBuildingTitle(building) {
  return building?.property_name?.trim() || `Property #${building?.id}`
}

function getBuildingAddress(building) {
  return [building?.address, building?.city, building?.province].filter(Boolean).join(', ')
}

function setInputValueById(id, value) {
  const input = document.getElementById(id)
  if (input) input.value = value ?? ''
}

const HOME_RETURN_BUILDING_KEY = 'home-return-building-id'

/** Remember which building detail view to restore after a create/edit subpage. */
function setHomeReturnBuildingId(buildingId) {
  if (typeof sessionStorage === 'undefined') return
  const id = Number(buildingId)
  if (Number.isFinite(id) && id > 0) {
    sessionStorage.setItem(HOME_RETURN_BUILDING_KEY, String(id))
  } else {
    sessionStorage.removeItem(HOME_RETURN_BUILDING_KEY)
  }
}

/** Read and clear a stored return building id (one-shot). */
function consumeHomeReturnBuildingId() {
  if (typeof sessionStorage === 'undefined') return null
  const raw = sessionStorage.getItem(HOME_RETURN_BUILDING_KEY)
  sessionStorage.removeItem(HOME_RETURN_BUILDING_KEY)
  const id = Number(raw)
  return Number.isFinite(id) && id > 0 ? id : null
}

function goBackHome(projectId, buildingId) {
  if (projectId) {
    const opts = { selectProjectId: projectId }
    const building = Number(buildingId)
    if (Number.isFinite(building) && building > 0) {
      opts.selectBuildingId = building
    }
    window.electronAPI?.goHome(opts)
  } else {
    window.electronAPI?.goHome()
  }
}

function wireBackHome(button, projectId, buildingId) {
  if (button) button.addEventListener('click', () => goBackHome(projectId, buildingId))
}

/**
 * Dirty renderer editors register one flush function here. App history crosses
 * this seam before it asks the main process to undo/redo, so a debounced edit is
 * recorded as the newest history entry instead of being discarded after an
 * older entry is undone.
 *
 * @type {Set<() => Promise<void>|void>}
 */
const rendererDraftFlushers = new Set()
let rendererDraftRegistryRevision = 0

function registerRendererDraftFlusher(flush) {
  if (typeof flush !== 'function') return () => {}
  rendererDraftFlushers.add(flush)
  rendererDraftRegistryRevision += 1
  return () => {
    if (!rendererDraftFlushers.delete(flush)) return
    rendererDraftRegistryRevision += 1
  }
}

async function flushPendingRendererDrafts() {
  let flushedRevision
  let firstError = null
  do {
    flushedRevision = rendererDraftRegistryRevision
    // A close/navigation decision must wait for every draft. Promise.all would
    // reject as soon as one editor failed, even while a sibling write was still
    // in flight and vulnerable to a subsequent force-close.
    const results = await Promise.allSettled(
      [...rendererDraftFlushers].map((flush) => Promise.resolve().then(flush)),
    )
    if (!firstError) {
      const rejected = results.find((result) => result.status === 'rejected')
      if (rejected) firstError = rejected.reason
    }
  } while (flushedRevision !== rendererDraftRegistryRevision)

  if (firstError) {
    if (
      firstError instanceof Error ||
      (typeof firstError === 'object' && typeof firstError.message === 'string')
    ) {
      throw firstError
    }
    throw new Error(String(firstError ?? 'Unknown renderer save failure'))
  }
}

async function handleCloseFlushRequest(requestId) {
  const api = window.electronAPI
  if (!api?.completeCloseRequest) return

  let result = { ok: true }
  try {
    await flushPendingRendererDrafts()
  } catch (error) {
    result = {
      ok: false,
      error: String(error?.message ?? error ?? 'Unknown renderer save failure'),
    }
  }

  try {
    await api.completeCloseRequest(requestId, result)
  } catch (error) {
    // Main owns the timeout and fallback dialog if acknowledgement is lost.
    console.error('Could not acknowledge the window close request:', error)
  }
}

if (typeof window !== 'undefined') {
  window.electronAPI?.onCloseRequested?.((requestId) => {
    void handleCloseFlushRequest(requestId)
  })
}

/**
 * Debounced form autosave shared by building-info, project-setup, firm-setup,
 * and executive-summary. Always flush before navigation (Back / pagehide).
 *
 * @param {{
 *   form: HTMLFormElement|null,
 *   statusEl?: HTMLElement|null,
 *   delayMs?: number,
 *   buildPayload: () => object,
 *   save: (payload: object) => Promise<void>,
 *   canSave?: () => boolean,
 * }} options
 */
function createFormAutosave(options) {
  const form = options.form
  const statusEl = options.statusEl ?? null
  const delayMs = options.delayMs ?? 400
  const buildPayload = options.buildPayload
  const save = options.save
  const canSave = options.canSave ?? (() => true)

  let allowAutosave = false
  let disposed = false
  let dirtyRevision = 0
  let saveTimer = null
  /** @type {Promise<void>|null} */
  let saveInFlight = null
  let unregisterDraftFlusher = null

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text
  }

  function markDirty() {
    dirtyRevision += 1
  }

  async function saveNow({ force = false } = {}) {
    if (!force && (disposed || !allowAutosave)) return
    if (dirtyRevision === 0) return
    if (!form || !canSave()) {
      if (force) {
        setStatus('Save failed')
        throw new Error('Autosave is unavailable for this form')
      }
      return
    }

    while (saveInFlight) {
      await saveInFlight
    }
    if (!force && (disposed || !allowAutosave)) return
    if (dirtyRevision === 0) return
    if (!canSave()) {
      if (force) {
        setStatus('Save failed')
        throw new Error('Autosave is unavailable for this form')
      }
      return
    }

    const revisionAtStart = dirtyRevision
    const payload = buildPayload()
    setStatus('Saving…')
    let saveSucceeded = false

    const request = (async () => {
      try {
        await save(payload)
        saveSucceeded = true
        if (dirtyRevision === revisionAtStart) {
          dirtyRevision = 0
          setStatus('Saved')
        } else {
          setStatus('Saving…')
        }
      } catch (err) {
        setStatus('Save failed')
        console.error(err)
        throw err
      }
    })()

    saveInFlight = request
    try {
      await request
    } finally {
      if (saveInFlight === request) saveInFlight = null
    }

    if (saveSucceeded && dirtyRevision > 0 && (force || (allowAutosave && !disposed))) {
      if (force) {
        await saveNow({ force: true })
      } else {
        scheduleSave()
      }
    }
  }

  function scheduleSave({ immediate = false } = {}) {
    if (disposed || !allowAutosave) return
    if (saveTimer != null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    if (immediate) {
      void saveNow().catch(() => {})
      return
    }
    saveTimer = setTimeout(() => {
      saveTimer = null
      void saveNow().catch(() => {})
    }, delayMs)
  }

  function enable() {
    disposed = false
    allowAutosave = true
    dirtyRevision = 0
    if (!unregisterDraftFlusher) {
      unregisterDraftFlusher = registerRendererDraftFlusher(() => saveNow({ force: true }))
    }
    setStatus('')
  }

  function dispose() {
    disposed = true
    allowAutosave = false
    if (saveTimer != null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    // A disposed autosave chose not to save (the delete flows).
    unregisterDraftFlusher?.()
    unregisterDraftFlusher = null
  }

  /** Pause timers without marking disposed (e.g. before undo reload). */
  function cancelPending() {
    if (saveTimer != null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    dirtyRevision = 0
  }

  /**
   * Flush pending edits then run leave (typically navigate home).
   * @param {() => void|Promise<void>} leave
   */
  async function flushAndLeave(leave) {
    if (saveTimer != null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    await saveNow({ force: true })
    // Do not make disposal visible until the write succeeds. A rejected write
    // leaves the form live, dirty and registered so the user can retry.
    dispose()
    await leave()
  }

  function bindForm() {
    if (!form) return
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      markDirty()
      scheduleSave({ immediate: true })
    })
    form.addEventListener('input', () => {
      markDirty()
      scheduleSave()
    })
    form.addEventListener('change', () => {
      markDirty()
      scheduleSave({ immediate: true })
    })
  }

  function bindPagehide() {
    window.addEventListener('pagehide', () => {
      if (dirtyRevision === 0) return
      disposed = true
      allowAutosave = false
      if (saveTimer != null) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      void saveNow({ force: true }).catch(() => {})
    })
  }

  /**
   * @param {HTMLElement|null} button
   * @param {() => void|Promise<void>} leave
   */
  function wireBack(button, leave) {
    if (!button) return
    button.addEventListener('click', () => {
      void flushAndLeave(leave).catch(() => {})
    })
  }

  const controls = {
    markDirty,
    saveNow,
    scheduleSave,
    enable,
    dispose,
    cancelPending,
    flushAndLeave,
    bindForm,
    bindPagehide,
    wireBack,
    setStatus,
    get dirtyRevision() {
      return dirtyRevision
    },
    get isAllowed() {
      return allowAutosave && !disposed
    },
  }
  unregisterDraftFlusher = registerRendererDraftFlusher(() => saveNow({ force: true }))
  return controls
}

/** Asset form Unit Measure options (must match renderer `UNIT_MEASURE_VALUES`). */
const ASSET_UNIT_MEASURE_VALUES = [
  'Ln. Ft.',
  'Sq. Ft.',
  'EA',
  'Set',
  'Allowance',
  'Lump Sum',
  'Per Floor',
  'Per Point',
  'Per Hose',
  'Per Toilet',
  'Per Tread',
  'Per Rung',
  'Per Starter',
]

/** Map catalogue / CSV unit_of_measure strings onto asset Unit Measure options. */
const PRICING_UNIT_TO_ASSET_UNIT_MEASURE = {
  Each: 'EA',
  EA: 'EA',
  'Square Feet': 'Sq. Ft.',
  'Sq. Ft.': 'Sq. Ft.',
  SF: 'Sq. Ft.',
  'SF of bldg area': 'Sq. Ft.',
  'Linear Feet': 'Ln. Ft.',
  'Ln. Ft.': 'Ln. Ft.',
  Set: 'Set',
  Allowance: 'Allowance',
  'Lump Sum': 'Lump Sum',
  'Per Floor': 'Per Floor',
  'Per Point': 'Per Point',
  'Per Hose': 'Per Hose',
  'Per Toilet': 'Per Toilet',
  'Per Tread': 'Per Tread',
  'Per Rung': 'Per Rung',
  'Per Starter': 'Per Starter',
}

function mapPricingUnitToUnitMeasure(unitOfMeasure) {
  const trimmed = String(unitOfMeasure ?? '').trim()
  if (!trimmed) return null
  if (ASSET_UNIT_MEASURE_VALUES.includes(trimmed)) return trimmed
  return PRICING_UNIT_TO_ASSET_UNIT_MEASURE[trimmed] ?? null
}

function displayUnitMeasure(asset) {
  if (!asset) return null
  return (
    String(asset.unit_measure ?? '').trim()
    || mapPricingUnitToUnitMeasure(asset.unit_of_measure)
    || String(asset.unit_of_measure ?? '').trim()
    || null
  )
}

/** Brief non-blocking notice for undo results (asset-delete uses a main-process dialog instead). */
function showAppToast(message, { tone = 'info' } = {}) {
  if (!message || typeof document === 'undefined') return
  let host = document.getElementById('app-toast-host')
  if (!host) {
    host = document.createElement('div')
    host.id = 'app-toast-host'
    host.className = 'app-toast-host'
    host.setAttribute('aria-live', 'polite')
    document.body.appendChild(host)
  }
  const toast = document.createElement('div')
  toast.className = `app-toast app-toast--${tone}`
  toast.textContent = message
  host.appendChild(toast)
  window.setTimeout(() => {
    toast.classList.add('is-leaving')
    window.setTimeout(() => toast.remove(), 220)
  }, 3200)
}

let appHistoryInFlight = false

function isNativeTextEditableTarget(target) {
  if (!target) return false
  const el = target.nodeType === 1 ? target : target.parentElement
  if (!el || typeof el.closest !== 'function') return false
  if (el.isContentEditable || el.closest('[contenteditable="true"]')) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA') return true
  if (tag !== 'INPUT') return false
  const type = String(el.type || 'text').toLowerCase()
  return ![
    'button',
    'submit',
    'checkbox',
    'radio',
    'file',
    'reset',
    'image',
    'hidden',
    'range',
    'color',
  ].includes(type)
}

/**
 * Ctrl/Cmd+Z → undo; Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y → redo (main-process stack).
 * Leaves native per-field undo/redo alone while focus is in a text input/textarea.
 */
async function handleAppHistoryKeydown(event) {
  if (event.defaultPrevented) return
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return

  const key = String(event.key || '').toLowerCase()
  const isUndo = key === 'z' && !event.shiftKey
  const isRedo = (key === 'z' && event.shiftKey) || key === 'y'
  if (!isUndo && !isRedo) return

  // Prefer browser/OS text undo/redo while typing in fields.
  if (isNativeTextEditableTarget(event.target)) return

  const api = window.electronAPI
  if (isUndo && !api?.undoLastAction) return
  if (isRedo && !api?.redoLastAction) return

  event.preventDefault()
  if (appHistoryInFlight) return
  appHistoryInFlight = true
  try {
    try {
      await flushPendingRendererDrafts()
    } catch {
      showAppToast(
        `Could not save the current edit, so ${isUndo ? 'undo' : 'redo'} was not applied.`,
        { tone: 'error' },
      )
      return
    }

    if (isUndo) {
      const result = await api.undoLastAction()
      if (!result?.undone) {
        if (result?.error) {
          showAppToast(result.error, { tone: 'error' })
        } else if (result?.empty) {
          showAppToast('Nothing to undo')
        }
        return
      }

      // Asset deletion restore already showed a modal in the main process.
      if (result.notify !== 'dialog' && result.message) {
        showAppToast(result.message)
      }

      window.dispatchEvent(new CustomEvent('app-undo', { detail: result }))
      return
    }

    const result = await api.redoLastAction()
    if (!result?.redone) {
      if (result?.error) {
        showAppToast(result.error, { tone: 'error' })
      } else if (result?.empty) {
        showAppToast('Nothing to redo')
      }
      return
    }

    if (result.message) {
      showAppToast(result.message)
    }

    window.dispatchEvent(new CustomEvent('app-redo', { detail: result }))
  } catch (err) {
    showAppToast(String(err?.message ?? err), { tone: 'error' })
  } finally {
    appHistoryInFlight = false
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (event) => {
    void handleAppHistoryKeydown(event)
  })
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ASSET_UNIT_MEASURE_VALUES,
    PRICING_UNIT_TO_ASSET_UNIT_MEASURE,
    mapPricingUnitToUnitMeasure,
    displayUnitMeasure,
    toFileUrl,
  }
}
