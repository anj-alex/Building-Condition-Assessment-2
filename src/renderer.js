const startNewBtn = document.getElementById('start-new-project')
const addPropertyBtn = document.getElementById('add-property')
const generateProjectReportBtn = document.getElementById('generate-project-report')
const importExcelBtn = document.getElementById('import-excel')
const importModal = document.getElementById('import-modal')
const importModalLabel = document.getElementById('import-modal-label')
const homeTopActions = document.querySelector('.home-top-actions')
const firmDetailsBtn = document.getElementById('firm-details')
const openSettingsBtn = document.getElementById('open-settings')
const homeMain = document.getElementById('home-main')
const projectsSection = document.getElementById('projects-section')
const projectListWrap = document.getElementById('project-list-wrap')
const propertyListWrap = document.getElementById('property-list-wrap')
const propertiesSection = document.getElementById('properties-section')
const selectedProjectTitle = document.getElementById('selected-project-title')
const buildingDetailSection = document.getElementById('building-detail-section')
const buildingDetailHeader = document.getElementById('building-detail-header')
const buildingDetailTabs = document.getElementById('building-detail-tabs')
const buildingDetailPanel = document.getElementById('building-detail-panel')

const homeState = {
  projects: [],
  buildings: [],
  uniformatLevel1Groups: [],
  assets: [],
  buildingImages: new Map(),
  assetImages: new Map(),
  selectedProjectId: null,
  selectedBuildingId: null,
  activeBuildingTab: null,
  openAssetIds: new Set(),
  assetsLoading: false,
  assetLoadToken: 0,
  galleryAssetId: null,
  galleryImageIndex: 0,
}

/** Flush every home-page draft, then retire asset controllers before a rebuild. */
async function settleHomeEditors() {
  await flushPendingRendererDrafts()
  disposeAllAssetFormControllers()
}

async function navigateAfterHomeFlush(navigate) {
  await flushPendingRendererDrafts()
  return navigate()
}

/** Caption jobs currently queued or running in the main process. */
const captionGenerationKeys = new Set()

function captionGenerationKey(kind, imageId) {
  const id = Number(imageId)
  if (!Number.isFinite(id) || id <= 0) return null
  return `${kind === 'building' ? 'building' : 'asset'}:${id}`
}

function isImageCaptionGenerating(kind, imageId) {
  const key = captionGenerationKey(kind, imageId)
  return key ? captionGenerationKeys.has(key) : false
}

function setImageCaptionGenerating(kind, imageId, generating) {
  const key = captionGenerationKey(kind, imageId)
  if (!key) return
  if (generating) captionGenerationKeys.add(key)
  else captionGenerationKeys.delete(key)
  if (kind !== 'asset') return

  setImageCaptionGenerationControls(imageId, generating)
  const status = document.querySelector(
    `[data-gallery-image-status="${Number(imageId)}"]`,
  )
  if (!status) return
  if (generating) {
    status.dataset.captionGenerating = 'true'
    status.textContent = 'Generating caption…'
    status.classList.remove('is-error')
    return
  }
  if (status.dataset.captionGenerating === 'true') {
    delete status.dataset.captionGenerating
    if (!renderGalleryDraftSaveErrors(status)) status.textContent = ''
  }
}

function syncCaptionGenerationJobs(jobs) {
  const nextKeys = new Set()
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const key = captionGenerationKey(job?.kind, job?.imageId)
    if (key) nextKeys.add(key)
  }
  for (const key of captionGenerationKeys) {
    if (nextKeys.has(key)) continue
    const [kind, imageId] = key.split(':')
    setImageCaptionGenerating(kind, Number(imageId), false)
  }
  for (const key of nextKeys) {
    const [kind, imageId] = key.split(':')
    setImageCaptionGenerating(kind, Number(imageId), true)
  }
}

/** Capture window + asset-list scroll so undo reloads do not jump to the top. */
function captureHomeScroll() {
  const list = document.querySelector('.home-asset-list')
  return {
    windowX: window.scrollX,
    windowY: window.scrollY,
    assetListY: list != null ? list.scrollTop : null,
  }
}

function restoreHomeScroll(snapshot) {
  if (!snapshot) return
  const apply = () => {
    window.scrollTo(snapshot.windowX, snapshot.windowY)
    if (snapshot.assetListY == null) return
    const list = document.querySelector('.home-asset-list')
    if (list) list.scrollTop = snapshot.assetListY
  }
  apply()
  // Layout can settle after list rebuild / images; re-apply for a frame or two.
  requestAnimationFrame(() => {
    apply()
    requestAnimationFrame(apply)
  })
}

/** Switch Uniformat Level-1 tab when undo targets an asset on another section. */
function applyUndoLevel1Tab(level1Group) {
  if (!level1Group) return false
  const tabs = getBuildingSectionTabs()
  if (!tabs.includes(level1Group)) return false
  if (homeState.activeBuildingTab === level1Group) return false
  homeState.activeBuildingTab = level1Group
  return true
}

/** Only explicit navigation supplies an id (e.g. new project or back from another page). */
function resolveInitialSelection(projects, pendingId) {
  if (pendingId == null) return null
  const candidate = Number(pendingId)
  if (!Number.isFinite(candidate) || candidate <= 0) return null
  return projects.some((p) => p.id === candidate) ? candidate : null
}

function getProjectSelectLines(p) {
  const client = String(p.client ?? '').trim()
  return { primary: client || `Project #${p.id}`, secondary: '' }
}

function projectSelectAriaLabel(lines) {
  return lines.secondary
    ? `${lines.primary}, ${lines.secondary}`
    : lines.primary
}

