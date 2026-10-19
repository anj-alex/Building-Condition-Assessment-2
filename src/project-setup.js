const { projectId: initialProjectId } = getActiveIds()
/** Mutable: set after first create when opening the form for a new project. */
let activeProjectId = initialProjectId

const setupTitle = document.querySelector('.setup-title')
const projectForm = document.getElementById('project-setup-form')
const autosaveStatus = document.getElementById('project-autosave-status')
const projectNumber = document.getElementById('project-number')
const clientInput = document.getElementById('client')

function buildProjectPayload() {
  const fd = new FormData(projectForm)
  return {
    client: String(fd.get('client') ?? '').trim() || null,
  }
}

function ensureDeleteButton() {
  const deleteSlot = document.getElementById('project-delete-slot')
  const api = window.electronAPI
  if (!deleteSlot || !api?.deleteProject || !activeProjectId) return
  if (deleteSlot.querySelector('.btn-danger')) return

  const deleteBtn = document.createElement('button')
  deleteBtn.type = 'button'
  deleteBtn.className = 'btn-danger'
  deleteBtn.textContent = 'Delete project'
  deleteBtn.addEventListener('click', async () => {
    autosave.dispose()
    const result = await api.deleteProject(activeProjectId)
    if (result?.canceled) {
      autosave.enable()
      return
    }
    await api.goHome()
  })
  deleteSlot.appendChild(deleteBtn)
}

const autosave = createFormAutosave({
  form: projectForm,
  statusEl: autosaveStatus,
  buildPayload: buildProjectPayload,
  canSave: () => Boolean(window.electronAPI?.createProject && window.electronAPI?.updateProject),
  save: async (payload) => {
    const api = window.electronAPI
    if (activeProjectId) {
      await api.updateProject(activeProjectId, payload)
      return
    }
    const created = await api.createProject(payload)
    const newId = Number(created?.id)
    if (!Number.isFinite(newId) || newId <= 0) {
      throw new Error('Create project did not return an id')
    }
    activeProjectId = newId
    location.hash = String(activeProjectId)
    if (projectNumber) projectNumber.value = String(activeProjectId)
    if (setupTitle) setupTitle.textContent = 'Edit project'
    ensureDeleteButton()
  },
})

autosave.bindForm()
autosave.bindPagehide()
autosave.wireBack(document.getElementById('back-home'), () =>
  goBackHome(activeProjectId),
)

async function bootstrapProjectSetup() {
  if (!activeProjectId) {
    autosave.enable()
    return
  }
  const api = window.electronAPI
  if (!api?.getProject) {
    autosave.enable()
    return
  }
  try {
    const project = await api.getProject(activeProjectId)
    if (!project) {
      autosave.enable()
      return
    }
    if (projectNumber) projectNumber.value = String(project.id)
    if (clientInput) clientInput.value = project.client ?? ''
    if (setupTitle) setupTitle.textContent = 'Edit project'
    ensureDeleteButton()
  } catch (err) {
    console.warn('Failed to load project:', err?.message || err)
  } finally {
    autosave.enable()
  }
}

function handleProjectSetupHistory(result) {
  if (!result?.undone && !result?.redone) return
  if (result.type === 'project-update' && result.projectId != null) {
    if (Number(result.projectId) !== Number(activeProjectId)) return
    autosave.cancelPending()
    void (async () => {
      const api = window.electronAPI
      if (!api?.getProject) return
      const project = await api.getProject(activeProjectId)
      if (clientInput) clientInput.value = project?.client ?? ''
      autosave.setStatus('')
    })()
  }
  if (result.type === 'project-delete') {
    if (result.redone) {
      void window.electronAPI?.goHome?.()
      return
    }
    // Undo restored a deleted project — leave form as-is if still editing another.
  }
}

window.addEventListener('app-undo', (event) => {
  handleProjectSetupHistory(event.detail)
})
window.addEventListener('app-redo', (event) => {
  handleProjectSetupHistory(event.detail)
})

void bootstrapProjectSetup()
