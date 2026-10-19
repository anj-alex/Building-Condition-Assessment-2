const { projectId: activeProjectId, buildingId: activeBuildingId } = getActiveIds()
const summaryForm = document.getElementById('executive-summary-form')
const contextText = document.getElementById('executive-summary-context')
const autosaveStatus = document.getElementById('executive-summary-autosave-status')

const summaryFields = [
  'accessibility',
  'designated_substance_survey',
  'architectural_structural',
  'plumbing',
  'mechanical',
  'electrical',
  'fire_life_safety',
  'site',
  'code_compliance',
  'immediate_concerns',
  'facility_overview',
  'capital_needs',
]

/** Monotonic identities let an old promise prove whether it still owns a field. */
let nextGenerationRequestId = 0
/** @type {Map<string, number>} field -> current request identity */
const activeGenerationRequests = new Map()

function buildSummaryPayload() {
  const fd = new FormData(summaryForm)
  return Object.fromEntries(
    summaryFields.map((field) => [field, formTextValue(fd, field)]),
  )
}

const autosave = createFormAutosave({
  form: summaryForm,
  statusEl: autosaveStatus,
  buildPayload: buildSummaryPayload,
  canSave: () =>
    Boolean(activeBuildingId && window.electronAPI?.updateExecutiveSummary),
  save: async (payload) => {
    await window.electronAPI.updateExecutiveSummary(activeBuildingId, payload)
  },
})

autosave.bindForm()
const backButton = document.getElementById('back-home')
backButton?.addEventListener('click', () => invalidateSummaryGenerations())
window.addEventListener('pagehide', () => invalidateSummaryGenerations())
autosave.bindPagehide()
autosave.wireBack(backButton, () =>
  goBackHome(activeProjectId),
)

document.getElementById('clear-executive-summary')?.addEventListener('click', async () => {
  if (!activeBuildingId) return
  invalidateSummaryGenerations()
  const api = window.electronAPI
  if (!api?.deleteExecutiveSummary) return
  autosave.cancelPending()
  const result = await api.deleteExecutiveSummary(activeBuildingId)
  if (result?.canceled) return
  for (const field of summaryFields) {
    const input = summaryForm?.elements.namedItem(field)
    if (input) input.value = ''
    setSummaryStatus(field, '')
  }
  autosave.setStatus('')
})

async function loadContext() {
  if (!activeBuildingId || !contextText) return
  const api = window.electronAPI
  if (!api?.getBuilding) return
  const building = await api.getBuilding(activeBuildingId)
  if (!building) return
  const address = getBuildingAddress(building)
  contextText.textContent = address
    ? `${getBuildingTitle(building)} - ${address}`
    : getBuildingTitle(building)
}

async function loadExecutiveSummary() {
  if (!activeBuildingId || !summaryForm) return
  const api = window.electronAPI
  if (!api?.getExecutiveSummary) return
  const summary = await api.getExecutiveSummary(activeBuildingId)
  for (const field of summaryFields) {
    const input = summaryForm.elements.namedItem(field)
    if (input) input.value = summary?.[field] ?? ''
  }
}

function getGenerateButton(field) {
  return summaryForm?.querySelector(
    `.btn-ai-generate[data-summary-field="${CSS.escape(field)}"]`,
  )
}

function getStatusEl(field) {
  return summaryForm?.querySelector(
    `.field-ai-status[data-summary-status="${CSS.escape(field)}"]`,
  )
}

/**
 * @param {string} field
 * @param {string} message
 * @param {{ error?: boolean }} [options]
 */
function setSummaryStatus(field, message, options = {}) {
  const el = getStatusEl(field)
  if (!el) return
  const text = String(message ?? '').trim()
  if (!text) {
    el.hidden = true
    el.textContent = ''
    el.classList.remove('is-error')
    return
  }
  el.hidden = false
  el.textContent = text
  el.classList.toggle('is-error', Boolean(options.error))
}

/**
 * @param {string} field
 * @param {boolean} generating
 */
