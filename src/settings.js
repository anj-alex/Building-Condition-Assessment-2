const themeSegments = Array.from(document.querySelectorAll('[data-theme-value]'))
const uniformatBtn = document.getElementById('uniformat-pricing-csv')
const uniformatShowInFolderBtn = document.getElementById('uniformat-show-in-folder')
const uniformatStatus = document.getElementById('uniformat-status')
const uniformatStatusLabel = document.getElementById('uniformat-status-label')
const uniformatStatusPath = document.getElementById('uniformat-status-path')
const exportAppDataBtn = document.getElementById('export-app-data')
const importAppDataBtn = document.getElementById('import-app-data')
const appDataStatus = document.getElementById('app-data-status')
const deletedProjectsList = document.getElementById('deleted-projects-list')
const deletedProjectsStatus = document.getElementById('deleted-projects-status')
const appAboutVersion = document.getElementById('app-about-version')
const appDebugInfo = document.getElementById('app-debug-info')
const copyAppDebugBtn = document.getElementById('copy-app-debug')
const appDebugStatus = document.getElementById('app-debug-status')
const aiStatusDetail = document.getElementById('ai-status-detail')
const aiActionStatus = document.getElementById('ai-action-status')
const aiUsagePanel = document.getElementById('ai-usage-panel')
const aiUsageTotal = document.getElementById('ai-usage-total')
const aiUsageRemaining = document.getElementById('ai-usage-remaining')
const aiUsageMonthly = document.getElementById('ai-usage-monthly')
const aiUsageMeta = document.getElementById('ai-usage-meta')
const aiUsageStatus = document.getElementById('ai-usage-status')
const aiUsageRefreshBtn = document.getElementById('ai-usage-refresh')
const aiGenerateBlankCaptionsBtn = document.getElementById('ai-generate-blank-captions')
const aiBulkModal = document.getElementById('ai-bulk-modal')
const aiBulkConfirm = document.getElementById('ai-bulk-confirm')
const aiBulkProgress = document.getElementById('ai-bulk-progress')
const aiBulkDone = document.getElementById('ai-bulk-done')
const aiBulkExplain = document.getElementById('ai-bulk-explain')
const aiBulkCounts = document.getElementById('ai-bulk-counts')
const aiBulkCancelBtn = document.getElementById('ai-bulk-cancel')
const aiBulkContinueBtn = document.getElementById('ai-bulk-continue')
const aiBulkCloseBtn = document.getElementById('ai-bulk-close')
const aiBulkProgressLabel = document.getElementById('ai-bulk-progress-label')
const aiBulkProgressBar = document.getElementById('ai-bulk-progress-bar')
const aiBulkProgressFill = document.getElementById('ai-bulk-progress-fill')
const aiBulkProgressCount = document.getElementById('ai-bulk-progress-count')
const aiBulkDoneSummary = document.getElementById('ai-bulk-done-summary')
const backHomeBtn = document.getElementById('back-home')

/** @type {null | (() => void)} */
let aiBulkUnsubscribers = null
let aiBulkLocked = false
/** @type {Set<string>} */
let aiBulkPendingKeys = new Set()
let aiBulkTotal = 0
let aiBulkCompleted = 0
let aiBulkFailed = 0

function captionBulkKey(kind, imageId) {
  return `caption:${kind === 'building' ? 'building' : 'asset'}:${Number(imageId)}`
}

function summaryBulkKey(buildingId, field) {
  return `summary:${Number(buildingId)}:${String(field)}`
}

function setAiBulkPhase(phase) {
  if (aiBulkConfirm) aiBulkConfirm.hidden = phase !== 'confirm'
  if (aiBulkProgress) aiBulkProgress.hidden = phase !== 'progress'
  if (aiBulkDone) aiBulkDone.hidden = phase !== 'done'
}