function renderProjectList(projects) {
  if (!projectListWrap) return
  projectListWrap.replaceChildren()
  if (projects.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'home-empty'
    empty.textContent = 'No projects yet. Start a new project to begin.'
    projectListWrap.appendChild(empty)
    return
  }
  const ul = document.createElement('ul')
  ul.className = 'home-select-list'
  ul.setAttribute('aria-label', 'Available projects')
  for (const p of projects) {
    const li = document.createElement('li')
    li.className = 'home-select-item'
    const selectBtn = document.createElement('button')
    selectBtn.type = 'button'
    selectBtn.className = 'home-select-row'
    selectBtn.setAttribute(
      'aria-pressed',
      p.id === homeState.selectedProjectId ? 'true' : 'false',
    )
    selectBtn.dataset.projectId = String(p.id)
    const lines = getProjectSelectLines(p)
    selectBtn.setAttribute('aria-label', projectSelectAriaLabel(lines))
    selectBtn.replaceChildren()
    const primaryEl = document.createElement('span')
    primaryEl.className = 'home-select-row-primary'
    primaryEl.textContent = lines.primary
    selectBtn.appendChild(primaryEl)
    if (lines.secondary) {
      const secondaryEl = document.createElement('span')
      secondaryEl.className = 'home-select-row-secondary'
      secondaryEl.textContent = lines.secondary
      selectBtn.appendChild(secondaryEl)
    }
    if (p.id === homeState.selectedProjectId) {
      selectBtn.classList.add('is-selected')
    }
    selectBtn.addEventListener('click', () => {
      void selectProject(p.id)
        .catch(() => {})
        .finally(() => {
          document.querySelector(`[data-project-id="${p.id}"]`)?.focus()
        })
    })

    const editBtn = document.createElement('button')
    editBtn.type = 'button'
    editBtn.className = 'home-edit-project-btn'
    editBtn.setAttribute(
      'aria-label',
      `Edit ${projectSelectAriaLabel(lines)}`,
    )
    editBtn.title = 'Edit project'
    editBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15.2 3.4a2.1 2.1 0 0 1 3 0l2.4 2.4a2.1 2.1 0 0 1 0 3L9.3 20.1 4 21l.9-5.3L15.2 3.4Zm1.4 1.4L6.8 14.6l-.5 2.9 2.9-.5 9.8-9.8-2.4-2.4Z"></path></svg>'
    editBtn.addEventListener('click', (event) => {
      event.stopPropagation()
      void navigateAfterHomeFlush(() => window.electronAPI?.openProjectSetup(p.id)).catch(() => {})
    })

    li.appendChild(selectBtn)
    li.appendChild(editBtn)

    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.className = 'home-delete-icon-btn home-delete-project-btn'
    deleteBtn.setAttribute('aria-label', `Delete ${projectSelectAriaLabel(lines)}`)
    deleteBtn.title = 'Delete project'
    deleteBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 7h12v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7Zm3 3v9h2v-9H9Zm4 0v9h2v-9h-2ZM9 4h6v2H9V4Zm-4 0h5V2h4v2h5v2H5V4Z"></path></svg>'
    deleteBtn.addEventListener('click', async (event) => {
      event.stopPropagation()
      const api = window.electronAPI
      if (!api?.deleteProject) return
      const result = await api.deleteProject(p.id)
      if (result?.canceled) return
      if (homeState.selectedProjectId === p.id) {
        homeState.selectedProjectId = null
        homeState.selectedBuildingId = null
      }
      await syncHome(homeState.selectedProjectId)
    })

    li.appendChild(deleteBtn)
    ul.appendChild(li)
  }
  projectListWrap.appendChild(ul)
}

function renderPropertyList(buildings) {
  if (!propertyListWrap) return
  propertyListWrap.replaceChildren()
  if (buildings.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'home-empty'
    empty.textContent = 'No properties for this project yet.'
    propertyListWrap.appendChild(empty)
    return
  }
  const ul = document.createElement('ul')
  ul.className = 'home-property-list'
  for (const b of buildings) {
    const li = document.createElement('li')
    li.className = 'home-property-item'
    const isSelected = b.id === homeState.selectedBuildingId
    const title = b.property_name?.trim() || `Property #${b.id}`
    const parts = [b.address, b.city, b.province].filter(Boolean)
    const sub = parts.length ? parts.join(', ') : null
    const row = document.createElement('div')
    row.className = 'home-property-row'
    if (isSelected) {
      row.classList.add('is-selected')
    }

    // The action buttons must not be nested inside the primary selection
    // control. Keep them as siblings so the row exposes five real buttons to
    // keyboard and assistive-technology users instead of one pointer-only div.
    const selectBtn = document.createElement('button')
    selectBtn.type = 'button'
    selectBtn.className = 'home-property-select'
    selectBtn.dataset.buildingId = String(b.id)
    selectBtn.setAttribute('aria-pressed', isSelected ? 'true' : 'false')
    selectBtn.setAttribute('aria-label', sub ? `${title}, ${sub}` : title)
    selectBtn.addEventListener('click', () => {
      void selectBuilding(b.id)
        .catch(() => {})
        .finally(() => {
          if (homeState.selectedBuildingId === b.id) {
            document.querySelector('.home-detail-tab[aria-selected="true"]')?.focus()
          } else {
            document.querySelector(`[data-building-id="${b.id}"]`)?.focus()
          }
        })
    })

    const textWrap = document.createElement('div')
    textWrap.className = 'home-property-row-text'
    const strong = document.createElement('strong')
    strong.textContent = title
    textWrap.appendChild(strong)
    if (sub) {
      const span = document.createElement('span')
      span.className = 'home-property-meta'
      span.textContent = sub
      textWrap.appendChild(span)
    }

    selectBtn.appendChild(textWrap)

    const images = homeState.buildingImages.get(b.id) ?? []
    if (images.length > 0) {
      const previewList = document.createElement('span')
      previewList.className = 'home-property-row-images'
      const showMore = images.length > 4
      const previewImages = images.slice(0, showMore ? 3 : 4)
      for (const image of previewImages) {
        const preview = document.createElement('img')
        preview.src = image.media_url ?? toFileUrl(image.file_path)
        preview.alt = image.caption || image.original_name || 'Property image'
        previewList.appendChild(preview)
      }
      if (showMore) {
        const more = document.createElement('span')
        more.className = 'home-property-row-image-more'
        more.textContent = `+${images.length - 3}`
        previewList.appendChild(more)
      }
      selectBtn.appendChild(previewList)
    }

    const actions = document.createElement('div')
    actions.className = 'home-property-actions'

    const editBtn = document.createElement('button')
    editBtn.type = 'button'
    editBtn.className = 'home-property-action-btn'
    editBtn.setAttribute('aria-label', `Edit ${title}`)
    editBtn.title = 'Edit property'
    editBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15.2 3.4a2.1 2.1 0 0 1 3 0l2.4 2.4a2.1 2.1 0 0 1 0 3L9.3 20.1 4 21l.9-5.3L15.2 3.4Zm1.4 1.4L6.8 14.6l-.5 2.9 2.9-.5 9.8-9.8-2.4-2.4Z"></path></svg>'
    editBtn.addEventListener('click', () => {
      if (homeState.selectedProjectId == null) return
      void navigateAfterHomeFlush(() => {
        setHomeReturnBuildingId(null)
        return window.electronAPI?.editBuildingInfo(homeState.selectedProjectId, b.id)
      }).catch(() => {})
    })
    actions.appendChild(editBtn)

    const summaryBtn = document.createElement('button')
    summaryBtn.type = 'button'
    summaryBtn.className = 'home-property-action-btn'
    summaryBtn.setAttribute('aria-label', `Exec Summary for ${title}`)
    summaryBtn.title = 'Exec Summary'
    summaryBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 2h6a1 1 0 0 1 1 1v1h2a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2V3a1 1 0 0 1 1-1zm0 2v1h6V4H9zm-1 5h8v1.5H8V9zm0 3.5h8V14H8v-1.5zm0 3.5h5V17.5H8V16z"></path></svg>'
    summaryBtn.addEventListener('click', () => {
      if (homeState.selectedProjectId == null) return
      void navigateAfterHomeFlush(() =>
        window.electronAPI?.editExecutiveSummary(homeState.selectedProjectId, b.id),
      ).catch(() => {})
    })
    actions.appendChild(summaryBtn)

    const reportBtn = document.createElement('button')
    reportBtn.type = 'button'
    reportBtn.className = 'home-property-action-btn'
    reportBtn.setAttribute('aria-label', `Generate report for ${title}`)
    reportBtn.title = 'Generate report'
    reportBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 3h12v5H6V3Zm-2 7h16a2 2 0 0 1 2 2v6h-4v4H6v-4H2v-6a2 2 0 0 1 2-2Zm2 8h8v-3H6v3Zm12-5.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM6 12h12v2H6v-2Z"></path></svg>'
    reportBtn.addEventListener('click', () => {
      if (homeState.selectedProjectId == null) return
      void navigateAfterHomeFlush(() =>
        window.electronAPI?.openPropertyReport(homeState.selectedProjectId, b.id),
      ).catch(() => {})
    })
    actions.appendChild(reportBtn)

    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.className = 'home-property-action-btn home-property-action-btn--danger'
    deleteBtn.setAttribute('aria-label', `Delete ${title}`)
    deleteBtn.title = 'Delete'
    deleteBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 7h12v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7Zm3 3v9h2v-9H9Zm4 0v9h2v-9h-2ZM9 4h6v2H9V4Zm-4 0h5V2h4v2h5v2H5V4Z"></path></svg>'
    deleteBtn.addEventListener('click', async () => {
      const api = window.electronAPI
      if (!api?.deleteBuilding) return
      const result = await api.deleteBuilding(b.id)
      if (result?.canceled) return
      if (homeState.selectedBuildingId === b.id) {
        homeState.selectedBuildingId = null
      }
      await syncHome(homeState.selectedProjectId)
    })
    actions.appendChild(deleteBtn)
    row.append(selectBtn, actions)

    li.appendChild(row)
    ul.appendChild(li)
  }
  propertyListWrap.appendChild(ul)
}

