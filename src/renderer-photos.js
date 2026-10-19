// Home-page photography: the asset photo strip, annotated thumbnails, and the
// full-screen gallery where boxes and arrows are drawn onto a photo.
//
// Split out of src/renderer.js, which was 3.3k lines. Loaded as a classic
// <script> before it, so both files share one global scope (see
// src/renderer-asset-form.js for the same note). The shape contract for the
// annotations themselves lives in src/lib/annotations.js — unpacked here rather
// than in renderer.js because a top-level `const` may only read bindings from
// scripts that already ran (test/page-scripts.test.js fails on the alternative).

const {
  DEFAULT_ANNOTATION_COLOR,
  isAnnotationArrow,
  isAnnotationBox,
  normalizeAnnotationColor,
  renderAnnotationElements,
} = window.photoAnnotations

/** Report-include toggle icons for asset thumbnails (green outline / red struck-through). */
const ASSET_IMAGE_REPORT_INCLUDED_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"><path d="M7 3h8l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M15 3v5h5"/><text x="12" y="16.5" text-anchor="middle" fill="currentColor" stroke="none" font-size="5.5" font-weight="700" font-family="system-ui,sans-serif">DOC</text></svg>'
const ASSET_IMAGE_REPORT_EXCLUDED_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"><path d="M7 3h8l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M15 3v5h5"/><text x="12" y="16.5" text-anchor="middle" fill="currentColor" stroke="none" font-size="5.5" font-weight="700" font-family="system-ui,sans-serif">DOC</text><line x1="4.5" y1="19.5" x2="19.5" y2="4.5" stroke-width="2.25"/></svg>'

/** Live window resize listener that keeps the annotation layer aligned; torn down on close. */
let galleryResizeHandler = null
/** Capture-phase Ctrl/Cmd+Z handler while the image gallery is open. */
let galleryAnnotationKeyHandler = null
/** Capture-phase modal keyboard handler (Escape, arrows, and focus trap). */
let galleryDialogKeyHandler = null
/** Control that opened the gallery, restored after a successful close. */
let galleryReturnFocus = null
/**
 * The one armed gallery caption debounce, if any. Only one caption editor is
 * visible at a time (the gallery is full-screen), so a single slot suffices.
 * Explicit gallery/home transitions await it; pagehide invokes the same flush
 * as a best-effort fallback for an operating-system window close.
 */
let pendingGalleryCaptionSave = null
/** The current annotation editor's retryable immediate-save flush, if dirty. */
let pendingGalleryAnnotationSave = null

function renderGalleryDraftSaveErrors(statusEl) {
  const messages = [
    statusEl.dataset.captionSaveError,
    statusEl.dataset.annotationSaveError,
  ].filter(Boolean)
  if (messages.length > 0) {
    statusEl.dataset.draftSaveErrorVisible = 'true'
    statusEl.textContent = messages.join(' ')
    statusEl.classList.add('is-error')
    return true
  }
  if (statusEl.dataset.draftSaveErrorVisible === 'true') {
    delete statusEl.dataset.draftSaveErrorVisible
    if (statusEl.dataset.captionGenerating !== 'true') statusEl.textContent = ''
    statusEl.classList.remove('is-error')
  }
  return false
}

function setGalleryDraftSaveError(statusEl, kind, message) {
  statusEl.dataset[kind === 'caption' ? 'captionSaveError' : 'annotationSaveError'] = message
  renderGalleryDraftSaveErrors(statusEl)
}

function clearGalleryDraftSaveError(statusEl, kind) {
  delete statusEl.dataset[kind === 'caption' ? 'captionSaveError' : 'annotationSaveError']
  renderGalleryDraftSaveErrors(statusEl)
}

/** Mutate the canonical home-state entry so every open gallery closure sees it. */
function patchAssetImageLocalState(assetId, imageId, patch) {
  const images = homeState.assetImages.get(Number(assetId)) ?? []
  const canonical = images.find((entry) => Number(entry.id) === Number(imageId)) ?? null
  if (canonical) Object.assign(canonical, patch)
  return canonical
}

/** Cancel the caption debounce and write immediately, if a save is armed. */
function flushPendingGalleryCaptionSave() {
  const flush = pendingGalleryCaptionSave
  if (typeof flush !== 'function') return null
  return flush()
}

function flushPendingGalleryAnnotationSave() {
  const flush = pendingGalleryAnnotationSave
  if (typeof flush !== 'function') return null
  return flush()
}

async function flushPendingGalleryDraftSaves() {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => flushPendingGalleryCaptionSave()),
    Promise.resolve().then(() => flushPendingGalleryAnnotationSave()),
  ])
  const rejected = results.find((result) => result.status === 'rejected')
  if (!rejected) return
  if (
    rejected.reason instanceof Error ||
    (typeof rejected.reason === 'object' && typeof rejected.reason?.message === 'string')
  ) {
    throw rejected.reason
  }
  throw new Error(String(rejected.reason ?? 'Could not save gallery changes'))
}

registerRendererDraftFlusher(() => flushPendingGalleryDraftSaves())

function clearGalleryAnnotationKeyHandler() {
  if (!galleryAnnotationKeyHandler) return
  document.removeEventListener('keydown', galleryAnnotationKeyHandler, true)
  galleryAnnotationKeyHandler = null
}

function clearGalleryDialogKeyHandler() {
  if (!galleryDialogKeyHandler) return
  document.removeEventListener('keydown', galleryDialogKeyHandler, true)
  galleryDialogKeyHandler = null
}