function updateAiBulkProgressUi() {
  const total = Math.max(0, aiBulkTotal)
  const done = Math.min(aiBulkCompleted, total)
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  if (aiBulkProgressFill) aiBulkProgressFill.style.width = `${pct}%`
  if (aiBulkProgressBar) {
    aiBulkProgressBar.setAttribute('aria-valuenow', String(pct))
    aiBulkProgressBar.setAttribute('aria-valuemax', '100')
  }
  if (aiBulkProgressCount) {
    aiBulkProgressCount.textContent = total > 0 ? `${done} / ${total}` : '0 / 0'
  }
  if (aiBulkProgressLabel) {
    if (total === 0) {
      aiBulkProgressLabel.textContent = 'Nothing to generate.'
    } else if (done >= total) {
      aiBulkProgressLabel.textContent = 'Finishing…'
    } else {
      aiBulkProgressLabel.textContent = `Generating ${done + 1} of ${total}…`
    }
  }
}

async function setBulkBusy(busy) {
  aiBulkLocked = Boolean(busy)
  if (backHomeBtn) {
    backHomeBtn.disabled = aiBulkLocked
    backHomeBtn.setAttribute('aria-disabled', aiBulkLocked ? 'true' : 'false')
  }
  const api = window.electronAPI
  if (api?.setAiBulkBusy) {
    try {
      await api.setAiBulkBusy(aiBulkLocked)
    } catch {
      // Navigation lock is best-effort; the modal still blocks the page.
    }
  }
}

function cleanupAiBulkListeners() {
  if (typeof aiBulkUnsubscribers === 'function') {
    aiBulkUnsubscribers()
    aiBulkUnsubscribers = null
  }
}

function closeAiBulkModal() {
  cleanupAiBulkListeners()
  aiBulkPendingKeys = new Set()
  aiBulkTotal = 0
  aiBulkCompleted = 0
  aiBulkFailed = 0
  if (aiBulkModal) aiBulkModal.hidden = true
  setAiBulkPhase('confirm')
  void setBulkBusy(false)
  if (aiGenerateBlankCaptionsBtn) aiGenerateBlankCaptionsBtn.disabled = false
}

function finishAiBulkRun() {
  cleanupAiBulkListeners()
  const okCount = Math.max(0, aiBulkCompleted - aiBulkFailed)
  const parts = [`Completed ${aiBulkCompleted} of ${aiBulkTotal}.`]
  if (aiBulkFailed > 0) {
    parts.push(`${aiBulkFailed} failed or were skipped.`)
  } else if (okCount > 0) {
    parts.push('Review captions and summary text before publishing.')
  }
  if (aiBulkDoneSummary) aiBulkDoneSummary.textContent = parts.join(' ')
  setAiBulkPhase('done')
  // Stay locked until the user clicks Done — they must acknowledge finish.
  updateAiBulkProgressUi()
  aiBulkCloseBtn?.focus()
}

function noteAiBulkJobFinished(key, payload) {
  if (!aiBulkPendingKeys.has(key)) return
  aiBulkPendingKeys.delete(key)
  aiBulkCompleted += 1
  if (payload && payload.ok === false && !payload.skipped) {
    aiBulkFailed += 1
  }
  updateAiBulkProgressUi()
  if (aiBulkPendingKeys.size === 0) {
    finishAiBulkRun()
  }
}

function openAiBulkConfirm(preview) {
  const captions = Number(preview?.captions) || 0
  const summaries = Number(preview?.summaries) || 0
  const missing = Number(preview?.missingFiles) || 0
  const total = captions + summaries

  if (aiBulkExplain) {
    aiBulkExplain.textContent =
      'This will fill empty photo captions and empty executive-summary sections using AI. You will not be able to leave or quit until this finishes.'
  }

  if (aiBulkCounts) {
    if (total === 0) {
      aiBulkCounts.textContent =
        preview?.message ||
        (missing > 0
          ? 'No blank fields with usable files were found.'
          : 'No blank captions or summary sections were found.')
    } else {
      const bits = []
      if (captions > 0) {
        bits.push(`${captions} photo caption${captions === 1 ? '' : 's'}`)
      }
      if (summaries > 0) {
        bits.push(`${summaries} summary section${summaries === 1 ? '' : 's'}`)
      }
      let text = `About to generate ${bits.join(' and ')}.`
      if (missing > 0) {
        text += ` ${missing} image${missing === 1 ? '' : 's'} will be skipped (missing file).`
      }
      aiBulkCounts.textContent = text
    }
  }

  if (aiBulkContinueBtn) {
    aiBulkContinueBtn.disabled = total === 0
    aiBulkContinueBtn.hidden = total === 0
  }
  if (aiBulkCancelBtn) {
    aiBulkCancelBtn.textContent = total === 0 ? 'Close' : 'Cancel'
  }

  setAiBulkPhase('confirm')
  if (aiBulkModal) aiBulkModal.hidden = false
  ;(total === 0 ? aiBulkCancelBtn : aiBulkContinueBtn)?.focus()
}