function renderPropertiesSection() {
  if (!propertiesSection) return
  const hasSelection = homeState.selectedProjectId != null
  const hasBuildingSelection = homeState.selectedBuildingId != null
  propertiesSection.hidden = !hasSelection
  if (projectsSection) {
    projectsSection.hidden = hasBuildingSelection
  }
  if (selectedProjectTitle) {
    selectedProjectTitle.hidden = !hasBuildingSelection
    if (hasBuildingSelection) {
      const project =
        homeState.projects.find((p) => p.id === homeState.selectedProjectId) ?? null
      selectedProjectTitle.replaceChildren()
      if (project) {
        const lines = getProjectSelectLines(project)
        const primary = document.createElement('span')
        primary.className = 'home-selected-project-primary'
        primary.textContent = lines.primary
        selectedProjectTitle.appendChild(primary)
        if (lines.secondary) {
          const secondary = document.createElement('span')
          secondary.className = 'home-selected-project-secondary'
          secondary.textContent = lines.secondary
          selectedProjectTitle.appendChild(secondary)
        }
      }
    } else {
      selectedProjectTitle.replaceChildren()
    }
  }
  if (generateProjectReportBtn) {
    generateProjectReportBtn.disabled = !hasSelection || homeState.buildings.length === 0
  }
  if (importExcelBtn) {
    // Import needs a project to import into, but not existing properties.
    importExcelBtn.disabled = !hasSelection
  }
  if (!hasSelection) {
    propertyListWrap?.replaceChildren()
    return
  }
  renderPropertyList(homeState.buildings)
}

/**
 * Building picker for a whole-project report. Every property starts checked; the
 * report page renders each selected building, in list order, into one document
 * so a single export covers the project.
 */
