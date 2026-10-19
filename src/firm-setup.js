const firmForm = document.getElementById('firm-setup-form')
const firmLogoPreview = document.getElementById('firm-logo-preview')
const chooseFirmLogoBtn = document.getElementById('choose-firm-logo')
const autosaveStatus = document.getElementById('firm-autosave-status')

let firmState = null

function renderLogoPreview(firm) {
  if (!firmLogoPreview) return
  firmLogoPreview.replaceChildren()
  if (!firm?.logo_path) {
    const empty = document.createElement('p')
    empty.className = 'firm-logo-empty'
    empty.textContent = 'No logo selected.'
    firmLogoPreview.appendChild(empty)
    return
  }
  const img = document.createElement('img')
  img.src = firm.media_url ?? toFileUrl(firm.logo_path)
  img.alt = firm.logo_original_name || 'Firm logo'
  firmLogoPreview.appendChild(img)

  const removeBtn = document.createElement('button')
  removeBtn.type = 'button'
  removeBtn.className = 'btn-danger firm-logo-remove-btn'
  removeBtn.textContent = 'Remove logo'
  removeBtn.addEventListener('click', async () => {
    const api = window.electronAPI
    if (!api?.removeFirmLogo) return
    // Flush text edits first so logo remove is not racing a pending autosave.
    await autosave.saveNow({ force: true })
    firmState = await api.removeFirmLogo()
    fillFirmForm(firmState)
    autosave.setStatus('Saved')
  })
  firmLogoPreview.appendChild(removeBtn)
}

function fillFirmForm(firm) {
  setInputValueById('firm-name', firm?.name)
  setInputValueById('firm-short-name', firm?.short_name)
  setInputValueById('firm-address-line-1', firm?.address_line_1)
  setInputValueById('firm-address-line-2', firm?.address_line_2)
  renderLogoPreview(firm)
}

function buildFirmPayload() {
  const fd = new FormData(firmForm)
  return {
    ...firmState,
    name: formTextValue(fd, 'name') || 'Consultant',
    short_name: formTextValue(fd, 'short_name'),
    address_line_1: formTextValue(fd, 'address_line_1'),
    address_line_2: formTextValue(fd, 'address_line_2'),
  }
}

const autosave = createFormAutosave({
  form: firmForm,
  statusEl: autosaveStatus,
  buildPayload: buildFirmPayload,
  canSave: () => Boolean(window.electronAPI?.updateFirm),
  save: async (payload) => {
    firmState = await window.electronAPI.updateFirm(payload)
  },
})

autosave.bindForm()
autosave.bindPagehide()
autosave.wireBack(document.getElementById('back-home'), () => goBackHome())

chooseFirmLogoBtn?.addEventListener('click', async () => {
  const api = window.electronAPI
  if (!api?.importFirmLogo || !api?.updateFirm) return
  // Persist text fields before the file dialog (same as prior behaviour).
  await autosave.saveNow({ force: true })
  firmState = await api.importFirmLogo()
  fillFirmForm(firmState)
  autosave.setStatus('Saved')
})

async function bootstrapFirmSetup() {
  const api = window.electronAPI
  if (!api?.getFirm) {
    autosave.enable()
    return
  }
  try {
    firmState = await api.getFirm()
    fillFirmForm(firmState)
  } catch (err) {
    console.warn('Failed to load firm:', err?.message || err)
  } finally {
    autosave.enable()
  }
}

function handleFirmSetupHistory(result) {
  if (!result?.undone && !result?.redone) return
  if (result.type !== 'firm-update') return
  autosave.cancelPending()
  void (async () => {
    const api = window.electronAPI
    if (!api?.getFirm) return
    firmState = await api.getFirm()
    fillFirmForm(firmState)
    autosave.setStatus('')
  })()
}

window.addEventListener('app-undo', (event) => {
  handleFirmSetupHistory(event.detail)
})
window.addEventListener('app-redo', (event) => {
  handleFirmSetupHistory(event.detail)
})

void bootstrapFirmSetup()