async function startAiBulkGeneration() {
  const api = window.electronAPI
  if (!api?.generateBlankFields) return

  setAiBulkPhase('progress')
  if (aiBulkProgressLabel) aiBulkProgressLabel.textContent = 'Queuing jobs…'
  if (aiBulkProgressFill) aiBulkProgressFill.style.width = '0%'
  if (aiBulkProgressCount) aiBulkProgressCount.textContent = '…'
  await setBulkBusy(true)

  cleanupAiBulkListeners()
  aiBulkPendingKeys = new Set()
  aiBulkTotal = 0
  aiBulkCompleted = 0
  aiBulkFailed = 0

  /** Buffer finished events that arrive before pending keys are known. */
  let armed = false
  /** @type {Array<[string, object]>} */
  const earlyFinished = []

  function handleFinished(key, payload) {
    if (!armed) {
      earlyFinished.push([key, payload])
      return
    }
    noteAiBulkJobFinished(key, payload)
  }

  const unsubs = []
  if (api.onCaptionUpdated) {
    unsubs.push(
      api.onCaptionUpdated((payload) => {
        if (payload?.state !== 'finished') return
        handleFinished(captionBulkKey(payload.kind, payload.imageId), payload)
      }),
    )
  }
  if (api.onSummaryUpdated) {
    unsubs.push(
      api.onSummaryUpdated((payload) => {
        if (payload?.state !== 'finished') return
        handleFinished(summaryBulkKey(payload.buildingId, payload.field), payload)
      }),
    )
  }
  aiBulkUnsubscribers = () => {
    for (const unsub of unsubs) unsub()
  }

  try {
    const result = await api.generateBlankFields()
    if (!result?.ok) {
      cleanupAiBulkListeners()
      if (aiBulkDoneSummary) {
        aiBulkDoneSummary.textContent = result?.error || 'Could not start generation.'
      }
      setAiBulkPhase('done')
      return
    }

    for (const job of result.captionJobs ?? []) {
      aiBulkPendingKeys.add(captionBulkKey(job.kind, job.imageId))
    }
    for (const job of result.summaryJobs ?? []) {
      aiBulkPendingKeys.add(summaryBulkKey(job.buildingId, job.field))
    }
    aiBulkTotal = aiBulkPendingKeys.size
    armed = true
    for (const [key, payload] of earlyFinished) {
      noteAiBulkJobFinished(key, payload)
    }
    updateAiBulkProgressUi()

    if (aiBulkTotal === 0) {
      if (aiBulkDoneSummary) {
        aiBulkDoneSummary.textContent = result.message || 'Nothing to generate.'
      }
      cleanupAiBulkListeners()
      setAiBulkPhase('done')
      return
    }

    if (aiBulkPendingKeys.size === 0) {
      finishAiBulkRun()
    }
  } catch (err) {
    cleanupAiBulkListeners()
    if (aiBulkDoneSummary) {
      aiBulkDoneSummary.textContent = `Could not start generation: ${err?.message ?? err}`
    }
    setAiBulkPhase('done')
  }
}

if (aiBulkCancelBtn) {
  aiBulkCancelBtn.addEventListener('click', () => {
    if (aiBulkLocked) return
    closeAiBulkModal()
  })
}

if (aiBulkContinueBtn) {
  aiBulkContinueBtn.addEventListener('click', () => {
    void startAiBulkGeneration()
  })
}