function openProjectReportPicker() {
  if (homeState.selectedProjectId == null) return
  const buildings = homeState.buildings
  if (buildings.length === 0) return
  if (document.getElementById('project-report-picker')) return

  const selectedIds = new Set(buildings.map((b) => b.id))

  const overlay = document.createElement('div')
  overlay.id = 'project-report-picker'
  overlay.className = 'home-modal'
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closePicker()
  })

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closePicker()
      return
    }

    if (event.key === 'Tab') {
      const focusable = [...dialog.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.closest('[hidden]'))
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
  }

  function closePicker() {
    document.removeEventListener('keydown', onKeyDown, true)
    overlay.remove()
    generateProjectReportBtn?.focus()
  }

  const dialog = document.createElement('div')
  dialog.className = 'home-modal-dialog'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'project-report-picker-title')
  dialog.tabIndex = -1

  const heading = document.createElement('h2')
  heading.className = 'home-modal-title'
  heading.id = 'project-report-picker-title'
  heading.textContent = 'Generate project report'
  const note = document.createElement('p')
  note.className = 'home-modal-note'
  note.textContent =
    'Choose the properties to include. Each one keeps its own cover page and page numbering.'
  dialog.append(heading, note)

  const toolbar = document.createElement('div')
  toolbar.className = 'home-modal-toolbar'
  const list = document.createElement('div')
  list.className = 'home-modal-list'
  const checkboxes = new Map()

  const setAll = (checked) => {
    for (const [id, input] of checkboxes) {
      input.checked = checked
      if (checked) selectedIds.add(id)
      else selectedIds.delete(id)
    }
    updateGenerate()
  }

  const selectAllBtn = document.createElement('button')
  selectAllBtn.type = 'button'
  selectAllBtn.className = 'home-modal-link-btn'
  selectAllBtn.textContent = 'Select all'
  selectAllBtn.addEventListener('click', () => setAll(true))
  const clearAllBtn = document.createElement('button')
  clearAllBtn.type = 'button'
  clearAllBtn.className = 'home-modal-link-btn'
  clearAllBtn.textContent = 'Clear all'
  clearAllBtn.addEventListener('click', () => setAll(false))
  toolbar.append(selectAllBtn, clearAllBtn)
  dialog.appendChild(toolbar)

  for (const b of buildings) {
    const row = document.createElement('label')
    row.className = 'home-modal-row'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = true
    input.addEventListener('change', () => {
      if (input.checked) selectedIds.add(b.id)
      else selectedIds.delete(b.id)
      updateGenerate()
    })
    checkboxes.set(b.id, input)

    const textWrap = document.createElement('span')
    textWrap.className = 'home-modal-row-text'
    const title = document.createElement('strong')
    title.textContent = getBuildingTitle(b)
    textWrap.appendChild(title)
    const address = getBuildingAddress(b)
    if (address) {
      const meta = document.createElement('span')
      meta.className = 'home-modal-row-meta'
      meta.textContent = address
      textWrap.appendChild(meta)
    }

    row.append(input, textWrap)
    list.appendChild(row)
  }
  dialog.appendChild(list)

  const footer = document.createElement('div')
  footer.className = 'home-modal-footer'
  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'home-action-btn home-action-btn--inline'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.addEventListener('click', closePicker)
  const generateBtn = document.createElement('button')
  generateBtn.type = 'button'
  generateBtn.className = 'home-action-btn home-action-btn--inline home-action-btn--primary'
  generateBtn.addEventListener('click', () => {
    const ids = buildings.map((b) => b.id).filter((id) => selectedIds.has(id))
    if (ids.length === 0) return
    void navigateAfterHomeFlush(() => {
      closePicker()
      return window.electronAPI?.openPropertyReport(homeState.selectedProjectId, ids)
    }).catch(() => {})
  })
  footer.append(cancelBtn, generateBtn)
  dialog.appendChild(footer)

  function updateGenerate() {
    generateBtn.disabled = selectedIds.size === 0
    generateBtn.textContent =
      selectedIds.size === 1
        ? 'Generate report (1 property)'
        : `Generate report (${selectedIds.size} properties)`
  }
  updateGenerate()

  overlay.appendChild(dialog)
  document.body.appendChild(overlay)
  // Capture phase so Escape closes the picker before the page-level handlers run.
  document.addEventListener('keydown', onKeyDown, true)
  checkboxes.values().next().value?.focus()
}

function getSelectedBuilding() {
  return homeState.buildings.find((b) => b.id === homeState.selectedBuildingId) ?? null
}

function getBuildingSectionTabs() {
  return homeState.uniformatLevel1Groups.map((group) => group.name)
}

function getFirstBuildingSectionTab() {
  return getBuildingSectionTabs()[0] ?? null
}