function getGalleryFocusableElements(overlay) {
  return [...overlay.querySelectorAll(
    'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.closest('[hidden]') && element.getAttribute('aria-hidden') !== 'true')
}

async function openImageGallery(assetId, imageIndex, opener = document.activeElement) {
  await flushPendingGalleryDraftSaves()
  if (homeState.galleryAssetId == null) {
    galleryReturnFocus = opener?.isConnected && typeof opener.focus === 'function' ? opener : null
  }
  homeState.galleryAssetId = assetId
  homeState.galleryImageIndex = imageIndex
  renderImageGalleryNow({ focusTarget: 'close' })
}

async function closeImageGallery() {
  await flushPendingGalleryDraftSaves()
  const returnFocus = galleryReturnFocus
  galleryReturnFocus = null
  homeState.galleryAssetId = null
  homeState.galleryImageIndex = 0
  renderImageGalleryNow()
  if (returnFocus?.isConnected && typeof returnFocus.focus === 'function') {
    returnFocus.focus()
  }
}

async function moveImageGallery(delta) {
  await flushPendingGalleryDraftSaves()
  const images = homeState.assetImages.get(homeState.galleryAssetId) ?? []
  if (images.length === 0) return
  homeState.galleryImageIndex =
    (homeState.galleryImageIndex + delta + images.length) % images.length
  renderImageGalleryNow({ focusTarget: delta < 0 ? 'previous' : 'next' })
}


/** Rebuild the gallery after its caller has crossed the renderer-draft flush seam. */
function renderImageGalleryNow({ focusTarget = null } = {}) {
  document.getElementById('home-image-gallery')?.remove()
  if (galleryResizeHandler) {
    window.removeEventListener('resize', galleryResizeHandler)
    galleryResizeHandler = null
  }
  clearGalleryAnnotationKeyHandler()
  clearGalleryDialogKeyHandler()
  const assetId = homeState.galleryAssetId
  if (assetId == null) return

  const images = homeState.assetImages.get(assetId) ?? []
  if (images.length === 0) {
    homeState.galleryAssetId = null
    homeState.galleryImageIndex = 0
    return
  }

  const safeIndex = Math.min(Math.max(homeState.galleryImageIndex, 0), images.length - 1)
  homeState.galleryImageIndex = safeIndex
  const image = images[safeIndex]

  const overlay = document.createElement('div')
  overlay.id = 'home-image-gallery'
  overlay.className = 'home-image-gallery'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', 'Asset image gallery')
  overlay.addEventListener('click', () => {
    void closeImageGallery().catch(() => {})
  })

  const dialog = document.createElement('div')
  dialog.className = 'home-image-gallery-dialog'
  dialog.addEventListener('click', (event) => {
    event.stopPropagation()
  })

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'home-image-gallery-close'
  closeBtn.setAttribute('aria-label', 'Close image gallery')
  closeBtn.textContent = 'Close'
  closeBtn.addEventListener('click', () => {
    void closeImageGallery().catch(() => {})
  })
  dialog.appendChild(closeBtn)

  const { stage, img, boxLayer, prevBtn, nextBtn } = createGalleryStage(image, images)

  const body = document.createElement('div')
  body.className = 'home-image-gallery-body'
  body.appendChild(stage)

  const { side, resLabel, statusEl } = createGalleryCaptionPanel({
    assetId,
    image,
    images,
    index: safeIndex,
    img,
  })

  const annotationEditor = createGalleryAnnotationEditor({
    assetId,
    image,
    boxLayer,
    statusEl,
  })
  // The status line sits under both toolbars: annotation saves report there too.
  side.append(annotationEditor.boxRow, annotationEditor.arrowRow, statusEl)

  // Close palettes when clicking elsewhere in the gallery side panel / dialog.
  side.addEventListener('click', (event) => {
    if (!event.target.closest('.home-image-gallery-color-wrap')) {
      annotationEditor.closePalettes()
    }
  })

  const positionBoxLayer = () => {
    // Re-render arrows so the canvas bitmap matches the layer pixel size.
    if (positionGalleryBoxLayer(img, boxLayer)) annotationEditor.render()
  }

  galleryResizeHandler = () => positionBoxLayer()
  window.addEventListener('resize', galleryResizeHandler)

  const onImageReady = () => {
    updateGalleryResolution(img, resLabel)
    positionBoxLayer()
  }

  body.appendChild(side)
  dialog.appendChild(body)

  overlay.appendChild(dialog)
  document.body.appendChild(overlay)

  galleryDialogKeyHandler = (event) => {
    if (!overlay.isConnected) return

    if (event.key === 'Escape') {
      const openPalette = overlay.querySelector('.home-image-gallery-color-wrap.is-open')
      if (openPalette) {
        event.preventDefault()
        event.stopPropagation()
        annotationEditor.closePalettes()
        openPalette.querySelector('.home-image-gallery-color')?.focus()
        return
      }
      event.preventDefault()
      event.stopPropagation()
      void closeImageGallery().catch(() => {})
      return
    }

    if (event.key === 'Tab') {
      const focusable = getGalleryFocusableElements(overlay)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !overlay.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !overlay.contains(active))) {
        event.preventDefault()
        first.focus()
      }
      return
    }

    if (
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
      images.length > 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !(typeof isNativeTextEditableTarget === 'function' && isNativeTextEditableTarget(event.target))
    ) {
      event.preventDefault()
      event.stopPropagation()
      void moveImageGallery(event.key === 'ArrowLeft' ? -1 : 1).catch(() => {})
    }
  }
  document.addEventListener('keydown', galleryDialogKeyHandler, true)

  const initialFocus =
    focusTarget === 'previous' ? prevBtn : focusTarget === 'next' ? nextBtn : closeBtn
  initialFocus?.focus()

  // Position the box layer only after the gallery is in the document. Cached
  // images are often already complete here; measuring while detached yields
  // clientWidth/Height 0, leaves the layer display:none, and draw-mode
  // pointer events fall through to the <img> (native drag) instead of drawing.
  if (img.complete && img.naturalWidth) {
    onImageReady()
  } else {
    img.addEventListener('load', onImageReady, { once: true })
    img.addEventListener(
      'error',
      () => {
        resLabel.textContent = 'Resolution unknown'
        boxLayer.style.display = 'none'
      },
      { once: true },
    )
  }
}

/**
 * Prev/next navigation, the photo itself, and the annotation overlay — sized to
 * exactly overlap the visible (object-fit: contain) picture so annotation
 * fractions map 1:1 to the exported report.
 */