if (aiBulkCloseBtn) {
  aiBulkCloseBtn.addEventListener('click', () => {
    closeAiBulkModal()
    void refreshAiUsage()
  })
}

document.addEventListener('keydown', (event) => {
  if (!aiBulkModal || aiBulkModal.hidden) return
  if (event.key !== 'Escape') return
  // Confirm phase may cancel; progress/done stay locked until Done (done allows close via button only for Escape? User said can't exit during generation. Done phase can Escape to close.)
  if (aiBulkProgress && !aiBulkProgress.hidden) {
    event.preventDefault()
    event.stopPropagation()
    return
  }
  if (aiBulkDone && !aiBulkDone.hidden) {
    event.preventDefault()
    closeAiBulkModal()
    void refreshAiUsage()
    return
  }
  event.preventDefault()
  closeAiBulkModal()
})

if (backHomeBtn) {
  backHomeBtn.addEventListener(
    'click',
    (event) => {
      if (!aiBulkLocked) return
      event.preventDefault()
      event.stopImmediatePropagation()
    },
    true,
  )
}

if (aiGenerateBlankCaptionsBtn) {
  aiGenerateBlankCaptionsBtn.addEventListener('click', async () => {
    const api = window.electronAPI
    if (!api?.previewBlankFields) return
    aiGenerateBlankCaptionsBtn.disabled = true
    setAiUsageStatus('')
    try {
      const preview = await api.previewBlankFields()
      if (!preview?.ok) {
        setAiUsageStatus(preview?.error || 'Could not preview blank fields.')
        aiGenerateBlankCaptionsBtn.disabled = false
        return
      }
      openAiBulkConfirm(preview)
      // Keep the trigger disabled while the modal is open.
    } catch (err) {
      setAiUsageStatus(`Could not preview blank fields: ${err?.message ?? err}`)
      aiGenerateBlankCaptionsBtn.disabled = false
    }
  })
}

/** @type {Record<string, string|boolean|null|undefined>|null} */
let cachedAppInfo = null

const APP_DEBUG_FIELDS = [
  ['Version', 'version'],
  ['Name', 'name'],
  ['Packaged', 'packaged'],
  ['Electron', 'electron'],
  ['Chromium', 'chrome'],
  ['Node', 'node'],
  ['V8', 'v8'],
  ['Platform', 'platform'],
  ['Arch', 'arch'],
  ['OS', 'osType'],
  ['OS release', 'osRelease'],
  ['Locale', 'locale'],
  ['User data', 'userDataPath'],
  ['Database', 'dbPath'],
  ['App path', 'appPath'],
  ['Executable', 'execPath'],
]