function buildingTabId(label) {
  return `building-tab-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

async function clearSelectedBuilding() {
  await settleHomeEditors()
  homeState.selectedBuildingId = null
  homeState.openAssetIds.clear()
  homeState.assets = []
  homeState.assetImages = new Map()
  homeState.galleryAssetId = null
  homeState.galleryImageIndex = 0
  renderImageGalleryNow()
  await renderHome()
}

function renderBuildingDetailHeader(project, building) {
  if (!buildingDetailHeader) return
  buildingDetailHeader.replaceChildren()

  const backBtn = document.createElement('button')
  backBtn.type = 'button'
  backBtn.className = 'home-detail-back-btn'
  backBtn.textContent = 'Back'
  backBtn.addEventListener('click', () => {
    void clearSelectedBuilding().catch(() => {})
  })
  buildingDetailHeader.appendChild(backBtn)

  const info = document.createElement('div')
  info.className = 'home-detail-info'

  const projectLines = project ? getProjectSelectLines(project) : null
  if (projectLines) {
    const projectTitle = document.createElement('div')
    projectTitle.className = 'home-detail-project-title'
    const primary = document.createElement('span')
    primary.className = 'home-selected-project-primary'
    primary.textContent = projectLines.primary
    projectTitle.appendChild(primary)
    if (projectLines.secondary) {
      const secondary = document.createElement('span')
      secondary.className = 'home-selected-project-secondary'
      secondary.textContent = projectLines.secondary
      projectTitle.appendChild(secondary)
    }
    info.appendChild(projectTitle)
  }

  const propertyItem = document.createElement('div')
  propertyItem.className = 'home-detail-property-picker'

  const propertyMenu = document.createElement('details')
  propertyMenu.className = 'home-property-menu'
  const propertySummary = document.createElement('summary')
  const propertyName = document.createElement('span')
  propertyName.className = 'home-property-menu-name'
  propertyName.textContent = getBuildingTitle(building)
  propertySummary.appendChild(propertyName)
  const address = getBuildingAddress(building)
  if (address) {
    const propertyAddress = document.createElement('span')
    propertyAddress.className = 'home-property-menu-address'
    propertyAddress.textContent = address
    propertySummary.appendChild(propertyAddress)
  }
  propertyMenu.appendChild(propertySummary)

  const propertyOptions = document.createElement('div')
  propertyOptions.className = 'home-property-menu-options'
  propertyOptions.setAttribute('role', 'menu')
  for (const option of homeState.buildings) {
    const optionBtn = document.createElement('button')
    optionBtn.type = 'button'
    optionBtn.className = 'home-property-menu-option'
    optionBtn.setAttribute('role', 'menuitem')
    if (option.id === building.id) optionBtn.classList.add('is-selected')
    optionBtn.textContent = getBuildingTitle(option)
    optionBtn.addEventListener('click', () => {
      propertyMenu.open = false
      if (option.id !== homeState.selectedBuildingId) {
        void selectBuilding(option.id)
      }
    })
    propertyOptions.appendChild(optionBtn)
  }

  const addPropertyOption = document.createElement('button')
  addPropertyOption.type = 'button'
  addPropertyOption.className = 'home-property-menu-option home-property-menu-option--add'
  addPropertyOption.setAttribute('role', 'menuitem')
  addPropertyOption.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z"></path></svg><span>Add new property</span>'
  addPropertyOption.addEventListener('click', () => {
    propertyMenu.open = false
    if (homeState.selectedProjectId == null) return
    void navigateAfterHomeFlush(() => {
      // Return to this building's asset page after Back on building-info.
      setHomeReturnBuildingId(homeState.selectedBuildingId)
      return window.electronAPI?.openBuildingInfo(homeState.selectedProjectId)
    }).catch(() => {})
  })
  propertyOptions.appendChild(addPropertyOption)

  propertyMenu.appendChild(propertyOptions)
  propertyItem.appendChild(propertyMenu)
  info.appendChild(propertyItem)

  buildingDetailHeader.appendChild(info)
}

function renderAssetList() {
  const wrap = document.createElement('div')
  wrap.className = 'home-assets'

  const toolbar = document.createElement('div')
  toolbar.className = 'home-assets-toolbar'
  const heading = document.createElement('div')
  heading.className = 'home-assets-heading'
  const title = document.createElement('h2')
  title.className = 'home-assets-title'
  title.textContent = homeState.activeBuildingTab
  heading.appendChild(title)
  const addAssetBtn = document.createElement('button')
  addAssetBtn.type = 'button'
  addAssetBtn.className = 'home-action-btn home-action-btn--inline home-action-btn--primary'
  addAssetBtn.textContent = 'Add asset'
  addAssetBtn.addEventListener('click', async () => {
    const api = window.electronAPI
    const building = getSelectedBuilding()
    if (!building || !homeState.activeBuildingTab || !api?.createAsset) return
    try {
      await settleHomeEditors()
      const created = await api.createAsset(building.id, homeState.activeBuildingTab)
      if (created?.id != null) {
        homeState.openAssetIds.add(created.id)
      }
      await loadActiveAssets()
    } catch {
      // A save error is already visible in the editor that remains on screen.
    }
  })
  heading.appendChild(addAssetBtn)
  toolbar.appendChild(heading)

  const actions = document.createElement('div')
  actions.className = 'home-assets-actions'
  const openAllBtn = document.createElement('button')
  openAllBtn.type = 'button'
  openAllBtn.className = 'home-action-btn home-action-btn--inline'
  openAllBtn.textContent = 'Open all'
  openAllBtn.addEventListener('click', () => {
    void (async () => {
      await settleHomeEditors()
      homeState.openAssetIds = new Set(homeState.assets.map((asset) => asset.id))
      await renderBuildingDetail()
    })().catch(() => {})
  })
  const closeAllBtn = document.createElement('button')
  closeAllBtn.type = 'button'
  closeAllBtn.className = 'home-action-btn home-action-btn--inline'
  closeAllBtn.textContent = 'Close all'
  closeAllBtn.addEventListener('click', () => {
    void (async () => {
      await settleHomeEditors()
      homeState.openAssetIds.clear()
      await renderBuildingDetail()
    })().catch(() => {})
  })
  actions.appendChild(openAllBtn)
  actions.appendChild(closeAllBtn)
  toolbar.appendChild(actions)
  wrap.appendChild(toolbar)

  if (homeState.assetsLoading) {
    const loading = document.createElement('p')
    loading.className = 'home-empty home-assets-empty'
    loading.textContent = 'Loading assets...'
    wrap.appendChild(loading)
    return wrap
  }

  if (homeState.assets.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'home-empty home-assets-empty'
    empty.textContent = 'No assets have been added for this section yet.'
    wrap.appendChild(empty)
    return wrap
  }

  const list = document.createElement('ul')
  list.className = 'home-asset-list'
  for (const asset of homeState.assets) {
    const isOpen = homeState.openAssetIds.has(asset.id)
    const item = document.createElement('li')
    item.className = 'home-asset-item'
    item.dataset.assetId = String(asset.id)
    if (isOpen) item.classList.add('is-open')

    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'home-asset-row'
    row.setAttribute('aria-expanded', isOpen ? 'true' : 'false')
    row.addEventListener('click', () => {
      void (async () => {
        await settleHomeEditors()
        if (homeState.openAssetIds.has(asset.id)) {
          homeState.openAssetIds.delete(asset.id)
        } else {
          homeState.openAssetIds.add(asset.id)
        }
        await renderBuildingDetail()
      })().catch(() => {})
    })

    const textWrap = document.createElement('span')
    textWrap.className = 'home-asset-row-text'
    const name = document.createElement('strong')
    name.textContent = asset.asset_name?.trim() || `Asset #${asset.id}`
    textWrap.appendChild(name)
    const summaryText = getAssetSummary(asset)
    if (summaryText) {
      const summary = document.createElement('span')
      summary.className = 'home-asset-summary'
      summary.textContent = summaryText
      textWrap.appendChild(summary)
    }
    row.appendChild(textWrap)

    const images = homeState.assetImages.get(asset.id) ?? []
    if (images.length > 0) {
      const previewList = document.createElement('span')
      previewList.className = 'home-asset-row-images'
      for (const image of images.slice(0, 3)) {
        previewList.appendChild(
          createAnnotatedThumb('span', 'home-asset-row-image', image),
        )
      }
      if (images.length > 3) {
        const more = document.createElement('span')
        more.className = 'home-asset-row-image-more'
        more.textContent = `+${images.length - 3}`
        previewList.appendChild(more)
      }
      row.appendChild(previewList)
    }
    item.appendChild(row)

    if (isOpen) item.appendChild(createAssetForm(asset))
    list.appendChild(item)
  }
  wrap.appendChild(list)
  return wrap
}