function createGalleryStage(image, images) {
  const stage = document.createElement('div')
  stage.className = 'home-image-gallery-stage'

  const prevBtn = document.createElement('button')
  prevBtn.type = 'button'
  prevBtn.className = 'home-image-gallery-nav home-image-gallery-nav--prev'
  prevBtn.setAttribute('aria-label', 'Previous image')
  prevBtn.textContent = '‹'
  prevBtn.disabled = images.length < 2
  prevBtn.addEventListener('click', () => {
    void moveImageGallery(-1).catch(() => {})
  })
  stage.appendChild(prevBtn)

  const img = document.createElement('img')
  img.src = image.media_url ?? toFileUrl(image.file_path)
  img.alt = image.caption || image.original_name || 'Asset image'
  // Native image drag steals pointer gestures; always off in the gallery.
  img.draggable = false
  stage.appendChild(img)

  const nextBtn = document.createElement('button')
  nextBtn.type = 'button'
  nextBtn.className = 'home-image-gallery-nav home-image-gallery-nav--next'
  nextBtn.setAttribute('aria-label', 'Next image')
  nextBtn.textContent = '›'
  nextBtn.disabled = images.length < 2
  nextBtn.addEventListener('click', () => {
    void moveImageGallery(1).catch(() => {})
  })
  stage.appendChild(nextBtn)

  const boxLayer = document.createElement('div')
  boxLayer.className = 'home-image-gallery-boxes'
  stage.appendChild(boxLayer)

  return { stage, img, boxLayer, prevBtn, nextBtn }
}

/**
 * Side panel: filename, index, resolution, the autosaving caption textarea, and
 * Generate New Caption. `statusEl` is returned rather than appended — it belongs
 * below the annotation toolbars, and the annotation editor writes to it as well.
 */
function createGalleryCaptionPanel({ assetId, image, images, index, img }) {
  const side = document.createElement('aside')
  side.className = 'home-image-gallery-side'
  side.addEventListener('click', (event) => event.stopPropagation())

  const fileName = document.createElement('div')
  fileName.className = 'home-image-gallery-filename'
  fileName.textContent = image.original_name || `Image ${index + 1}`
  fileName.title = image.original_name || ''
  side.appendChild(fileName)

  const metaLine = document.createElement('div')
  metaLine.className = 'home-image-gallery-meta'
  metaLine.textContent = `${index + 1} of ${images.length}`
  side.appendChild(metaLine)

  const resLabel = document.createElement('div')
  resLabel.className = 'home-image-gallery-resolution'
  resLabel.textContent = '…'
  side.appendChild(resLabel)

  const captionField = document.createElement('label')
  captionField.className = 'home-image-gallery-caption-field'
  const captionLabel = document.createElement('span')
  captionLabel.className = 'home-image-gallery-caption-label'
  captionLabel.textContent = 'Caption'
  captionField.appendChild(captionLabel)

  const captionInput = document.createElement('textarea')
  captionInput.className = 'home-image-gallery-caption-input'
  captionInput.dataset.galleryImageCaption = String(image.id)
  captionInput.rows = 3
  captionInput.placeholder = ''
  captionInput.value = image.caption || ''
  captionInput.spellcheck = true

  const statusEl = document.createElement('div')
  statusEl.className = 'home-image-gallery-status'
  statusEl.dataset.galleryImageStatus = String(image.id)
  statusEl.setAttribute('aria-live', 'polite')

  let captionSaveTimer = null
  let captionSaveInFlight = null
  let captionRevision = 0
  let savedCaptionRevision = 0
  let observedCaptionValue = captionInput.value
  /** Bumped to invalidate in-flight debounced saves (regenerate / newer AI write). */
  let captionWriteEpoch = 0

  const patchAssetStripCaption = (captionText) => {
    const display =
      (captionText && String(captionText).trim()) ||
      image.original_name ||
      `Image #${image.id}`
    const nameEl = document.querySelector(
      `[data-asset-image-name="${image.id}"]`,
    )
    if (nameEl) nameEl.textContent = display
    const thumb = document.querySelector(
      `[data-asset-image-thumb="${image.id}"]`,
    )
    if (thumb) {
      thumb.querySelector('img')?.setAttribute('alt', display)
      if (thumb.tagName === 'BUTTON') {
        thumb.setAttribute('aria-label', `Open ${display} in image gallery`)
      }
    }
  }

  const saveCaption = async ({ force = false } = {}) => {
    const api = window.electronAPI
    if (!api?.updateImageCaption) {
      if (force && captionRevision !== savedCaptionRevision) {
        throw new Error('Caption saving is unavailable')
      }
      return
    }

    for (;;) {
      while (captionSaveInFlight) await captionSaveInFlight
      if (captionRevision === savedCaptionRevision) {
        disarmCaptionFlush()
        return
      }

      const epoch = captionWriteEpoch
      const revision = captionRevision
      const next = captionInput.value.trim() || null
      const request = (async () => api.updateImageCaption('asset', image.id, next))()
      captionSaveInFlight = request
      try {
        await request
      } catch (err) {
        if (epoch !== captionWriteEpoch) return
        setGalleryDraftSaveError(
          statusEl,
          'caption',
          `Could not save caption: ${String(err?.message ?? err)}`,
        )
        pendingGalleryCaptionSave = flushCaptionSave
        throw err
      } finally {
        if (captionSaveInFlight === request) captionSaveInFlight = null
      }
      if (epoch !== captionWriteEpoch) return

      savedCaptionRevision = revision
      if (revision === captionRevision) {
        const canonical = patchAssetImageLocalState(assetId, image.id, { caption: next })
        if (canonical !== image) image.caption = next
        img.alt = next || image.original_name || 'Asset image'
        patchAssetStripCaption(next)
        clearGalleryDraftSaveError(statusEl, 'caption')
      }
      if (captionRevision === savedCaptionRevision) {
        disarmCaptionFlush()
        return
      }
      if (!force) return

      // An input event landed during the forced write. Its own debounce is now
      // redundant; this loop writes the newest revision before teardown.
      window.clearTimeout(captionSaveTimer)
      captionSaveTimer = null
    }
  }

  /** Save now instead of when the debounce matures. */
  const flushCaptionSave = () => {
    if (captionSaveTimer != null) {
      window.clearTimeout(captionSaveTimer)
      captionSaveTimer = null
    }
    if (captionRevision === savedCaptionRevision && !captionSaveInFlight) {
      disarmCaptionFlush()
      return null
    }
    return saveCaption({ force: true })
  }
  const disarmCaptionFlush = () => {
    if (pendingGalleryCaptionSave === flushCaptionSave) {
      pendingGalleryCaptionSave = null
    }
  }

  const markCaptionDirty = () => {
    if (captionInput.value === observedCaptionValue) return false
    observedCaptionValue = captionInput.value
    captionRevision += 1
    return true
  }

  captionInput.addEventListener('input', () => {
    if (!markCaptionDirty()) return
    window.clearTimeout(captionSaveTimer)
    captionSaveTimer = window.setTimeout(() => {
      captionSaveTimer = null
      void saveCaption().catch(() => {})
    }, 450)
    pendingGalleryCaptionSave = flushCaptionSave
  })
  captionInput.addEventListener('change', () => {
    markCaptionDirty()
    window.clearTimeout(captionSaveTimer)
    captionSaveTimer = null
    pendingGalleryCaptionSave = flushCaptionSave
    void flushCaptionSave()?.catch(() => {})
  })
  captionInput.addEventListener('keydown', (event) => {
    event.stopPropagation()
  })
  captionField.appendChild(captionInput)
  side.appendChild(captionField)

  const actions = document.createElement('div')
  actions.className = 'home-image-gallery-actions'

  const regenBtn = document.createElement('button')
  regenBtn.type = 'button'
  regenBtn.className =
    'home-action-btn home-action-btn--inline home-image-gallery-caption-generate'
  regenBtn.dataset.galleryImageRegen = String(image.id)
  regenBtn.textContent = 'Generate New Caption'
  regenBtn.title = 'Generate a new AI caption for this photo'
  regenBtn.addEventListener('click', async () => {
    if (isImageCaptionGenerating('asset', image.id)) return
    const api = window.electronAPI
    if (!api?.regenerateImageCaption) return
    captionInput.blur()
    setImageCaptionGenerating('asset', image.id, true)
    try {
      // A generated caption supersedes the manual text, but first make the
      // editing model's current draft durable. This also drains any caption IPC
      // already on the wire, so the AI job snapshots the newest saved caption
      // and no older request can land after its compare-and-set read.
      await flushCaptionSave()
      captionWriteEpoch += 1
      const result = await api.regenerateImageCaption('asset', image.id)
      if (!result?.ok) {
        setImageCaptionGenerating('asset', image.id, false)
        statusEl.textContent = result?.error || 'Could not start caption generation.'
        statusEl.classList.add('is-error')
        renderGalleryDraftSaveErrors(statusEl)
      }
    } catch (err) {
      setImageCaptionGenerating('asset', image.id, false)
      statusEl.textContent = String(err?.message ?? err)
      statusEl.classList.add('is-error')
      renderGalleryDraftSaveErrors(statusEl)
    }
  })
  actions.appendChild(regenBtn)
  side.appendChild(actions)

  const captionGenerating = isImageCaptionGenerating('asset', image.id)
  setImageCaptionGenerationControls(image.id, captionGenerating, side)
  if (captionGenerating) {
    statusEl.dataset.captionGenerating = 'true'
    statusEl.textContent = 'Generating caption…'
  }
  return { side, resLabel, statusEl }
}

