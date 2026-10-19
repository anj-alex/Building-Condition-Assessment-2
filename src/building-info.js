const { projectId: activeProjectId, buildingId: initialBuildingId } = getActiveIds()
/** Mutable: set after first create when opening the form for a new building. */
let activeBuildingId = initialBuildingId
/** Building detail to restore on home when leaving this page (e.g. add-property from assets). */
const returnBuildingId = consumeHomeReturnBuildingId()
const buildingForm = document.getElementById('building-info-form')
if (buildingForm && activeProjectId) {
  buildingForm.dataset.projectId = String(activeProjectId)
}

const projectClientText = document.getElementById('project-client')
const setupTitle = document.querySelector('.setup-title')
const autosaveStatus = document.getElementById('building-autosave-status')
const addBuildingPhotosBtn = document.getElementById('add-building-photos')
const buildingPhotoPreview = document.getElementById('building-photo-preview')
const locationFactorKey = document.getElementById('location-factor-key')
const locationFactorInput = document.getElementById('location-factor')

let locationFactorOptions = []

function goHomeFromBuildingInfo() {
  // Only restore a building when the home page asked for it (session key).
  // Do not fall back to the building being edited — that would open assets after
  // Edit / Add from the property list.
  return window.electronAPI?.goHome?.({
    selectProjectId: activeProjectId,
    selectBuildingId: returnBuildingId || undefined,
  })
}

function locationKey(province, city) {
  if (!province || !city) return ''
  return `${province}::${city}`
}

async function loadLocationFactors() {
  const api = window.electronAPI
  if (!api?.listLocationFactors || !locationFactorKey) return
  locationFactorOptions = await api.listLocationFactors()
  locationFactorKey.replaceChildren()
  const custom = document.createElement('option')
  custom.value = ''
  custom.textContent = 'Custom / neutral (1.0)'
  locationFactorKey.appendChild(custom)
  for (const row of locationFactorOptions) {
    const option = document.createElement('option')
    option.value = locationKey(row.province, row.city)
    option.textContent = `${row.label} (${row.factor})`
    locationFactorKey.appendChild(option)
  }
}

if (locationFactorKey && locationFactorInput) {
  locationFactorKey.addEventListener('change', () => {
    const selected = locationFactorOptions.find(
      (row) => locationKey(row.province, row.city) === locationFactorKey.value,
    )
    if (selected) {
      locationFactorInput.value = String(selected.factor)
    } else if (!locationFactorInput.value) {
      locationFactorInput.value = '1'
    }
  })
  locationFactorInput.addEventListener('input', () => {
    if (!locationFactorKey.value) return
    const selected = locationFactorOptions.find(
      (row) => locationKey(row.province, row.city) === locationFactorKey.value,
    )
    if (!selected || String(selected.factor) !== String(locationFactorInput.value).trim()) {
      locationFactorKey.value = ''
    }
  })
}

function renderBuildingImages(images = []) {
  if (!buildingPhotoPreview) return
  buildingPhotoPreview.replaceChildren()
  if (!activeBuildingId) {
    const empty = document.createElement('p')
    empty.className = 'building-photo-empty'
    empty.textContent = 'Start editing to create this property, then add photos.'
    buildingPhotoPreview.appendChild(empty)
    return
  }
  if (images.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'building-photo-empty'
    empty.textContent = 'No photos added yet.'
    buildingPhotoPreview.appendChild(empty)
    return
  }
  for (const image of images) {
    const item = document.createElement('figure')
    item.className = 'building-photo-item'

    const img = document.createElement('img')
    img.src = image.media_url ?? toFileUrl(image.file_path)
    img.alt = image.caption || image.original_name || 'Property photo'
    item.appendChild(img)

    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.className = 'building-photo-delete-btn'
    deleteBtn.setAttribute(
      'aria-label',
      `Delete ${image.caption || image.original_name || `photo ${image.id}`}`,
    )
    deleteBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 7h12v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7Zm3 3v9h2v-9H9Zm4 0v9h2v-9h-2ZM9 4h6v2H9V4Zm-4 0h5V2h4v2h5v2H5V4Z"></path></svg>'
    deleteBtn.addEventListener('click', async () => {
      const api = window.electronAPI
      if (!api?.deleteBuildingImage) return
      const result = await api.deleteBuildingImage(image.id)
      if (result?.canceled) return
      renderBuildingImages(await api.listBuildingImages(activeBuildingId))
    })
    item.appendChild(deleteBtn)

    const caption = document.createElement('figcaption')
    caption.textContent = image.caption || image.original_name || `Photo #${image.id}`
    item.appendChild(caption)
    buildingPhotoPreview.appendChild(item)
  }
}