async function renderBuildingDetail() {
  if (!buildingDetailSection || !buildingDetailTabs || !buildingDetailPanel) return
  // Persist dirty fields, then drop timers before the panel is rebuilt.
  await settleHomeEditors()
  const building = getSelectedBuilding()
  const hasSelection = building != null
  buildingDetailSection.hidden = !hasSelection
  homeMain?.classList.toggle('has-building-selection', hasSelection)
  if (!hasSelection) {
    buildingDetailHeader?.replaceChildren()
    buildingDetailTabs.replaceChildren()
    buildingDetailPanel.replaceChildren()
    return
  }

  const project =
    homeState.projects.find((p) => p.id === homeState.selectedProjectId) ?? null
  renderBuildingDetailHeader(project, building)

  buildingDetailTabs.replaceChildren()
  const buildingSectionTabs = getBuildingSectionTabs()
  if (buildingSectionTabs.length === 0) {
    buildingDetailPanel.replaceChildren()
    const empty = document.createElement('p')
    empty.className = 'home-empty'
    empty.textContent = 'No building sections are available.'
    buildingDetailPanel.appendChild(empty)
    return
  }

  const activateBuildingTab = async (label) => {
    await settleHomeEditors()
    homeState.activeBuildingTab = label
    homeState.openAssetIds.clear()
    await loadActiveAssets()
    document.getElementById(buildingTabId(label))?.focus()
  }
  for (const label of buildingSectionTabs) {
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.className = 'home-detail-tab'
    tab.id = buildingTabId(label)
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-controls', 'building-detail-panel')
    const isActive = label === homeState.activeBuildingTab
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false')
    tab.tabIndex = isActive ? 0 : -1
    if (isActive) {
      tab.classList.add('is-active')
    }
    tab.textContent = label
    tab.addEventListener('click', () => {
      void activateBuildingTab(label).catch(() => {
        // The current form and selected tab stay intact when its flush fails.
      })
    })
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const currentIndex = buildingSectionTabs.indexOf(label)
      const nextIndex =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buildingSectionTabs.length - 1
            : event.key === 'ArrowLeft'
              ? (currentIndex - 1 + buildingSectionTabs.length) % buildingSectionTabs.length
              : (currentIndex + 1) % buildingSectionTabs.length
      void activateBuildingTab(buildingSectionTabs[nextIndex]).catch(() => {})
    })
    buildingDetailTabs.appendChild(tab)
  }

  buildingDetailPanel.setAttribute(
    'aria-labelledby',
    buildingTabId(homeState.activeBuildingTab),
  )
  buildingDetailPanel.replaceChildren()
  buildingDetailPanel.appendChild(renderAssetList())
  renderImageGalleryNow()
}

async function loadActiveAssets() {
  // Await flushes so listAssets does not race pending autosaves.
  await settleHomeEditors()
  const building = getSelectedBuilding()
  const api = window.electronAPI
  const token = homeState.assetLoadToken + 1
  homeState.assetLoadToken = token
  homeState.assets = []
  homeState.assetImages = new Map()
  homeState.galleryAssetId = null
  homeState.galleryImageIndex = 0
  renderImageGalleryNow()
  homeState.assetsLoading = building != null
  // Controllers already disposed — render rebuilds the panel only.
  await renderBuildingDetail()
  if (!building || !homeState.activeBuildingTab || !api?.listAssets) {
    homeState.assetsLoading = false
    await renderBuildingDetail()
    return
  }
  const assets = await api.listAssets(building.id, homeState.activeBuildingTab)
  if (homeState.assetLoadToken !== token) return
  homeState.assets = assets
  if (api.listAssetImages) {
    const imagePairs = await Promise.all(
      assets.map(async (asset) => [asset.id, await api.listAssetImages(asset.id)]),
    )
    if (homeState.assetLoadToken !== token) return
    homeState.assetImages = new Map(imagePairs)
  }
  homeState.assetsLoading = false
  await renderBuildingDetail()
}

async function renderHome() {
  const hideTopActions = homeState.selectedBuildingId != null
  // Hide firm details + settings when a building is open.
  if (homeTopActions) {
    homeTopActions.hidden = hideTopActions
  }
  renderProjectList(homeState.projects)
  renderPropertiesSection()
  await renderBuildingDetail()
}

function resolveSelectedBuilding(buildings, pendingBuildingId) {
  if (pendingBuildingId == null) return null
  const candidate = Number(pendingBuildingId)
  if (!Number.isFinite(candidate) || candidate <= 0) return null
  return buildings.some((b) => b.id === candidate) ? candidate : null
}

/*
 * syncHome reads the whole home graph over IPC before it assigns any of it, and
 * three things start one: selecting a project, finishing an Excel import, and
 * refreshHomeIfDatabaseChanged on window focus. A 4,000-row import makes every
 * window here wide — one listBuildingImages call per building, 27 of them for
 * the sample workbook — and getting either of the two hazards below wrong looks
 * identical from the outside: the project deselects itself and the property list
 * goes blank right after a successful import. See docs/home-page.md.
 */

/** Last-writer guard, mirroring `homeState.assetLoadToken`: a slow sync must not
 * land on top of a newer one. */
let homeSyncToken = 0

/**
 * The selection most recently *asked for*, which is not the one currently
 * rendered — a sync still fetching has not written to `homeState` yet. Refreshes
 * that mean "keep the current selection" default from this, because defaulting
 * from `homeState` mid-flight reads back the pre-selection value, and the token
 * guard then makes that stale sync win for being newest.
 */
const homeSyncRequest = { projectId: null, buildingId: null }

async function syncHome(
  selectedProjectId = homeSyncRequest.projectId,
  selectedBuildingId = homeSyncRequest.buildingId,
) {
  const api = window.electronAPI
  if (!api) return
  const previousRequest = { ...homeSyncRequest }
  homeSyncRequest.projectId = selectedProjectId
  homeSyncRequest.buildingId = selectedBuildingId
  const token = ++homeSyncToken
  // Keep controllers live while the graph is fetched: the user can still type
  // into the current DOM during a slow project sync. A second flush immediately
  // before assignment captures those late edits.
  try {
    await flushPendingRendererDrafts()
  } catch (err) {
    if (token === homeSyncToken) Object.assign(homeSyncRequest, previousRequest)
    throw err
  }
  if (token !== homeSyncToken) return
  const [projects, uniformatLevel1Groups] = await Promise.all([
    api.listProjects(),
    api.listUniformatLevel1Groups ? api.listUniformatLevel1Groups() : [],
  ])
  const validSelection = resolveInitialSelection(projects, selectedProjectId)
  let buildings = []
  let buildingImagePairs = []
  if (validSelection != null) {
    buildings = await api.listBuildings(validSelection)
    if (api.listBuildingImages) {
      buildingImagePairs = await Promise.all(
        buildings.map(async (building) => [
          building.id,
          await api.listBuildingImages(building.id),
        ]),
      )
    }
  }
  // A newer syncHome started while this one was fetching; its data is fresher
  // and its selection is the one the user asked for. Abandon this result rather
  // than overwriting theirs.
  if (token !== homeSyncToken) return
  try {
    await settleHomeEditors()
  } catch (err) {
    if (token === homeSyncToken) Object.assign(homeSyncRequest, previousRequest)
    throw err
  }
  homeState.projects = projects
  homeState.uniformatLevel1Groups = uniformatLevel1Groups
  homeState.selectedProjectId = validSelection
  homeState.buildings = buildings
  homeState.buildingImages = new Map(buildingImagePairs)
  homeState.selectedBuildingId = resolveSelectedBuilding(buildings, selectedBuildingId)
  const buildingSectionTabs = getBuildingSectionTabs()
  if (!buildingSectionTabs.includes(homeState.activeBuildingTab)) {
    homeState.activeBuildingTab = getFirstBuildingSectionTab()
  }
  await renderHome()
  await loadActiveAssets()
}