/**
 * Box / arrow drawing for one photo: the two toolbars with their colour
 * palettes, drag-to-draw on the overlay, and undo/redo of shapes placed during
 * this gallery session. Every change persists immediately; failures surface in
 * `statusEl`. Returns the toolbars plus the hooks the gallery drives.
 */
function createGalleryAnnotationEditor({ assetId, image, boxLayer, statusEl }) {
  const clamp01 = (n) => Math.min(1, Math.max(0, n))
  let annotations = Array.isArray(image.bounding_boxes)
    ? image.bounding_boxes.map((item) => ({ ...item }))
    : []
  /** Shapes placed this gallery session — Ctrl/Cmd+Z / Shift+Z / Y undo & redo. */
  const placementUndoStack = []
  const placementRedoStack = []
  let boxColor = DEFAULT_ANNOTATION_COLOR
  let arrowColor = DEFAULT_ANNOTATION_COLOR
  /** @type {null|'box'|'arrow'} */
  let drawTool = null
  let annotationRevision = 0
  let savedAnnotationRevision = 0
  let annotationSaveInFlight = null

  const annotationBoxes = () => annotations.filter(isAnnotationBox)
  const annotationArrows = () => annotations.filter(isAnnotationArrow)

  const renderAnnotations = () => {
    // Keep only a live draft element (if any); rebuild committed shapes.
    const draftEl = boxLayer.querySelector('.is-annotation-draft')
    boxLayer.replaceChildren()
    renderAnnotationElements(boxLayer, annotations, {
      boxClass: 'home-image-gallery-box',
      arrowClass: 'home-image-gallery-arrows',
    })
    if (draftEl) boxLayer.appendChild(draftEl)
  }

  const disarmAnnotationFlush = () => {
    if (pendingGalleryAnnotationSave === flushAnnotationSave) {
      pendingGalleryAnnotationSave = null
    }
  }

  const saveAnnotations = async ({ force = false } = {}) => {
    const api = window.electronAPI
    if (!api?.updateImageBoundingBoxes) {
      if (annotationRevision === savedAnnotationRevision) return
      const error = new Error('Annotation saving is unavailable')
      setGalleryDraftSaveError(
        statusEl,
        'annotation',
        `Could not save annotations: ${error.message}`,
      )
      if (force) throw error
      return
    }

    for (;;) {
      while (annotationSaveInFlight) await annotationSaveInFlight
      if (annotationRevision === savedAnnotationRevision) {
        disarmAnnotationFlush()
        return
      }

      const revision = annotationRevision
      const snapshot = annotations.map((item) => ({ ...item }))
      const request = Promise.resolve().then(() =>
        api.updateImageBoundingBoxes('asset', image.id, snapshot),
      )
      annotationSaveInFlight = request
      try {
        await request
      } catch (err) {
        setGalleryDraftSaveError(
          statusEl,
          'annotation',
          `Could not save annotations: ${String(err?.message ?? err)}`,
        )
        pendingGalleryAnnotationSave = flushAnnotationSave
        throw err
      } finally {
        if (annotationSaveInFlight === request) annotationSaveInFlight = null
      }

      savedAnnotationRevision = revision
      if (revision === annotationRevision) {
        const boundingBoxes = snapshot.map((item) => ({ ...item }))
        const canonical =
          patchAssetImageLocalState(assetId, image.id, { bounding_boxes: boundingBoxes }) ?? image
        if (canonical !== image) image.bounding_boxes = boundingBoxes
        refreshAssetImageThumbBoxes(canonical)
        clearGalleryDraftSaveError(statusEl, 'annotation')
        disarmAnnotationFlush()
        return
      }
      if (!force) return
      // A second shape edit landed during the forced write. Continue until the
      // newest annotation revision is durable before gallery teardown.
    }
  }

  const flushAnnotationSave = () => saveAnnotations({ force: true })

  const persistAnnotations = () => {
    annotationRevision += 1
    pendingGalleryAnnotationSave = flushAnnotationSave
    void saveAnnotations().catch(() => {})
  }

  const makeAnnotRow = () => {
    const row = document.createElement('div')
    row.className = 'home-image-gallery-actions home-image-gallery-annot-row'
    return row
  }

  // Box row: Add box | Remove boxes | color
  const boxRow = makeAnnotRow()
  const addBoxBtn = document.createElement('button')
  addBoxBtn.type = 'button'
  addBoxBtn.className = 'home-action-btn home-action-btn--inline home-image-gallery-annot-add'
  addBoxBtn.textContent = 'Add box'
  addBoxBtn.title = 'Draw a box on the photo (shown in the report)'

  const removeBoxBtn = document.createElement('button')
  removeBoxBtn.type = 'button'
  removeBoxBtn.className = 'home-action-btn home-action-btn--inline home-image-gallery-annot-remove'
  removeBoxBtn.textContent = 'Remove boxes'
  removeBoxBtn.title = 'Remove all boxes from this photo'

  const boxColorPicker = createGalleryColorPicker(boxColor, 'Box colour', (color) => {
    boxColor = color
  })

  // Arrow row: Add arrow | Remove arrows | color
  const arrowRow = makeAnnotRow()
  const addArrowBtn = document.createElement('button')
  addArrowBtn.type = 'button'
  addArrowBtn.className = 'home-action-btn home-action-btn--inline home-image-gallery-annot-add'
  addArrowBtn.textContent = 'Add arrow'
  addArrowBtn.title = 'Draw an arrow on the photo (shown in the report)'

  const removeArrowBtn = document.createElement('button')
  removeArrowBtn.type = 'button'
  removeArrowBtn.className = 'home-action-btn home-action-btn--inline home-image-gallery-annot-remove'
  removeArrowBtn.textContent = 'Remove arrows'
  removeArrowBtn.title = 'Remove all arrows from this photo'

  const arrowColorPicker = createGalleryColorPicker(arrowColor, 'Arrow colour', (color) => {
    arrowColor = color
  })

  const setDrawTool = (tool) => {
    drawTool = drawTool === tool ? null : tool
    const drawing = drawTool != null
    boxLayer.classList.toggle('is-drawing', drawing)
    addBoxBtn.classList.toggle('is-active', drawTool === 'box')
    addArrowBtn.classList.toggle('is-active', drawTool === 'arrow')
    addBoxBtn.textContent = drawTool === 'box' ? 'Drag' : 'Add box'
    addArrowBtn.textContent = drawTool === 'arrow' ? 'Drag' : 'Add arrow'
  }

  const updateRemoveState = () => {
    removeBoxBtn.disabled = annotationBoxes().length === 0
    removeArrowBtn.disabled = annotationArrows().length === 0
  }

  addBoxBtn.addEventListener('click', () => setDrawTool('box'))
  addArrowBtn.addEventListener('click', () => setDrawTool('arrow'))
  const purgeStackKind = (stack, predicate) => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (predicate(stack[i])) stack.splice(i, 1)
    }
  }

  removeBoxBtn.addEventListener('click', async () => {
    if (annotationBoxes().length === 0) return
    annotations = annotations.filter((item) => !isAnnotationBox(item))
    purgeStackKind(placementUndoStack, isAnnotationBox)
    purgeStackKind(placementRedoStack, isAnnotationBox)
    renderAnnotations()
    updateRemoveState()
    await persistAnnotations()
  })
  removeArrowBtn.addEventListener('click', async () => {
    if (annotationArrows().length === 0) return
    annotations = annotations.filter((item) => !isAnnotationArrow(item))
    purgeStackKind(placementUndoStack, isAnnotationArrow)
    purgeStackKind(placementRedoStack, isAnnotationArrow)
    renderAnnotations()
    updateRemoveState()
    await persistAnnotations()
  })

  const undoLastPlacement = async () => {
    if (placementUndoStack.length === 0) return false
    const last = placementUndoStack.pop()
    const idx = annotations.lastIndexOf(last)
    if (idx >= 0) annotations.splice(idx, 1)
    placementRedoStack.push(last)
    renderAnnotations()
    updateRemoveState()
    await persistAnnotations()
    return true
  }

  const redoLastPlacement = async () => {
    if (placementRedoStack.length === 0) return false
    const next = placementRedoStack.pop()
    annotations.push(next)
    placementUndoStack.push(next)
    renderAnnotations()
    updateRemoveState()
    await persistAnnotations()
    return true
  }

  clearGalleryAnnotationKeyHandler()
  galleryAnnotationKeyHandler = (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return
    const key = String(event.key || '').toLowerCase()
    const isUndo = key === 'z' && !event.shiftKey
    const isRedo = (key === 'z' && event.shiftKey) || key === 'y'
    if (!isUndo && !isRedo) return
    // Leave caption typing to native text undo/redo.
    if (typeof isNativeTextEditableTarget === 'function' && isNativeTextEditableTarget(event.target)) {
      return
    }
    if (isUndo) {
      if (placementUndoStack.length === 0) return
      event.preventDefault()
      event.stopImmediatePropagation()
      void undoLastPlacement()
      return
    }
    if (placementRedoStack.length === 0) return
    event.preventDefault()
    event.stopImmediatePropagation()
    void redoLastPlacement()
  }
  document.addEventListener('keydown', galleryAnnotationKeyHandler, true)

  boxRow.append(addBoxBtn, removeBoxBtn, boxColorPicker.el)
  arrowRow.append(addArrowBtn, removeArrowBtn, arrowColorPicker.el)

  const closeColorPalettes = () => {
    boxColorPicker.close()
    arrowColorPicker.close()
  }

  // Drag-to-draw. Coordinates are fractions of the visible picture (0..1).
  let draft = null
  boxLayer.addEventListener('pointerdown', (event) => {
    if (!drawTool || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const rect = boxLayer.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const startX = clamp01((event.clientX - rect.left) / rect.width)
    const startY = clamp01((event.clientY - rect.top) / rect.height)
    if (drawTool === 'box') {
      const el = document.createElement('div')
      el.className = 'home-image-gallery-box home-image-gallery-box--draft is-annotation-draft'
      el.style.borderColor = boxColor
      boxLayer.appendChild(el)
      draft = { kind: 'box', rect, startX, startY, el, color: boxColor }
    } else {
      const el = document.createElement('div')
      el.className = 'is-annotation-draft home-image-gallery-arrow-draft'
      el.style.cssText = 'position:absolute;inset:0;pointer-events:none'
      boxLayer.appendChild(el)
      draft = { kind: 'arrow', rect, startX, startY, el, color: arrowColor }
    }
    boxLayer.setPointerCapture(event.pointerId)
  })

  const paintDraft = (event) => {
    if (!draft) return null
    const { rect, startX, startY, el, kind, color } = draft
    const curX = clamp01((event.clientX - rect.left) / rect.width)
    const curY = clamp01((event.clientY - rect.top) / rect.height)
    if (kind === 'box') {
      const box = {
        kind: 'box',
        x: Math.min(startX, curX),
        y: Math.min(startY, curY),
        w: Math.abs(curX - startX),
        h: Math.abs(curY - startY),
        color,
      }
      el.style.left = `${box.x * 100}%`
      el.style.top = `${box.y * 100}%`
      el.style.width = `${box.w * 100}%`
      el.style.height = `${box.h * 100}%`
      el.style.borderColor = color
      return box
    }
    const arrow = {
      kind: 'arrow',
      x1: startX,
      y1: startY,
      x2: curX,
      y2: curY,
      color,
    }
    el.replaceChildren()
    // Temporary layer-sized host so arrow geometry uses the draft host size.
    renderAnnotationElements(el, [arrow], {
      boxClass: 'home-image-gallery-box',
      arrowClass: 'home-image-gallery-arrows home-image-gallery-arrows--draft',
    })
    return arrow
  }

  boxLayer.addEventListener('pointermove', (event) => {
    if (draft) paintDraft(event)
  })

  const endDraft = async (event, commit) => {
    if (!draft) return
    const shape = paintDraft(event)
    draft.el.remove()
    draft = null
    if (!commit || !shape) return
    if (shape.kind === 'box') {
      if (shape.w < 0.01 || shape.h < 0.01) return
      annotations.push(shape)
      placementUndoStack.push(shape)
      placementRedoStack.length = 0
    } else {
      if (Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1) < 0.01) return
      annotations.push(shape)
      placementUndoStack.push(shape)
      placementRedoStack.length = 0
    }
    renderAnnotations()
    updateRemoveState()
    await persistAnnotations()
  }
  boxLayer.addEventListener('pointerup', (event) => {
    void endDraft(event, true)
  })
  boxLayer.addEventListener('pointercancel', (event) => {
    void endDraft(event, false)
  })

  updateRemoveState()
  renderAnnotations()

  return {
    boxRow,
    arrowRow,
    render: renderAnnotations,
    closePalettes: closeColorPalettes,
  }
}

