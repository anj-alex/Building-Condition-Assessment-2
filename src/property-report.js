;(() => {
  'use strict'

  const root = document.getElementById('report-root')
  const previewStyles = document.getElementById('docx-preview-styles')
  const statusEl = document.getElementById('export-status')
  const previewSourceEl = document.getElementById('preview-source')
  const previewNote = document.getElementById('preview-note')
  const exportBtn = document.getElementById('export-word')
  const backBtn = document.getElementById('back-home')
  const reviewEl = document.getElementById('report-review')
  const exportModal = document.getElementById('export-modal')
  const exportModalWorking = document.getElementById('export-modal-working')
  const exportModalDone = document.getElementById('export-modal-done')
  const exportModalDoneTitle = document.getElementById('export-modal-done-title')
  const exportModalSummary = document.getElementById('export-modal-done-summary')
  const exportModalFiles = document.getElementById('export-modal-files')
  const exportModalCloseBtn = document.getElementById('export-modal-close')
  const exportModalLabel = document.getElementById('export-modal-label')

  const { projectId } = getActiveIds()
  const buildingIds = getActiveBuildingIds()

  let activePreviewId = null
  let currentReviewReports = []
  let currentBlobUrls = new Set()
  let reviewErrorCount = 0
  let exportOverridden = false
  let reportHasActiveAi = false
  let waitingForAiRetry = false
  let preparationRevision = 0
  let preparationQueued = false
  let preparationRunning = false
  let saveDialogOpen = false
  let saving = false
  let refreshAfterSave = false
  let workMode = null

  function element(tagName, className, textContent) {
    const node = document.createElement(tagName)
    if (className) node.className = className
    if (textContent != null) node.textContent = textContent
    return node
  }

  function nextPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    })
  }

  function titleForReport(report) {
    return getBuildingTitle(report?.building ?? {})
  }

  function fileSlug(value, fallback = 'property') {
    return (
      String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || fallback
    )
  }

  function suggestedDocxName() {
    if (currentReviewReports.length === 1) {
      return `${fileSlug(titleForReport(currentReviewReports[0]))}-condition-assessment.docx`
    }
    const client = currentReviewReports[0]?.project?.client
    return `${fileSlug(client, 'project')}-condition-assessments.docx`
  }

  async function setReportBusy(busy) {
    try {
      await window.electronAPI?.setReportExportBusy?.(busy)
    } catch {
      // The visible state still owns the page if the navigation lock fails.
    }
  }

  function applyExportGate() {
    const working = preparationRunning || saveDialogOpen || saving
    const blockedByReview = reviewErrorCount > 0 && !exportOverridden
    if (backBtn) backBtn.disabled = working
    if (!exportBtn) return
    exportBtn.disabled =
      working || !activePreviewId || reportHasActiveAi || blockedByReview
    exportBtn.setAttribute('aria-describedby', 'word-export-readiness')
    exportBtn.title = preparationRunning
      ? 'The Word preview is still being built.'
      : reportHasActiveAi
        ? 'Waiting for in-progress AI text before rebuilding the Word preview.'
        : blockedByReview
          ? 'Resolve the errors in the pre-export review, or choose “Export anyway”.'
          : !activePreviewId
            ? 'Build a Word preview before saving.'
            : ''
    const readiness = document.getElementById('word-export-readiness')
    if (readiness) {
      readiness.textContent = exportBtn.disabled ? `Save Word Report unavailable: ${exportBtn.title || 'Please wait.'}` : 'Word preview ready. You can save the report.'
    }
  }

  function setPreviewNote({ stale = false } = {}) {
    if (!previewNote) return
    previewNote.replaceChildren(
      element(
        'strong',
        null,
        stale ? 'Preview waiting for an AI update. ' : 'Word-derived preview. ',
      ),
      document.createTextNode(
        stale
          ? 'Saving is paused. This document will be rebuilt when the update finishes.'
          : 'The saved file uses the exact DOCX bytes rendered below. Microsoft Word remains authoritative for final pagination and live fields such as the table of contents.',
      ),
    )
    previewNote.classList.toggle('report-preview-note--stale', stale)
    previewNote.hidden = false
  }

  function blobUrlsIn(...containers) {
    const urls = new Set()
    const collect = (value) => {
      for (const match of String(value ?? '').matchAll(/blob:[^\s"'()]+/g)) {
        urls.add(match[0])
      }
    }
    for (const container of containers) {
      if (!container) continue
      collect(container.textContent)
      for (const node of container.querySelectorAll('*')) {
        for (const attribute of node.attributes ?? []) collect(attribute.value)
      }
    }
    return urls
  }

  function revokeBlobUrls(urls) {
    if (typeof URL?.revokeObjectURL !== 'function') return
    for (const url of urls ?? []) {
      try {
        URL.revokeObjectURL(url)
      } catch {
        // A URL may already have been released by the browser during teardown.
      }
    }
  }

  function clearDisplayedPreview() {
    revokeBlobUrls(currentBlobUrls)
    currentBlobUrls = new Set()
    previewStyles?.replaceChildren()
    delete document.body.dataset.reportReady
    delete document.body.dataset.reportPreviewSource
    if (previewSourceEl) previewSourceEl.hidden = true
    if (previewNote) previewNote.hidden = true
  }

  function showPreviewState({ title, message, busy = false, retry = false }) {
    clearDisplayedPreview()
    const state = element(
      'section',
      `report-preview-state${retry ? ' report-preview-state--error' : ''}`,
    )
    state.setAttribute('role', retry ? 'alert' : 'status')
    if (busy) state.appendChild(element('div', 'report-preview-spinner'))
    state.appendChild(element('h1', null, title))
    const copy = element('p', null, message)
    copy.dataset.previewPhase = ''
    state.appendChild(copy)
    if (retry) {
      const button = element('button', 'report-preview-action', 'Try again')
      button.type = 'button'
      button.addEventListener('click', requestPreparation)
      state.appendChild(button)
    }
    root?.replaceChildren(state)
    root?.setAttribute('aria-busy', busy ? 'true' : 'false')
  }

  function updatePhase(label) {
    if (!label) return
    if (workMode === 'prepare') {
      const phase = root?.querySelector('[data-preview-phase]')
      if (phase) phase.textContent = String(label)
    } else if (workMode === 'save' && exportModalLabel) {
      exportModalLabel.textContent = String(label)
    }
  }

  window.electronAPI?.onExportPhase?.(updatePhase)

  function normalizeDocxBytes(value) {
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
    }
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
    if (Array.isArray(value)) return Uint8Array.from(value)
    if (value?.type === 'Buffer' && Array.isArray(value.data)) {
      return Uint8Array.from(value.data)
    }
    throw new TypeError('The prepared Word document did not contain readable bytes.')
  }

  async function waitForPreviewImages(container) {
    const pending = [...container.querySelectorAll('img')]
      .filter((image) => typeof image.decode === 'function')
      .map((image) => image.decode().catch(() => {}))
    if (pending.length === 0) return
    await Promise.race([
      Promise.all(pending),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ])
  }

  function renderReview() {
    if (!reviewEl) return
    const groups = currentReviewReports
      .map((report) => ({
        title: titleForReport(report),
        result: report?.validation ?? {
          findings: [],
          errorCount: 0,
          warningCount: 0,
        },
      }))
      .filter((group) => (group.result.findings ?? []).length > 0)

    reviewEl.replaceChildren()
    if (groups.length === 0) {
      reviewErrorCount = 0
      reviewEl.appendChild(
        element(
          'div',
          'report-review-summary report-review-summary--clean',
          'Pre-export review: no issues found.',
        ),
      )
      reviewEl.hidden = false
      applyExportGate()
      return
    }

    const totalErrors = groups.reduce(
      (sum, group) => sum + Number(group.result.errorCount ?? 0),
      0,
    )
    const totalWarnings = groups.reduce(
      (sum, group) => sum + Number(group.result.warningCount ?? 0),
      0,
    )
    reviewErrorCount = totalErrors

    const summary = element('div', 'report-review-summary')
    summary.append(
      element('strong', null, 'Pre-export review'),
      element(
        'span',
        'report-review-counts',
        `${totalErrors} error${totalErrors === 1 ? '' : 's'} · ${totalWarnings} warning${totalWarnings === 1 ? '' : 's'}`,
      ),
    )
    reviewEl.appendChild(summary)

    for (const group of groups) {
      if (currentReviewReports.length > 1) {
        reviewEl.appendChild(
          element('h4', 'report-review-building', group.title),
        )
      }
      const list = element('ul', 'report-review-list')
      for (const finding of group.result.findings ?? []) {
        const severity = finding?.severity === 'error' ? 'error' : 'warning'
        const item = element(
          'li',
          `report-review-item report-review-item--${severity}`,
        )
        item.append(
          element(
            'span',
            'report-review-badge',
            severity === 'error' ? 'Error' : 'Warning',
          ),
          element('span', 'report-review-message', finding?.message ?? ''),
        )
        list.appendChild(item)
      }
      reviewEl.appendChild(list)
    }

    if (totalErrors > 0) {
      const block = element('div', 'report-review-block')
      const message = element(
        'span',
        'report-review-block-message',
        `Export is blocked: ${totalErrors} item${totalErrors === 1 ? '' : 's'} must be resolved before this report is a deliverable.`,
      )
      const override = element('button', 'report-review-override', 'Export anyway')
      override.type = 'button'
      override.id = 'report-review-override'
      override.addEventListener('click', () => {
        exportOverridden = true
        block.replaceChildren(
          element(
            'span',
            'report-review-block-message',
            `Export unblocked by the user with ${totalErrors} unresolved item${totalErrors === 1 ? '' : 's'}.`,
          ),
        )
        applyExportGate()
      })
      block.append(message, override)
      reviewEl.appendChild(block)
    }

    reviewEl.hidden = false
    applyExportGate()
  }

  /**
   * Points that `w:space` puts between a paragraph border and its text. These
   * mirror BORDER_SPACE_X / BORDER_SPACE_Y in src/docx-report.js, which is the
   * document's own source for them; test/property-report.test.js fails if the
   * two drift apart.
   */
  const BORDER_SPACE_PT = { top: 6, bottom: 6, left: 8, right: 8 }

  /**
   * Restore the gap between a paragraph border and its text.
   *
   * docx-preview turns `w:pBdr` into a CSS border but drops the `w:space` that
   * says how far the rule sits from the words, so every accent bar and rule
   * renders jammed against its text. Word and LibreOffice both honour it, so the
   * review screen was misrepresenting the file it previews.
   *
   * A left border is also corrected in the other direction: CSS grows the text
   * inward from a border pinned to the margin, while Word leaves the text alone
   * and draws the rule outside it. Pulling the margin back by the same amount
   * puts both the bar and the text where the delivered document puts them, so
   * the preview keeps breaking lines where Word breaks them.
   *
   * Paragraphs only. Table cells carry their real padding from `w:tblCellMar`,
   * which docx-preview does translate.
   */
  function restoreBorderSpacing(scope) {
    const view = scope?.ownerDocument?.defaultView
    if (!view) return
    for (const el of scope.querySelectorAll('p')) {
      const computed = view.getComputedStyle(el)
      for (const side of ['top', 'right', 'bottom', 'left']) {
        const edge = side[0].toUpperCase() + side.slice(1)
        if (!(parseFloat(computed[`border${edge}Width`]) > 0)) continue
        if (parseFloat(computed[`padding${edge}`]) > 0) continue
        const space = BORDER_SPACE_PT[side]
        el.style[`padding${edge}`] = `${space}pt`
        if (side !== 'left' && side !== 'right') continue
        // calc() rather than arithmetic: a computed margin is a length, but
        // not necessarily in the unit this code would have to assume in order
        // to subtract from it.
        const margin = computed[`margin${edge}`]
        const base = /^-?\d*\.?\d+(px|pt|pc|in|cm|mm|em|rem|%)?$/.test(margin) ? margin : '0px'
        el.style[`margin${edge}`] = `calc(${base} - ${space}pt)`
      }
    }
  }

  async function renderPreparedPreview(result, revision) {
    if (typeof window.docx?.renderAsync !== 'function') {
      throw new Error('The bundled Word preview renderer could not be loaded.')
    }
    const bytes = normalizeDocxBytes(result?.docxBytes)
    const stagingBody = document.createElement('div')
    const stagingStyles = document.createElement('div')
    const options = {
      className: 'car-word-preview',
      inWrapper: true,
      breakPages: true,
      // The builder emits section boundaries rather than Word's cached
      // last-rendered markers. Keeping the default preserves those page splits.
      ignoreLastRenderedPageBreak: true,
      // Our running headers and footers rely on measured right tab stops.
      experimental: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderChanges: false,
      renderComments: false,
      renderAltChunks: false,
    }

    updatePhase('Laying out the Word pages…')
    try {
      await window.docx.renderAsync(bytes, stagingBody, stagingStyles, options)
    } catch (error) {
      revokeBlobUrls(blobUrlsIn(stagingBody, stagingStyles))
      throw error
    }
    if (revision !== preparationRevision) {
      revokeBlobUrls(blobUrlsIn(stagingBody, stagingStyles))
      return false
    }

    const renderedPageCount = stagingBody.querySelectorAll(
      '.car-word-preview-wrapper > section.car-word-preview',
    ).length
    if (renderedPageCount === 0) {
      revokeBlobUrls(blobUrlsIn(stagingBody, stagingStyles))
      throw new Error('The Word preview renderer did not produce any pages.')
    }

    const nextBlobUrls = blobUrlsIn(stagingBody, stagingStyles)
    revokeBlobUrls(currentBlobUrls)
    currentBlobUrls = nextBlobUrls
    previewStyles?.replaceChildren(...stagingStyles.childNodes)
    root?.replaceChildren(...stagingBody.childNodes)
    root?.setAttribute('aria-busy', 'false')
    // Only measurable once the generated stylesheet and the pages are both in
    // the live document — the borders it looks for come from that stylesheet.
    restoreBorderSpacing(root)

    // Experimental tab-stop positioning runs 500 ms after renderAsync. Move
    // the pages into the live document first so it can measure real geometry,
    // then withhold readiness until both tabs and images have settled.
    await Promise.all([
      waitForPreviewImages(root),
      new Promise((resolve) => setTimeout(resolve, 550)),
    ])
    await nextPaint()
    if (revision !== preparationRevision) return false

    // Last, because it measures: borders, tab stops and images all move content,
    // and a page split before they settled would cut in the wrong places.
    paginatePreview(root)
    await nextPaint()
    const previewPages = root.querySelectorAll(
      '.car-word-preview-wrapper > section.car-word-preview',
    ).length

    activePreviewId = result.previewId
    currentReviewReports = result.reviewReports ?? []
    exportOverridden = false
    renderReview()
    setPreviewNote()
    if (previewSourceEl) previewSourceEl.hidden = false
    document.body.dataset.reportReady = 'true'
    document.body.dataset.reportPreviewSource = 'docx'

    const propertyCount = currentReviewReports.length
    const skipped = Math.max(0, Number(result.requestedCount ?? 0) - propertyCount)
    if (statusEl) {
      statusEl.textContent = `${propertyCount} ${propertyCount === 1 ? 'property' : 'properties'} · ${previewPages} preview ${previewPages === 1 ? 'page' : 'pages'} ready${skipped ? ` (${skipped} unavailable)` : ''}.`
    }
    applyExportGate()
    return true
  }

  async function prepareOnce(revision) {
    const api = window.electronAPI
    if (!projectId || buildingIds.length === 0 || !api?.preparePropertyReport) {
      showPreviewState({
        title: 'Unable to prepare this report',
        message: 'No valid project and property selection was provided.',
        retry: true,
      })
      return
    }

    showPreviewState({
      title: 'Preparing Word preview…',
      message: 'Collecting report data…',
      busy: true,
    })
    reviewEl.hidden = true
    activePreviewId = null
    currentReviewReports = []
    reviewErrorCount = 0
    exportOverridden = false
    if (statusEl) statusEl.textContent = 'Building the document used for preview and saving…'
    applyExportGate()
    await nextPaint()
    if (revision !== preparationRevision) return

    let result
    for (let attempt = 0; attempt < 2; attempt += 1) {
      result = await api.preparePropertyReport(projectId, buildingIds)
      if (revision !== preparationRevision) return
      if (result?.code !== 'SNAPSHOT_CHANGED' || attempt === 1) break
      updatePhase('Report data changed; rebuilding the latest version…')
    }

    if (!result?.ok) {
      if (result?.superseded && revision !== preparationRevision) return
      if (result?.waitingForAi) {
        reportHasActiveAi = true
        waitingForAiRetry = true
        showPreviewState({
          title: 'Waiting for AI updates…',
          message: result.error || 'The Word preview will build when the update finishes.',
          busy: true,
        })
        if (statusEl) statusEl.textContent = 'Preview paused until AI updates finish.'
        return
      }
      showPreviewState({
        title: 'Word preview could not be prepared',
        message: result?.error || 'The Word document could not be built.',
        retry: true,
      })
      if (statusEl) statusEl.textContent = 'Word preview unavailable.'
      return
    }

    // Main checked the authoritative AI job registry before and after building
    // these bytes. A later `generating` event will invalidate this revision.
    reportHasActiveAi = false
    waitingForAiRetry = false
    try {
      await renderPreparedPreview(result, revision)
    } catch (error) {
      if (revision !== preparationRevision) return
      showPreviewState({
        title: 'Word preview could not be displayed',
        message: error?.message || 'The prepared document could not be rendered.',
        retry: true,
      })
      if (statusEl) statusEl.textContent = 'Word preview unavailable.'
    }
  }

  function requestPreparation() {
    preparationRevision += 1
    preparationQueued = true
    if (preparationRunning || saving || saveDialogOpen) {
      refreshAfterSave = saving || saveDialogOpen
      return
    }

    preparationRunning = true
    workMode = 'prepare'
    applyExportGate()
    void (async () => {
      await setReportBusy(true)
      try {
        while (preparationQueued) {
          preparationQueued = false
          const revision = preparationRevision
          await prepareOnce(revision)
        }
      } catch (error) {
        showPreviewState({
          title: 'Word preview could not be prepared',
          message: error?.message || 'The report could not be loaded.',
          retry: true,
        })
        if (statusEl) statusEl.textContent = 'Word preview unavailable.'
      } finally {
        preparationRunning = false
        workMode = null
        await setReportBusy(false)
        applyExportGate()
        if (preparationQueued && !saving && !saveDialogOpen) requestPreparation()
      }
    })()
  }

  function openSaveModal() {
    if (exportModalWorking) exportModalWorking.hidden = false
    if (exportModalDone) exportModalDone.hidden = true
    if (exportModalLabel) exportModalLabel.textContent = 'Writing the reviewed document…'
    if (exportModal) exportModal.hidden = false
  }

  function finishSaveModal({ docxPath, error }) {
    if (exportModalWorking) exportModalWorking.hidden = true
    if (exportModalDone) exportModalDone.hidden = false
    if (exportModalDoneTitle) {
      exportModalDoneTitle.textContent = error ? 'Save incomplete' : 'Word report saved'
    }
    if (exportModalSummary) {
      exportModalSummary.textContent =
        error ||
        (docxPath
          ? 'The exact document shown in the preview was saved.'
          : 'The Word report was not saved.')
    }
    if (exportModalFiles) {
      exportModalFiles.replaceChildren(
        ...(docxPath ? [element('li', null, `Word: ${docxPath}`)] : []),
      )
    }
    exportModalCloseBtn?.focus()
  }

  async function closeSaveModal() {
    if (exportModal) exportModal.hidden = true
    saving = false
    workMode = null
    await setReportBusy(false)
    applyExportGate()
    if (refreshAfterSave || preparationQueued) {
      refreshAfterSave = false
      requestPreparation()
    }
  }

  function resumePreparationAfterDialog() {
    if (!refreshAfterSave && !preparationQueued) return false
    refreshAfterSave = false
    requestPreparation()
    return true
  }

  async function exportWord() {
    const api = window.electronAPI
    if (
      !activePreviewId ||
      reportHasActiveAi ||
      preparationRunning ||
      saving ||
      !api?.chooseReportExportPath ||
      !api?.exportPropertyReport
    ) {
      return
    }

    const previewIdAtDialogOpen = activePreviewId
    saveDialogOpen = true
    applyExportGate()
    let chosen
    try {
      chosen = await api.chooseReportExportPath(suggestedDocxName())
    } catch (error) {
      if (statusEl) statusEl.textContent = error?.message || 'Could not choose a save location.'
      saveDialogOpen = false
      applyExportGate()
      resumePreparationAfterDialog()
      return
    }
    saveDialogOpen = false

    if (!chosen || chosen.canceled) {
      if (statusEl) statusEl.textContent = 'Save canceled.'
      applyExportGate()
      resumePreparationAfterDialog()
      return
    }
    if (!chosen.exportId) {
      if (statusEl) statusEl.textContent = 'The save location could not be authorized.'
      applyExportGate()
      resumePreparationAfterDialog()
      return
    }
    if (
      reportHasActiveAi ||
      refreshAfterSave ||
      preparationQueued ||
      preparationRunning ||
      activePreviewId !== previewIdAtDialogOpen
    ) {
      if (statusEl) statusEl.textContent = 'The preview changed; rebuild it before choosing a save location again.'
      requestPreparation()
      return
    }

    saving = true
    workMode = 'save'
    openSaveModal()
    applyExportGate()
    await nextPaint()
    await setReportBusy(true)

    try {
      const result = await api.exportPropertyReport(
        previewIdAtDialogOpen,
        chosen.exportId,
        { allowValidationErrors: exportOverridden },
      )
      const failed = Boolean(result?.error) || !result?.docxPath
      if (result?.code === 'STALE_PREVIEW' || result?.code === 'AI_ACTIVE') {
        refreshAfterSave = true
      }
      if (statusEl) {
        statusEl.textContent = failed ? 'The Word report was not saved.' : 'Word report saved.'
      }
      finishSaveModal({
        docxPath: result?.docxPath,
        error: result?.error || (failed ? 'The Word report could not be saved.' : null),
      })
    } catch (error) {
      if (statusEl) statusEl.textContent = 'The Word report was not saved.'
      finishSaveModal({ error: error?.message || 'The Word report could not be saved.' })
    }
    // Done releases the busy lock, so the result cannot be dismissed unseen.
  }

  function aiUpdateBelongsToReport(payload) {
    return buildingIds.includes(Number(payload?.buildingId))
  }

  function handleReportAiUpdate(payload) {
    if (payload?.state === 'generating') {
      if (!aiUpdateBelongsToReport(payload)) return
      // Supersede an in-flight docx-preview layout. Otherwise its delayed
      // tab-stop pass could publish readiness after this stale signal.
      preparationRevision += 1
      reportHasActiveAi = true
      delete document.body.dataset.reportReady
      setPreviewNote({ stale: true })
      if (statusEl) {
        statusEl.textContent = 'AI update in progress; this Word preview will rebuild when it finishes.'
      }
      applyExportGate()
      return
    }
    if (payload?.state === 'finished') {
      // Older/malformed caption jobs may lack buildingId. If main previously
      // told this page to wait, any terminal event is enough to ask main again;
      // main remains authoritative and will keep waiting if another relevant
      // job is still active.
      if (!aiUpdateBelongsToReport(payload) && !waitingForAiRetry) return
      reportHasActiveAi = false
      waitingForAiRetry = false
      if (saving || saveDialogOpen) {
        refreshAfterSave = true
      } else {
        requestPreparation()
      }
    }
  }

  backBtn?.addEventListener('click', () => {
    if (!preparationRunning && !saving && !saveDialogOpen) goBackHome(projectId)
  })
  if (exportBtn) {
    const readiness = document.createElement('p')
    readiness.id = 'word-export-readiness'
    readiness.setAttribute('role', 'status')
    readiness.style.cssText = 'font-size:0.875rem;margin:0.4rem 0;'
    exportBtn.insertAdjacentElement('afterend', readiness)
  }
  exportBtn?.addEventListener('click', () => void exportWord())
  exportModalCloseBtn?.addEventListener('click', () => void closeSaveModal())
  window.electronAPI?.onCaptionUpdated?.(handleReportAiUpdate)
  window.electronAPI?.onSummaryUpdated?.(handleReportAiUpdate)
  window.addEventListener('beforeunload', () => revokeBlobUrls(currentBlobUrls))

  requestPreparation()
})()