function setFieldGenerating(field, generating) {
  const btn = getGenerateButton(field)
  if (btn) {
    btn.disabled = generating
    btn.textContent = generating ? 'Generating…' : 'Generate with AI'
    btn.setAttribute('aria-busy', generating ? 'true' : 'false')
  }

  const input = summaryForm?.elements.namedItem(field)
  if (input && 'readOnly' in input) {
    input.readOnly = generating
  }
}

function beginSummaryGeneration(field) {
  const requestId = ++nextGenerationRequestId
  activeGenerationRequests.set(field, requestId)
  setFieldGenerating(field, true)
  return requestId
}

function ownsSummaryGeneration(field, requestId) {
  return activeGenerationRequests.get(field) === requestId
}

function finishSummaryGeneration(field, requestId) {
  if (!ownsSummaryGeneration(field, requestId)) return false
  activeGenerationRequests.delete(field)
  setFieldGenerating(field, false)
  return true
}

/**
 * Revoke every direct-generation promise before an authoritative user action.
 * The remote request may still finish, but it no longer owns text, status,
 * controls, or autosave on this page.
 */
function invalidateSummaryGenerations() {
  const fields = [...activeGenerationRequests.keys()]
  activeGenerationRequests.clear()
  for (const field of fields) {
    setFieldGenerating(field, false)
    setSummaryStatus(field, '')
  }
}

async function generateSummarySection(field) {
  if (!activeBuildingId || !summaryFields.includes(field)) return
  if (activeGenerationRequests.has(field)) return

  const api = window.electronAPI
  if (!api?.generateExecutiveSummarySection) {
    setSummaryStatus(field, 'AI generation is not available.', { error: true })
    return
  }

  const requestId = beginSummaryGeneration(field)
  setSummaryStatus(field, 'Generating summary…')

  try {
    const result = await api.generateExecutiveSummarySection(activeBuildingId, field)
    if (!ownsSummaryGeneration(field, requestId)) return
    if (!result?.ok) {
      setSummaryStatus(field, result?.error || 'Could not generate summary.', {
        error: true,
      })
      return
    }
    const input = summaryForm?.elements.namedItem(field)
    if (input) {
      input.value = result.text ?? ''
      // Mark dirty for autosave without relying solely on the synthetic event.
      autosave.markDirty()
      autosave.scheduleSave({ immediate: true })
    }
    setSummaryStatus(field, 'Generated — review the text (autosaved).')
  } catch (err) {
    if (!ownsSummaryGeneration(field, requestId)) return
    setSummaryStatus(field, String(err?.message ?? err), { error: true })
  } finally {
    finishSummaryGeneration(field, requestId)
  }
}

summaryForm?.addEventListener('click', (event) => {
  const btn = event.target?.closest?.('.btn-ai-generate[data-summary-field]')
  if (!btn || !summaryForm.contains(btn)) return
  event.preventDefault()
  const field = btn.getAttribute('data-summary-field')
  if (!field) return
  void generateSummarySection(field)
})

function handleExecutiveSummaryHistory(result) {
  if (!result?.undone && !result?.redone) return
  if (
    result.type === 'executive-summary-delete' ||
    result.type === 'executive-summary-update'
  ) {
    if (
      result.buildingId != null &&
      Number(result.buildingId) !== Number(activeBuildingId)
    ) {
      return
    }
    invalidateSummaryGenerations()
    autosave.cancelPending()
    void loadExecutiveSummary().then(() => {
      autosave.setStatus('')
    })
  }
}

window.addEventListener('app-undo', (event) => {
  handleExecutiveSummaryHistory(event.detail)
})
window.addEventListener('app-redo', (event) => {
  handleExecutiveSummaryHistory(event.detail)
})

void (async () => {
  try {
    await Promise.all([loadContext(), loadExecutiveSummary()])
  } catch (err) {
    console.warn('Failed to load executive summary:', err?.message || err)
  } finally {
    autosave.enable()
  }
})()