// Simple fixed palette — no free-form colour dialog.
const ANNOTATION_COLOR_OPTIONS = [
  DEFAULT_ANNOTATION_COLOR, // red
  '#f0a202', // amber
  '#2f9e44', // green
  '#228be6', // blue
  '#ffffff', // white
]

/**
 * Swatch button that opens a 5-colour palette.
 * @param {string} initial
 * @param {string} title
 * @param {(color: string) => void} onChange
 */
function createGalleryColorPicker(initial, title, onChange) {
  const wrap = document.createElement('div')
  wrap.className = 'home-image-gallery-color-wrap'

  let current = normalizeAnnotationColor(initial) || DEFAULT_ANNOTATION_COLOR

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'home-image-gallery-color'
  trigger.title = title
  trigger.setAttribute('aria-label', title)
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.style.backgroundColor = current

  const palette = document.createElement('div')
  palette.className = 'home-image-gallery-color-palette'
  palette.setAttribute('role', 'listbox')
  palette.hidden = true

  const setOpen = (open) => {
    palette.hidden = !open
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false')
    wrap.classList.toggle('is-open', open)
  }

  const setColor = (color) => {
    current = normalizeAnnotationColor(color) || DEFAULT_ANNOTATION_COLOR
    trigger.style.backgroundColor = current
    for (const btn of palette.querySelectorAll('.home-image-gallery-color-option')) {
      btn.classList.toggle('is-selected', btn.dataset.color === current)
    }
    onChange(current)
  }

  for (const color of ANNOTATION_COLOR_OPTIONS) {
    const opt = document.createElement('button')
    opt.type = 'button'
    opt.className = 'home-image-gallery-color-option'
    opt.dataset.color = color
    opt.style.backgroundColor = color
    opt.setAttribute('role', 'option')
    opt.setAttribute('aria-label', color)
    opt.classList.toggle('is-selected', color === current)
    opt.addEventListener('click', (event) => {
      event.stopPropagation()
      setColor(color)
      setOpen(false)
    })
    palette.appendChild(opt)
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation()
    setOpen(palette.hidden)
  })

  wrap.append(trigger, palette)
  return {
    el: wrap,
    close: () => setOpen(false),
  }
}