function formatDebugValue(value) {
  if (value == null || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  return String(value)
}

function formatAppDebugText(info) {
  if (!info) return ''
  return APP_DEBUG_FIELDS.map(([label, key]) => `${label}: ${formatDebugValue(info[key])}`).join(
    '\n',
  )
}

function renderAppDebugInfo(info) {
  cachedAppInfo = info
  if (appAboutVersion && info?.version) {
    appAboutVersion.textContent = `Version ${info.version}`
  }
  if (!appDebugInfo || !info) return
  appDebugInfo.replaceChildren()
  for (const [label, key] of APP_DEBUG_FIELDS) {
    const dt = document.createElement('dt')
    dt.className = 'settings-debug-term'
    dt.textContent = label
    const dd = document.createElement('dd')
    dd.className = 'settings-debug-value'
    dd.textContent = formatDebugValue(info[key])
    appDebugInfo.append(dt, dd)
  }
}

async function loadAppDebugInfo() {
  const api = window.electronAPI
  if (!api?.getAppInfo) return
  try {
    const info = await api.getAppInfo()
    renderAppDebugInfo(info)
  } catch (err) {
    if (appDebugStatus) {
      appDebugStatus.textContent = `Could not load app info: ${err?.message ?? err}`
    }
  }
}

function setAiActionStatus(message) {
  if (aiActionStatus) aiActionStatus.textContent = message || ''
}

function setAiUsageStatus(message) {
  if (aiUsageStatus) aiUsageStatus.textContent = message || ''
}

function clearAiUsageDisplay() {
  if (aiUsageTotal) aiUsageTotal.textContent = '—'
  if (aiUsageRemaining) aiUsageRemaining.textContent = '—'
  if (aiUsageMonthly) aiUsageMonthly.textContent = '—'
  if (aiUsageMeta) aiUsageMeta.textContent = ''
  setAiUsageStatus('')
}

function renderAiUsage(usage) {
  if (!usage?.ok) {
    clearAiUsageDisplay()
    if (usage?.error) setAiUsageStatus(usage.error)
    return
  }

  const display = usage.display || {}
  if (aiUsageTotal) aiUsageTotal.textContent = display.usage || '—'
  if (aiUsageMonthly) aiUsageMonthly.textContent = display.usageMonthly || '—'
  if (aiUsageRemaining) {
    aiUsageRemaining.textContent = display.limitRemaining || '—'
  }

  const hasKeyLimit = usage.limit != null && Number.isFinite(Number(usage.limit))
  const metaParts = []
  if (usage.label) metaParts.push(`Key: ${usage.label}`)
  if (hasKeyLimit) {
    metaParts.push(`Key limit: ${display.limit || '—'}`)
    if (usage.limitReset) metaParts.push(`Resets: ${usage.limitReset}`)
  } else {
    metaParts.push('No per-key spending cap')
  }
  if (usage.isFreeTier) metaParts.push('Free tier account')
  if (aiUsageMeta) aiUsageMeta.textContent = metaParts.join(' · ')
  setAiUsageStatus('')
}

function renderAiStatus(status) {
  if (!status) return
  const configured = Boolean(status.configured)
  const unlocked = Boolean(status.unlocked)

  if (aiStatusDetail) {
    if (!configured) {
      aiStatusDetail.textContent =
        'No encrypted OpenRouter key package is present. Set OPENROUTER_API_KEY in .env and restart (or run npm run encrypt-openrouter-key).'
    } else if (!unlocked) {
      aiStatusDetail.textContent =
        'The secret package is present but could not be loaded into the session.'
    } else {
      aiStatusDetail.textContent = ''
    }
  }

  if (aiUsagePanel) {
    aiUsagePanel.hidden = !unlocked
  }
  if (!unlocked) {
    clearAiUsageDisplay()
  }
}

/** Ignore stale usage responses when refreshes overlap. */
let aiUsageRequestId = 0

async function refreshAiUsage() {
  const api = window.electronAPI
  if (!api?.getAiUsage) return
  const requestId = ++aiUsageRequestId
  if (aiUsageRefreshBtn) aiUsageRefreshBtn.disabled = true
  setAiUsageStatus('Loading usage…')
  try {
    const usage = await api.getAiUsage()
    if (requestId !== aiUsageRequestId) return
    renderAiUsage(usage)
  } catch (err) {
    if (requestId !== aiUsageRequestId) return
    clearAiUsageDisplay()
    setAiUsageStatus(`Could not load usage: ${err?.message ?? err}`)
  } finally {
    if (requestId === aiUsageRequestId && aiUsageRefreshBtn) {
      aiUsageRefreshBtn.disabled = false
    }
  }
}

async function refreshAiStatus() {
  const api = window.electronAPI
  if (!api?.getAiStatus) return
  try {
    const status = await api.getAiStatus()
    renderAiStatus(status)
    if (status?.unlocked) {
      await refreshAiUsage()
    }
  } catch (err) {
    setAiActionStatus(`Could not load AI status: ${err?.message ?? err}`)
  }
}

function syncThemeSegmentUi() {
  const preference = getThemePreference()
  for (const button of themeSegments) {
    const selected = button.dataset.themeValue === preference
    button.classList.toggle('is-selected', selected)
    button.setAttribute('aria-checked', selected ? 'true' : 'false')
    button.tabIndex = selected ? 0 : -1
  }
}

function selectThemeSegment(button) {
  if (!button?.dataset?.themeValue) return
  setThemePreference(button.dataset.themeValue)
  syncThemeSegmentUi()
  button.focus()
}

function updateUniformatStatus(info) {
  if (!info) return
  const isDefault = Boolean(info.isDefault)
  const workingPath = info.path || ''
  // Prefer the path the user last chose so the Settings card updates when they
  // pick a new file (the working copy under userData always has the same path).
  const displayPath = !isDefault && info.sourcePath ? info.sourcePath : workingPath
  const displayName = isDefault
    ? 'Default pricing list'
    : info.fileName || 'Custom pricing file'

  if (uniformatStatus) {
    uniformatStatus.classList.toggle('is-custom', !isDefault)
  }
  if (uniformatStatusLabel) {
    uniformatStatusLabel.textContent = displayName
  }
  if (uniformatStatusPath) {
    uniformatStatusPath.textContent = displayPath
    if (!displayPath) {
      uniformatStatusPath.title = ''
    } else if (!isDefault && workingPath && info.sourcePath && info.sourcePath !== workingPath) {
      uniformatStatusPath.title = `Chosen file:\n${info.sourcePath}\n\nWorking copy (editable):\n${workingPath}`
    } else {
      uniformatStatusPath.title = displayPath
    }
  }
  if (uniformatBtn) {
    const fullLabel = isDefault
      ? 'Unit pricing file (default)'
      : `Unit pricing file: ${info.fileName || 'custom'}`
    uniformatBtn.title = workingPath ? `${fullLabel}\n${workingPath}` : fullLabel
    uniformatBtn.setAttribute(
      'aria-label',
      isDefault
        ? 'Choose unit pricing file'
        : `Change unit pricing file (${info.fileName || 'custom'})`,
    )
  }
  if (uniformatShowInFolderBtn) {
    const hasPath = Boolean(workingPath)
    uniformatShowInFolderBtn.disabled = !hasPath
    uniformatShowInFolderBtn.setAttribute(
      'aria-label',
      hasPath
        ? 'Show unit pricing file in folder'
        : 'Show unit pricing file in folder (unavailable)',
    )
    uniformatShowInFolderBtn.title = hasPath
      ? `Open folder and select:\n${workingPath}`
      : 'Pricing file location is not available yet'
  }
}

let uniformatReloadInFlight = false
let uniformatReloadQueued = false
let uniformatChooseInFlight = false

async function syncUniformatStatus({ reload = false } = {}) {
  const api = window.electronAPI
  if (!api) return
  // Dialog close restores focus while chooseCsv may still be importing; skip
  // so we do not paint stale status over the in-flight selection.
  if (uniformatChooseInFlight) {
    if (reload) uniformatReloadQueued = true
    return
  }

  if (reload && api.reloadUniformatPricingFromDisk) {
    // Collapse overlapping focus + visibilitychange reloads into one pass.
    if (uniformatReloadInFlight) {
      uniformatReloadQueued = true
      return
    }
    uniformatReloadInFlight = true
    try {
      do {
        uniformatReloadQueued = false
        if (uniformatChooseInFlight) {
          uniformatReloadQueued = true
          return
        }
        const result = await api.reloadUniformatPricingFromDisk()
        if (uniformatChooseInFlight) {
          uniformatReloadQueued = true
          return
        }
        updateUniformatStatus(result)
      } while (uniformatReloadQueued)
    } finally {
      uniformatReloadInFlight = false
    }
    return
  }

  if (!api.getUniformatPricingCsvPath) return
  updateUniformatStatus(await api.getUniformatPricingCsvPath())
}

wireBackHome(document.getElementById('back-home'))

for (const button of themeSegments) {
  button.addEventListener('click', () => {
    selectThemeSegment(button)
  })
  button.addEventListener('keydown', (event) => {
    const delta = {
      ArrowLeft: -1,
      ArrowUp: -1,
      ArrowRight: 1,
      ArrowDown: 1,
    }[event.key]
    if (delta == null) return
    event.preventDefault()
    const index = themeSegments.indexOf(button)
    if (index < 0) return
    const next = themeSegments[(index + delta + themeSegments.length) % themeSegments.length]
    selectThemeSegment(next)
  })
}
syncThemeSegmentUi()

if (uniformatBtn) {
  uniformatBtn.addEventListener('click', async () => {
    const api = window.electronAPI
    if (!api?.chooseUniformatPricingCsv || uniformatChooseInFlight) return
    uniformatChooseInFlight = true
    try {
      const result = await api.chooseUniformatPricingCsv()
      updateUniformatStatus(result)
    } finally {
      uniformatChooseInFlight = false
      // If focus/visibility queued a reload during the dialog, run one now.
      if (uniformatReloadQueued) {
        void syncUniformatStatus({ reload: true })
      }
    }
  })
}

if (uniformatShowInFolderBtn) {
  uniformatShowInFolderBtn.addEventListener('click', async () => {
    const api = window.electronAPI
    if (!api?.showUniformatPricingCsvInFolder) return
    const result = await api.showUniformatPricingCsvInFolder()
    if (result?.path || result?.fileName) {
      updateUniformatStatus(result)
    }
  })
}

// Re-seed from the working CSV when Settings is shown again so Explorer edits apply.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void syncUniformatStatus({ reload: true })
  }
})
window.addEventListener('focus', () => {
  void syncUniformatStatus({ reload: true })
})