async function loadBuildingImages() {
  if (!activeBuildingId) {
    renderBuildingImages([])
    return
  }
  const api = window.electronAPI
  if (!api?.listBuildingImages) return
  renderBuildingImages(await api.listBuildingImages(activeBuildingId))
}

function syncPhotoControls() {
  if (addBuildingPhotosBtn) {
    addBuildingPhotosBtn.disabled = !activeBuildingId
  }
}

if (addBuildingPhotosBtn) {
  syncPhotoControls()
  addBuildingPhotosBtn.addEventListener('click', async () => {
    if (!activeBuildingId) return
    const api = window.electronAPI
    if (!api?.importPropertyImages) return
    renderBuildingImages(await api.importPropertyImages(activeBuildingId))
  })
}

async function loadProjectClient() {
  if (!activeProjectId || !projectClientText) return
  const api = window.electronAPI
  if (!api?.getProject) return
  const project = await api.getProject(activeProjectId)
  const client = String(project?.client ?? '').trim()
  projectClientText.textContent = client || `Project #${activeProjectId}`
}

function buildBuildingPayload() {
  const fd = new FormData(buildingForm)
  const selectedKey = formTextValue(fd, 'location_factor_key')
  const selected = locationFactorOptions.find(
    (row) => locationKey(row.province, row.city) === selectedKey,
  )
  return {
    project_id: activeProjectId,
    property_name: formTextValue(fd, 'property_name'),
    address: formTextValue(fd, 'address'),
    city: formTextValue(fd, 'city'),
    province: formTextValue(fd, 'province'),
    province_short: formTextValue(fd, 'province_short'),
    postal_code: formTextValue(fd, 'postal_code'),
    gross_floor_area_m2: formNumberValue(fd, 'gross_floor_area_m2'),
    property_vintage: formNumberValue(fd, 'property_vintage'),
    date_of_assessment: formTextValue(fd, 'date_of_assessment'),
    num_floors: formNumberValue(fd, 'num_floors'),
    location_factor_province: selected?.province ?? null,
    location_factor_city: selected?.city ?? null,
    location_factor: selected?.factor ?? formNumberValue(fd, 'location_factor') ?? 1,
    current_replacement_value: formNumberValue(fd, 'current_replacement_value'),
  }
}

function ensureDeleteButton() {
  const deleteSlot = document.getElementById('building-delete-slot')
  const api = window.electronAPI
  if (!deleteSlot || !api?.deleteBuilding || !activeBuildingId) return
  if (deleteSlot.querySelector('.btn-danger')) return

  const deleteBtn = document.createElement('button')
  deleteBtn.type = 'button'
  deleteBtn.className = 'btn-danger'
  deleteBtn.textContent = 'Delete building'
  deleteBtn.addEventListener('click', async () => {
    autosave.dispose()
    const result = await api.deleteBuilding(activeBuildingId)
    if (result?.canceled) {
      // Re-enable after cancel — form still valid.
      allowReenableAfterDeleteCancel()
      return
    }
    await api.goHome({ selectProjectId: activeProjectId })
  })
  deleteSlot.appendChild(deleteBtn)
}