/**
 * Size the annotation overlay onto the letterboxed picture so stored fractions
 * map 1:1 at any window size. Returns false when the image has no layout yet —
 * measuring a detached or unloaded image yields zeros and hides the layer.
 */
function positionGalleryBoxLayer(img, boxLayer) {
    const natW = img.naturalWidth
    const natH = img.naturalHeight
    const frameW = img.clientWidth
    const frameH = img.clientHeight
    if (!natW || !natH || !frameW || !frameH) {
    boxLayer.style.display = 'none'
    return false
  }
    const scale = Math.min(frameW / natW, frameH / natH)
    const dispW = natW * scale
    const dispH = natH * scale
    boxLayer.style.display = 'block'
    boxLayer.style.left = `${(frameW - dispW) / 2}px`
    boxLayer.style.top = `${(frameH - dispH) / 2}px`
    boxLayer.style.width = `${dispW}px`
    boxLayer.style.height = `${dispH}px`
  return true
}

function updateGalleryResolution(img, resLabel) {
  const width = img.naturalWidth
  const height = img.naturalHeight
  if (!width || !height) {
    resLabel.textContent = 'Resolution unknown'
    return
  }
  const low = isLowImageResolution(width, height)
  resLabel.textContent = low
    ? `${width}×${height} · Low resolution`
    : `${width}×${height}`
  resLabel.classList.toggle('is-low', low)
}