function setAppDataStatus(message) {
  if (appDataStatus) appDataStatus.textContent = message || ''
}

function setAppDataBusy(busy) {
  if (exportAppDataBtn) exportAppDataBtn.disabled = busy
  if (importAppDataBtn) importAppDataBtn.disabled = busy
}

/** @type {Array<{id: number, client?: string|null}>} */
let deletedProjects = []
/** @type {Set<number>} */
const recoveringDeletedProjectIds = new Set()
let deletedProjectsRequestId = 0

function deletedProjectLabel(project) {
  const client = String(project?.client ?? '').trim()
  const id = Number(project?.id)
  return client || (Number.isFinite(id) && id > 0 ? `Project #${id}` : 'Untitled project')
}

function setDeletedProjectsStatus(message) {
  if (deletedProjectsStatus) deletedProjectsStatus.textContent = message || ''
}

function renderDeletedProjects() {
  if (!deletedProjectsList) return
  deletedProjectsList.replaceChildren()

  if (deletedProjects.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'settings-field-hint'
    empty.textContent = 'No deleted projects to recover.'
    deletedProjectsList.appendChild(empty)
    return
  }

  const list = document.createElement('ul')
  list.className = 'settings-deleted-projects-list'
  for (const project of deletedProjects) {
    const id = Number(project?.id)
    if (!Number.isSafeInteger(id) || id <= 0) continue

    const item = document.createElement('li')
    item.className = 'settings-deleted-projects-item'

    const copy = document.createElement('div')
    copy.className = 'settings-deleted-projects-copy'
    const title = document.createElement('p')
    title.className = 'settings-deleted-projects-title'
    title.textContent = deletedProjectLabel(project)
    const meta = document.createElement('p')
    meta.className = 'settings-deleted-projects-id'
    meta.textContent = `Project #${id}`
    copy.append(title, meta)

    const restoreBtn = document.createElement('button')
    restoreBtn.type = 'button'
    restoreBtn.className = 'btn-secondary'
    restoreBtn.textContent = recoveringDeletedProjectIds.has(id) ? 'Recovering…' : 'Recover'
    restoreBtn.disabled = recoveringDeletedProjectIds.has(id)
    restoreBtn.addEventListener('click', () => {
      void recoverDeletedProject(project)
    })

    item.append(copy, restoreBtn)
    list.appendChild(item)
  }
  deletedProjectsList.appendChild(list)
}