function allowReenableAfterDeleteCancel() {
  // createFormAutosave dispose is terminal; re-bootstrap enable flag via enable().
  // enable() also clears dirty — fine after cancel.
  autosave.enable()
}

const autosave = createFormAutosave({
  form: buildingForm,
  statusEl: autosaveStatus,
  buildPayload: buildBuildingPayload,
  canSave: () =>
    Boolean(
      activeProjectId &&
        window.electronAPI?.createBuilding &&
        window.electronAPI?.updateBuilding,
    ),
  save: async (payload) => {
    const api = window.electronAPI
    if (activeBuildingId) {
      await api.updateBuilding(activeBuildingId, payload)
      return
    }
    const created = await api.createBuilding(payload)
    const newId = Number(created?.id)
    if (!Number.isFinite(newId) || newId <= 0) {
      throw new Error('Create building did not return an id')
    }
    activeBuildingId = newId
    if (activeProjectId) {
      location.hash = `${activeProjectId}:${activeBuildingId}`
    }
    if (setupTitle) setupTitle.textContent = 'Edit building information'
    syncPhotoControls()
    ensureDeleteButton()
    void loadBuildingImages()
  },
})

autosave.bindForm()
autosave.bindPagehide()
autosave.wireBack(document.getElementById('back-home'), () => goHomeFromBuildingInfo())

async function loadBuilding() {
  if (!activeBuildingId || !buildingForm) return
  const api = window.electronAPI
  if (!api?.getBuilding) return
  const building = await api.getBuilding(activeBuildingId)
  if (!building) return
  setInputValueById('property-name', building.property_name)
  setInputValueById('address', building.address)
  setInputValueById('city', building.city)
  setInputValueById('province', building.province)
  setInputValueById('province-short', building.province_short)
  setInputValueById('postal-code', building.postal_code)
  setInputValueById('gross-floor-area-m2', building.gross_floor_area_m2)
  setInputValueById('property-vintage', building.property_vintage)
  setInputValueById('date-of-assessment', building.date_of_assessment)
  setInputValueById('num-floors', building.num_floors)
  setInputValueById('location-factor', building.location_factor ?? 1)
  setInputValueById('current-replacement-value', building.current_replacement_value)
  if (locationFactorKey) {
    locationFactorKey.value = locationKey(
      building.location_factor_province,
      building.location_factor_city,
    )
  }
  if (setupTitle) setupTitle.textContent = 'Edit building information'
  ensureDeleteButton()
}

function handleBuildingInfoHistory(result) {
  if (!result?.undone && !result?.redone) return
  if (result.type === 'building-image-delete') {
    void loadBuildingImages()
  }
  if (result.type === 'building-update') {
    if (
      result.buildingId != null &&
      Number(result.buildingId) !== Number(activeBuildingId)
    ) {
      return
    }
    autosave.cancelPending()
    void loadBuilding().then(() => {
      autosave.setStatus('')
    })
  }
  if (result.type === 'building-delete' && result.buildingId != null) {
    if (result.redone) {
      void goHomeFromBuildingInfo()
      return
    }
    autosave.cancelPending()
    void loadBuilding()
    void loadBuildingImages()
  }
}

window.addEventListener('app-undo', (event) => {
  handleBuildingInfoHistory(event.detail)
})
window.addEventListener('app-redo', (event) => {
  handleBuildingInfoHistory(event.detail)
})

if (window.electronAPI?.onCaptionUpdated) {
  window.electronAPI.onCaptionUpdated((payload) => {
    if (payload?.kind === 'building' && payload?.ok) {
      void loadBuildingImages()
    }
  })
}

void loadLocationFactors()
  .catch((error) => {
    console.warn('Failed to load location factors:', error?.message || error)
  })
  .finally(() => {
    void (async () => {
      try {
        await loadBuilding()
      } catch (error) {
        console.warn('Failed to load building:', error?.message || error)
      } finally {
        autosave.enable()
      }
    })()
  })
void loadProjectClient()
void loadBuildingImages()