/** Report photos with a long edge under this many pixels are flagged as low resolution. */
const LOW_IMAGE_RESOLUTION_LONG_EDGE = 1200

function isLowImageResolution(width, height) {
  return Math.max(width, height) < LOW_IMAGE_RESOLUTION_LONG_EDGE
}

function createAssetImageSection(asset) {
  const section = document.createElement('section')
  section.className = 'home-asset-images'
  section.addEventListener('click', (event) => {
    event.stopPropagation()
  })

  const header = document.createElement('div')
  header.className = 'home-asset-images-header'
  const title = document.createElement('h3')
  title.textContent = 'Images'
  header.appendChild(title)

  const addBtn = document.createElement('button')
  addBtn.type = 'button'
  addBtn.className = 'home-action-btn home-action-btn--inline'
  addBtn.textContent = 'Add image'
  addBtn.addEventListener('click', async () => {
    const api = window.electronAPI
    if (!api?.importAssetImages) return
    try {
      await settleHomeEditors()
      const images = await api.importAssetImages(asset.id)
      homeState.assetImages.set(asset.id, images)
      await renderBuildingDetail()
    } catch {
      // A failed editor flush leaves the current form and its status visible.
    }
  })
  header.appendChild(addBtn)
  section.appendChild(header)

  const images = homeState.assetImages.get(asset.id) ?? []
  if (images.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'home-empty'
    empty.textContent = 'No images added yet.'
    section.appendChild(empty)
    return section
  }

  const list = document.createElement('ul')
  list.className = 'home-asset-image-list'
  for (const [index, image] of images.entries()) {
    const item = document.createElement('li')
    item.className = 'home-asset-image-item'
    item.dataset.assetImageId = String(image.id)

    const imageLabel = image.caption || image.original_name || `image ${index + 1}`
    const thumb = createAnnotatedThumb('button', 'home-asset-image-thumb', image)
    thumb.type = 'button'
    thumb.setAttribute('aria-label', `Open ${imageLabel} in image gallery`)
    thumb.addEventListener('click', () => {
      void openImageGallery(asset.id, index, thumb).catch(() => {})
    })
    item.appendChild(thumb)
    const img = thumb.querySelector('img')

    const includedInReport = Number(image.include_in_report) === 1
    const reportBtn = document.createElement('button')
    reportBtn.type = 'button'
    reportBtn.className = `home-image-report-btn ${
      includedInReport ? 'is-included' : 'is-excluded'
    }`
    reportBtn.setAttribute(
      'aria-label',
      includedInReport
        ? `Exclude ${image.caption || image.original_name || `image ${index + 1}`} from the report`
        : `Include ${image.caption || image.original_name || `image ${index + 1}`} in the report`,
    )
    reportBtn.setAttribute('aria-pressed', includedInReport ? 'true' : 'false')
    reportBtn.innerHTML = includedInReport
      ? ASSET_IMAGE_REPORT_INCLUDED_ICON
      : ASSET_IMAGE_REPORT_EXCLUDED_ICON
    reportBtn.addEventListener('click', async (event) => {
      event.stopPropagation()
      const api = window.electronAPI
      if (!api?.updateAssetImageIncludeInReport) return
      const next = Number(image.include_in_report) !== 1
      reportBtn.disabled = true
      try {
        const result = await api.updateAssetImageIncludeInReport(image.id, next)
        image.include_in_report = result?.include_in_report ?? (next ? 1 : 0)
        const nowIncluded = Number(image.include_in_report) === 1
        reportBtn.classList.toggle('is-included', nowIncluded)
        reportBtn.classList.toggle('is-excluded', !nowIncluded)
        reportBtn.setAttribute('aria-pressed', nowIncluded ? 'true' : 'false')
        reportBtn.setAttribute(
          'aria-label',
          nowIncluded
            ? `Exclude ${image.caption || image.original_name || `image ${index + 1}`} from the report`
            : `Include ${image.caption || image.original_name || `image ${index + 1}`} in the report`,
        )
        reportBtn.innerHTML = nowIncluded
          ? ASSET_IMAGE_REPORT_INCLUDED_ICON
          : ASSET_IMAGE_REPORT_EXCLUDED_ICON
      } catch (err) {
        showAppToast(
          `Could not update photo report inclusion: ${String(err?.message ?? err)}`,
          { tone: 'error' },
        )
      } finally {
        reportBtn.disabled = false
      }
    })
    item.appendChild(reportBtn)

    const deleteImgBtn = document.createElement('button')
    deleteImgBtn.type = 'button'
    deleteImgBtn.className = 'home-image-delete-btn'
    deleteImgBtn.setAttribute(
      'aria-label',
      `Delete ${image.caption || image.original_name || `image ${index + 1}`}`,
    )
    deleteImgBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 7h12v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7Zm3 3v9h2v-9H9Zm4 0v9h2v-9h-2ZM9 4h6v2H9V4Zm-4 0h5V2h4v2h5v2H5V4Z"></path></svg>'
    deleteImgBtn.addEventListener('click', async (event) => {
      event.stopPropagation()
      const api = window.electronAPI
      if (!api?.deleteAssetImage) return
      try {
        await settleHomeEditors()
        const result = await api.deleteAssetImage(image.id)
        if (result?.canceled) return
        const updated = await api.listAssetImages(asset.id)
        homeState.assetImages.set(asset.id, updated)
        await renderBuildingDetail()
      } catch {
        // A failed editor flush leaves the current form and its status visible.
      }
    })
    item.appendChild(deleteImgBtn)

    const meta = document.createElement('div')
    meta.className = 'home-asset-image-meta'

    const name = document.createElement('span')
    name.className = 'home-asset-image-name'
    name.dataset.assetImageName = String(image.id)
    name.textContent = image.caption || image.original_name || `Image #${image.id}`
    meta.appendChild(name)

    const resLabel = document.createElement('span')
    resLabel.className = 'home-asset-image-resolution'
    resLabel.textContent = '…'
    meta.appendChild(resLabel)

    const applyResolutionMeta = () => {
      const width = img.naturalWidth
      const height = img.naturalHeight
      if (!width || !height) {
        resLabel.textContent = 'Resolution unknown'
        return
      }
      const low = isLowImageResolution(width, height)
      resLabel.textContent = low
        ? `${width}×${height} · Low resolution`
        : `${width}×${height}`
      resLabel.classList.toggle('is-low', low)
      item.classList.toggle('is-low-resolution', low)
      if (low) {
        resLabel.title =
          'This image is below the recommended size for reports (long edge under 1200px). Consider replacing it with a higher-resolution photo.'
      } else {
        resLabel.removeAttribute('title')
      }
    }
    if (img.complete && img.naturalWidth) {
      applyResolutionMeta()
    } else {
      img.addEventListener('load', applyResolutionMeta, { once: true })
      img.addEventListener(
        'error',
        () => {
          resLabel.textContent = 'Resolution unknown'
        },
        { once: true },
      )
    }

    item.appendChild(meta)
    list.appendChild(item)
  }
  section.appendChild(list)
  return section
}