async function loadDeletedProjects() {
  const api = window.electronAPI
  if (!api?.listDeletedProjects) return
  const requestId = ++deletedProjectsRequestId
  try {
    const result = await api.listDeletedProjects()
    if (requestId !== deletedProjectsRequestId) return
    deletedProjects = Array.isArray(result) ? result : []
    renderDeletedProjects()
  } catch (err) {
    if (requestId !== deletedProjectsRequestId) return
    deletedProjects = []
    renderDeletedProjects()
    setDeletedProjectsStatus(`Could not load deleted projects: ${err?.message ?? err}`)
  }
}

async function recoverDeletedProject(project) {
  const api = window.electronAPI
  const id = Number(project?.id)
  if (
    !api?.restoreDeletedProject ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    recoveringDeletedProjectIds.has(id)
  ) {
    return
  }

  recoveringDeletedProjectIds.add(id)
  renderDeletedProjects()
  const label = deletedProjectLabel(project)
  setDeletedProjectsStatus(`Recovering “${label}”…`)
  try {
    const result = await api.restoreDeletedProject(id)
    if (!result?.ok) {
      setDeletedProjectsStatus(result?.error || `Could not recover “${label}”.`)
      return
    }
    setDeletedProjectsStatus(`Recovered “${result.label || label}”.`)
    await loadDeletedProjects()
  } catch (err) {
    setDeletedProjectsStatus(`Could not recover “${label}”: ${err?.message ?? err}`)
  } finally {
    recoveringDeletedProjectIds.delete(id)
    if (deletedProjects.some((entry) => Number(entry?.id) === id)) {
      renderDeletedProjects()
    }
  }
}