async function selectProject(projectId) {
  // Toggle against what was last asked for, not what is currently on screen —
  // clicking twice quickly must deselect, not re-select a sync still in flight.
  const nextProjectId = homeSyncRequest.projectId === projectId ? null : projectId
  await syncHome(nextProjectId, null)
}

async function selectBuilding(buildingId) {
  await settleHomeEditors()
  homeState.selectedBuildingId =
    homeState.selectedBuildingId === buildingId ? null : buildingId
  homeState.activeBuildingTab = getFirstBuildingSectionTab()
  homeState.openAssetIds.clear()
  await renderHome()
  await loadActiveAssets()
}

let homeRefreshInFlight = false

async function refreshHomeIfDatabaseChanged() {
  const api = window.electronAPI
  if (!api?.ensureDatabaseCurrent || !projectListWrap) return
  if (document.visibilityState === 'hidden') return
  if (homeRefreshInFlight) return
  homeRefreshInFlight = true
  try {
    const { changed } = await api.ensureDatabaseCurrent()
    if (!changed) return
    // DB file was replaced (e.g. load-local-db.sh); reload home state.
    await syncHome()
  } catch (err) {
    console.error('Failed to refresh home after database change', err)
  } finally {
    homeRefreshInFlight = false
  }
}

async function handleHomeHistory(result) {
  if (!result?.undone && !result?.redone) return
  const isRedo = Boolean(result.redone)
  const scroll = captureHomeScroll()
  // Global history flushed before applying the database change. Retire the old
  // controllers without another write, which would re-apply the undone values.
  disposeAllAssetFormControllers()

  try {
    const type = result.type

    if (type === 'project-delete') {
      if (isRedo) {
        const keepProject =
          homeState.selectedProjectId != null &&
          Number(homeState.selectedProjectId) === Number(result.projectId)
            ? null
            : homeState.selectedProjectId
        await syncHome(keepProject, null)
      } else {
        await syncHome(result.projectId ?? homeState.selectedProjectId, null)
      }
      return
    }

    if (type === 'building-delete') {
      const projectId = result.projectId ?? homeState.selectedProjectId
      if (isRedo) {
        const keepBuilding =
          homeState.selectedBuildingId != null &&
          Number(homeState.selectedBuildingId) === Number(result.buildingId)
            ? null
            : homeState.selectedBuildingId
        await syncHome(projectId, keepBuilding)
      } else {
        await syncHome(projectId, result.buildingId ?? null)
      }
      return
    }

    if (type === 'building-image-delete') {
      await syncHome(homeState.selectedProjectId, homeState.selectedBuildingId)
      return
    }

    if (type === 'project-update' || type === 'building-update') {
      await syncHome(
        result.projectId ?? homeState.selectedProjectId,
        type === 'building-update'
          ? (result.buildingId ?? homeState.selectedBuildingId)
          : homeState.selectedBuildingId,
      )
      return
    }

    // firm-update / executive-summary-update do not change home list chrome.
    if (type === 'firm-update' || type === 'executive-summary-update') {
      return
    }

    if (
      type === 'asset-update' ||
      type === 'asset-delete' ||
      type === 'asset-image-delete'
    ) {
      if (type === 'asset-delete' && result.assetId != null) {
        const assetId = Number(result.assetId)
        if (isRedo) {
          homeState.openAssetIds.delete(assetId)
        } else {
          homeState.openAssetIds.add(assetId)
        }
      }

      const targetBuildingId =
        result.buildingId != null ? Number(result.buildingId) : null
      const targetProjectId =
        result.projectId != null
          ? Number(result.projectId)
          : homeState.selectedProjectId
      const needsBuildingSwitch =
        targetBuildingId != null &&
        (homeState.selectedProjectId !== targetProjectId ||
          homeState.selectedBuildingId !== targetBuildingId)

      // Prefer the Level-1 tab of the restored / pre-edit asset so it is visible.
      applyUndoLevel1Tab(result.level1Group)

      if (needsBuildingSwitch) {
        await syncHome(targetProjectId, targetBuildingId)
        return
      }
      if (homeState.selectedBuildingId != null) {
        await loadActiveAssets()
      } else {
        await syncHome(targetProjectId, targetBuildingId)
      }
    }
  } finally {
    restoreHomeScroll(scroll)
  }
}

function applyCaptionUpdateToHome(payload) {
  if (payload?.imageId == null) return
  const imageId = Number(payload.imageId)

  const galleryStatus = document.querySelector(
    `[data-gallery-image-status="${imageId}"]`,
  )
  if (payload.state === 'generating') {
    setImageCaptionGenerating(payload.kind, imageId, true)
    return
  }
  setImageCaptionGenerating(payload.kind, imageId, false)

  if (!payload.ok) {
    if (galleryStatus) {
      galleryStatus.textContent = payload.error || 'Caption generation failed.'
      galleryStatus.classList.add('is-error')
      renderGalleryDraftSaveErrors(galleryStatus)
    }
    return
  }

  if (payload.skipped) return
  if (!payload.caption) return

  if (payload.kind === 'asset') {
    let assetId = payload.assetId != null ? Number(payload.assetId) : null
    if (assetId == null) {
      for (const [id, list] of homeState.assetImages.entries()) {
        if (list.some((img) => Number(img.id) === imageId)) {
          assetId = Number(id)
          break
        }
      }
    }
    if (assetId != null) {
      patchAssetImageLocalState(assetId, imageId, { caption: payload.caption })
    }

    // AI / regenerate results always win in the open gallery (avoid stale draft).
    const galleryInput = document.querySelector(
      `[data-gallery-image-caption="${imageId}"]`,
    )
    if (galleryInput) {
      galleryInput.value = payload.caption
    }

    const display =
      String(payload.caption).trim() ||
      `Image #${imageId}`
    const nameEl = document.querySelector(
      `[data-asset-image-name="${imageId}"]`,
    )
    if (nameEl) nameEl.textContent = display
    const thumb = document.querySelector(
      `[data-asset-image-thumb="${imageId}"]`,
    )
    if (thumb) {
      thumb.querySelector('img')?.setAttribute('alt', display)
      if (thumb.tagName === 'BUTTON') {
        thumb.setAttribute('aria-label', `Open ${display} in image gallery`)
      }
    }

    if (galleryStatus) {
      galleryStatus.textContent = 'Caption updated.'
      galleryStatus.classList.remove('is-error')
      if (renderGalleryDraftSaveErrors(galleryStatus)) return
      window.setTimeout(() => {
        if (galleryStatus.textContent === 'Caption updated.') {
          galleryStatus.textContent = ''
        }
      }, 2200)
    }
    return
  }

  if (payload.kind === 'building') {
    for (const [buildingId, list] of homeState.buildingImages.entries()) {
      const idx = list.findIndex((img) => Number(img.id) === imageId)
      if (idx < 0) continue
      const next = list.slice()
      next[idx] = { ...next[idx], caption: payload.caption }
      homeState.buildingImages.set(buildingId, next)
      break
    }
  }
}