/**
 * Size an annotation overlay to the letterboxed (object-fit: contain) picture
 * inside `img`, then draw boxes + arrows as children.
 * @param {HTMLImageElement} img
 * @param {HTMLElement} boxLayer
 * @param {object[]|null|undefined} boxes
 */
function positionContainBoxLayer(img, boxLayer, boxes) {
  const list = Array.isArray(boxes) ? boxes : []
  const natW = img.naturalWidth
  const natH = img.naturalHeight
  const frameW = img.clientWidth
  const frameH = img.clientHeight
  if (!natW || !natH || !frameW || !frameH) {
    boxLayer.style.display = 'none'
    boxLayer.replaceChildren()
    return
  }
  const scale = Math.min(frameW / natW, frameH / natH)
  const dispW = natW * scale
  const dispH = natH * scale
  boxLayer.style.display = list.length ? 'block' : 'none'
  boxLayer.style.left = `${(frameW - dispW) / 2}px`
  boxLayer.style.top = `${(frameH - dispH) / 2}px`
  boxLayer.style.width = `${dispW}px`
  boxLayer.style.height = `${dispH}px`
  boxLayer.replaceChildren()
  renderAnnotationElements(boxLayer, list, {
    boxClass: 'home-asset-image-box',
    arrowClass: 'home-asset-image-arrows',
    boxBorderWidth: '1.5px',
  })
}

/** Place boxes once the image has layout (handles detached / cached images). */
function scheduleContainBoxLayer(img, boxLayer, getBoxes) {
  const sync = () => {
    if (!img.naturalWidth || !img.clientWidth || !img.clientHeight) return false
    const boxes = typeof getBoxes === 'function' ? getBoxes() : getBoxes
    positionContainBoxLayer(img, boxLayer, boxes)
    return true
  }
  const ro = new ResizeObserver(() => {
    if (sync()) ro.disconnect()
  })
  ro.observe(img)
  if (img.complete && img.naturalWidth) {
    requestAnimationFrame(() => {
      if (sync()) ro.disconnect()
    })
  } else {
    img.addEventListener(
      'load',
      () => {
        if (sync()) ro.disconnect()
      },
      { once: true },
    )
  }
}

/**
 * Build a contain-fitted image + box overlay marked with data-asset-image-thumb
 * so live saves can refresh every preview of this image.
 * @param {'button'|'div'|'span'} tag
 * @param {string} className
 * @param {{id:number,file_path:string,caption?:string,original_name?:string,bounding_boxes?:any}} image
 */
function createAnnotatedThumb(tag, className, image) {
  const thumb = document.createElement(tag)
  thumb.className = className
  thumb.dataset.assetImageThumb = String(image.id)

  const img = document.createElement('img')
  img.src = image.media_url ?? toFileUrl(image.file_path)
  img.alt = image.caption || image.original_name || 'Asset image'
  img.draggable = false
  thumb.appendChild(img)

  const boxLayer = document.createElement(tag === 'div' ? 'div' : 'span')
  boxLayer.className = 'home-asset-image-boxes'
  thumb.appendChild(boxLayer)

  scheduleContainBoxLayer(img, boxLayer, () => image.bounding_boxes)
  return thumb
}

/** Refresh every on-screen thumbnail overlay for one image from live state. */
function refreshAssetImageThumbBoxes(image) {
  if (!image?.id) return
  document
    .querySelectorAll(`[data-asset-image-thumb="${image.id}"]`)
    .forEach((thumb) => {
      const img = thumb.querySelector('img')
      const boxLayer = thumb.querySelector('.home-asset-image-boxes')
      if (!img || !boxLayer) return
      const run = () => {
        if (!img.naturalWidth || !img.clientWidth || !img.clientHeight) return false
        positionContainBoxLayer(img, boxLayer, image.bounding_boxes)
        return true
      }
      if (run()) return
      requestAnimationFrame(() => {
        if (run()) return
        const ro = new ResizeObserver(() => {
          if (run()) ro.disconnect()
        })
        ro.observe(img)
      })
    })
}