function refreshDeletedProjectsAfterHistory(result) {
  if (!result?.undone && !result?.redone) return
  if (result.type !== 'project-delete' && result.type !== 'project-recovery') return
  void loadDeletedProjects()
}

window.addEventListener('app-undo', (event) => {
  refreshDeletedProjectsAfterHistory(event.detail)
})
window.addEventListener('app-redo', (event) => {
  refreshDeletedProjectsAfterHistory(event.detail)
})

if (exportAppDataBtn) {
  exportAppDataBtn.addEventListener('click', async () => {
    const api = window.electronAPI
    if (!api?.exportAppData) return
    setAppDataBusy(true)
    setAppDataStatus('Saving backup…')
    try {
      const result = await api.exportAppData()
      if (result?.canceled) {
        setAppDataStatus(
          result.error ? `Could not save backup: ${result.error}` : 'Backup canceled.',
        )
      } else {
        setAppDataStatus(
          result?.filePath ? `Backup saved to ${result.filePath}` : 'Backup saved.',
        )
      }
    } catch (err) {
      setAppDataStatus(`Could not save backup: ${err?.message ?? err}`)
    } finally {
      setAppDataBusy(false)
    }
  })
}

if (importAppDataBtn) {
  importAppDataBtn.addEventListener('click', async () => {
    const api = window.electronAPI
    if (!api?.importAppData) return
    setAppDataBusy(true)
    setAppDataStatus('Restoring backup…')
    try {
      const result = await api.importAppData()
      // Successful import navigates home; only show status on cancel/error.
      if (result?.canceled) {
        setAppDataStatus(
          result.error ? `Could not restore backup: ${result.error}` : 'Restore canceled.',
        )
      }
    } catch (err) {
      setAppDataStatus(`Could not restore backup: ${err?.message ?? err}`)
    } finally {
      setAppDataBusy(false)
    }
  })
}

if (copyAppDebugBtn) {
  copyAppDebugBtn.addEventListener('click', async () => {
    const text = formatAppDebugText(cachedAppInfo)
    if (!text) {
      if (appDebugStatus) appDebugStatus.textContent = 'Debug info is not loaded yet.'
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      if (appDebugStatus) appDebugStatus.textContent = 'Debug info copied to clipboard.'
    } catch (err) {
      if (appDebugStatus) {
        appDebugStatus.textContent = `Could not copy: ${err?.message ?? err}`
      }
    }
  })
}

if (aiUsageRefreshBtn) {
  aiUsageRefreshBtn.addEventListener('click', () => {
    void refreshAiUsage()
  })
}

// Refresh usage when returning to Settings while unlocked.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && aiUsagePanel && !aiUsagePanel.hidden) {
    void refreshAiUsage()
  }
})

void syncUniformatStatus({ reload: true })
void refreshAiStatus()
void loadDeletedProjects()
void loadAppDebugInfo()