/** Caption jobs live in the main process, so re-sync them whenever we regain focus. */
async function refreshCaptionGenerationJobs() {
  const api = window.electronAPI
  if (!api?.getAiStatus) return
  try {
    const status = await api.getAiStatus()
    syncCaptionGenerationJobs(status?.captionJobs)
  } catch {
    /* Leave the badges as they are until the next refresh. */
  }
}

async function bootstrap() {
  const api = window.electronAPI
  if (!api || !projectListWrap) return
  const { projectId, buildingId } = getActiveIds()
  await syncHome(projectId, buildingId)

  if (api.onCaptionUpdated) {
    api.onCaptionUpdated((payload) => {
      applyCaptionUpdateToHome(payload)
    })
  }
  void refreshCaptionGenerationJobs()

  window.addEventListener('focus', () => {
    void refreshHomeIfDatabaseChanged()
    void refreshCaptionGenerationJobs()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void refreshHomeIfDatabaseChanged()
      void refreshCaptionGenerationJobs()
    }
  })
  window.addEventListener('pagehide', () => {
    void flushPendingRendererDrafts().catch(() => {})
  })
  window.addEventListener('app-undo', (event) => {
    void handleHomeHistory(event.detail)
  })
  window.addEventListener('app-redo', (event) => {
    void handleHomeHistory(event.detail)
  })
}

if (startNewBtn) {
  startNewBtn.addEventListener('click', () => {
    void navigateAfterHomeFlush(() => window.electronAPI?.openProjectSetup()).catch(() => {})
  })
}

if (firmDetailsBtn) {
  firmDetailsBtn.addEventListener('click', () => {
    void navigateAfterHomeFlush(() => window.electronAPI?.openFirmSetup()).catch(() => {})
  })
}

if (openSettingsBtn) {
  openSettingsBtn.addEventListener('click', () => {
    void navigateAfterHomeFlush(() => window.electronAPI?.openSettings()).catch(() => {})
  })
}

if (generateProjectReportBtn) {
  generateProjectReportBtn.addEventListener('click', openProjectReportPicker)
}

/**
 * Show or hide the import overlay. The main process sends a label when it starts
 * a blocking step and `null` before every native dialog, so the overlay is never
 * behind a question the user has to answer.
 */
function setImportPhase(label) {
  if (!importModal) return
  if (label) {
    if (importModalLabel) importModalLabel.textContent = String(label)
    importModal.hidden = false
  } else {
    importModal.hidden = true
  }
}

window.electronAPI?.onImportPhase?.((label) => setImportPhase(label))

/**
 * Import a client BCA Excel workbook into the selected project. The main process
 * drives file choice, a preview, the New/Update decision, and the commit via
 * native dialogs; here we just refresh the property list and announce the result.
 *
 * Reading the workbook and committing its rows block the main process for
 * seconds, so it reports each phase and `setImportPhase` owns the screen while
 * they run — otherwise the window just freezes with no explanation.
 */
async function runExcelImport() {
  if (homeState.selectedProjectId == null) return
  if (!window.electronAPI?.importBcaWorkbook) return
  if (!importExcelBtn) return
  const originalLabel = importExcelBtn.textContent
  importExcelBtn.disabled = true
  importExcelBtn.textContent = 'Importing…'
  try {
    await flushPendingRendererDrafts()
    const result = await window.electronAPI.importBcaWorkbook(homeState.selectedProjectId)
    // A cancel carrying an error is a failure, not a user backing out. The
    // handler reports it in a native dialog on the UI path, but that dialog is
    // invisible to anything driving the app — and leaving the screen unchanged
    // made a failed import indistinguishable from one that did nothing.
    if (result?.canceled && result.error) {
      showAppToast(`Import failed: ${result.error}`, { tone: 'error' })
    }
    if (result && !result.canceled) {
      await syncHome(result.projectId ?? homeState.selectedProjectId, homeState.selectedBuildingId)
      const s = result.summary ?? {}
      const parts = []
      if (s.createdBuildings) {
        parts.push(`${s.createdBuildings} ${s.createdBuildings === 1 ? 'property' : 'properties'}`)
      }
      if (s.createdAssets) parts.push(`${s.createdAssets} new asset${s.createdAssets === 1 ? '' : 's'}`)
      if (s.updatedAssets) parts.push(`${s.updatedAssets} updated`)
      let message = parts.length > 0 ? `Imported ${parts.join(', ')}.` : 'Import complete — no changes.'
      if (s.unresolved > 0) message += ` ${s.unresolved} row${s.unresolved === 1 ? '' : 's'} skipped (no catalogue match).`
      showAppToast(message)
    }
    // Cancels and errors are already surfaced by the main-process dialogs.
  } catch (err) {
    showAppToast(`Import failed: ${err?.message ?? err}`, { tone: 'error' })
  } finally {
    // The handler clears the phase on every exit path, but a crashed or
    // never-answered import must not strand the overlay over the app.
    setImportPhase(null)
    importExcelBtn.textContent = originalLabel
    // renderPropertiesSection resets disabled state from the current selection.
    renderPropertiesSection()
  }
}

if (importExcelBtn) {
  importExcelBtn.addEventListener('click', runExcelImport)
}

if (addPropertyBtn) {
  addPropertyBtn.addEventListener('click', () => {
    if (homeState.selectedProjectId == null) return
    void navigateAfterHomeFlush(() => {
      // From the properties list — no building detail to restore.
      setHomeReturnBuildingId(null)
      return window.electronAPI?.openBuildingInfo(homeState.selectedProjectId)
    }).catch(() => {})
  })
}

void bootstrap()
