// Home-page asset editor: the field schema, the Uniformat cascade, the AI
// Description / Recommendation panels, and the autosaving per-asset form.
//
// Split out of src/renderer.js, which was 3.3k lines. Loaded as a classic
// <script> before it, so both files share one global scope — a name declared
// here is visible there and vice versa, and a collision breaks whichever file
// loads second (test/page-scripts.test.js fails on that). Nothing here runs at
// load time beyond these declarations, so it does not depend on renderer.js
// having initialized yet; the reverse is also true.

/** Active open asset form controllers (cancel pending autosave / flush on leave). */
const activeAssetFormControllers = new Map()

const UNIFORMAT_SELECT_NAMES = new Set([
  'uniformat_level_2_code',
  'uniformat_level_3_code',
  'uniformat_level_4_code',
  'uniformat_pricing_id',
])

function disposeAssetFormController(assetId) {
  const controller = activeAssetFormControllers.get(Number(assetId))
  if (!controller) return
  controller.dispose()
  activeAssetFormControllers.delete(Number(assetId))
}

/** Retire all controllers after their caller has flushed, or to discard after history. */
function disposeAllAssetFormControllers() {
  const entries = [...activeAssetFormControllers.entries()]
  for (const [assetId, controller] of entries) {
    if (activeAssetFormControllers.get(assetId) === controller) {
      activeAssetFormControllers.delete(assetId)
    }
    controller.dispose()
  }
}

const CONDITION_RATINGS = [
  { value: 'Not applicable', label: 'Not applicable' },
  { value: 'Very good', label: '1 - Very good' },
  { value: 'Good', label: '2 - Good' },
  { value: 'Fair', label: '3 - Fair' },
  { value: 'Poor', label: '4 - Poor' },
  { value: 'Very poor', label: '5 - Very poor' },
  { value: 'Critical', label: '6 - Critical' },
]

const ACTION_TYPES = [
  'Decommission',
  'Install',
  'Investigate',
  'Maintain',
  'No Action',
  'Refurbish',
  'Repair',
  'Replace',
]

const NO_PRIORITY_VALUE = 'No Priority'
/** Work priorities only — "No Priority" is exclusive to Maintain / No Action. */
const PRIORITY_VALUES = ['High', 'Medium', 'Low']
/** Action types that do not carry a work priority — priority is forced to No Priority. */
const NO_PRIORITY_ACTIONS = new Set(['No Action', 'Maintain'])

const CONSERVATION_LENS_VALUES = [
  'Not Applicable',
  'Energy Savings - Moderate Impact',
  'Energy Savings - Significant Impact',
  'Water Savings - Moderate Impact',
  'Water Savings - Significant Impact',
]

const UNIT_MEASURE_VALUES = [...ASSET_UNIT_MEASURE_VALUES]

const assetFields = [
  { name: 'asset_name', label: 'Asset Name', type: 'text', layout: 'primary' },
  { name: 'vintage', label: 'Vintage', type: 'number', layout: 'compact' },
  { name: 'service_life', label: 'Service Life', type: 'number', layout: 'compact' },
  {
    name: 'condition_rating',
    label: 'Condition Rating',
    type: 'select',
    options: CONDITION_RATINGS,
    placeholder: '',
    layout: 'fifth',
  },
  {
    name: 'priority',
    label: 'Priority',
    type: 'select',
    options: PRIORITY_VALUES,
    placeholder: 'Select priority',
    layout: 'fifth',
  },
  {
    name: 'action',
    label: 'Action Type',
    type: 'select',
    options: ACTION_TYPES,
    placeholder: 'Select action',
    layout: 'fifth',
  },
  {
    name: 'conservation_lens',
    label: 'Energy / Water Conservation Lens',
    type: 'select',
    options: CONSERVATION_LENS_VALUES,
    placeholder: 'Select conservation lens',
    layout: 'fifth',
  },
  {
    name: 'unit_measure',
    label: 'Unit Measure',
    type: 'select',
    options: UNIT_MEASURE_VALUES,
    placeholder: 'Select unit measure',
    layout: 'fifth',
  },
  { name: 'quantity', label: 'Quantity', type: 'number', layout: 'fifth', step: 'any' },
  {
    name: 'unit_cost_override',
    label: 'Unit Cost Override',
    type: 'number',
    layout: 'fifth',
    step: 'any',
  },
  {
    name: 'life_adjustment_years',
    label: 'Life Adj (Yrs)',
    type: 'number',
    layout: 'fifth',
  },
  {
    name: 'allowance_interval_years',
    label: 'Allowance Interval (Yrs)',
    type: 'number',
    layout: 'fifth',
  },
  { name: 'action_year', label: 'Action Year Override', type: 'number', layout: 'fifth' },
  {
    name: 'opinion_of_probable_cost',
    label: 'OPC Override',
    type: 'number',
    layout: 'fifth',
    step: 'any',
  },
  {
    name: 'include_as_not_assessed',
    label: 'Include in report as “Not Assessed” (incomplete assets only)',
    type: 'checkbox',
    layout: 'wide',
  },
]

function countWords(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

function conditionDescriptionSentence(rating) {
  const phrases = {
    Critical:
      'Overall condition is critical: the asset or major parts of the system have failed or present an immediate risk to service and require urgent intervention.',
    'Very poor':
      'Overall condition is very poor and unacceptable, with widespread advanced deterioration. Failure has occurred or appears imminent across many components, and service is already affected.',
    Poor:
      'Overall condition is poor and largely below standard. Many elements are near end of life and need replacement; the asset is only marginally functional, with extensive deterioration across a large share of components.',
    Fair:
      'Overall condition is fair, with general wear that may need attention. Some components show significant deficiencies that require repair or maintenance to restore proper function.',
    Good:
      'Overall condition is good and performance is adequate. Aside from routine preventive maintenance under normal use, no short- or medium-term capital work is anticipated.',
    'Very good':
      'Overall condition is very good, consistent with new or recently refurbished equipment. No notable defects were observed, and remaining useful life is expected to exceed ten years.',
  }
  if (!rating || rating === 'Not applicable') return null
  return phrases[rating] ?? `Overall condition is rated ${rating}.`
}

function selectedSelectLabel(select) {
  const option = select?.selectedOptions?.[0]
  if (!option?.value) return null
  return option.textContent.trim()
}

function uniformatLabelDescription(label) {
  if (!label) return null
  const space = label.indexOf(' ')
  return space === -1 ? label : label.slice(space + 1).trim()
}

function assetDraftFromForm(form, asset) {
  const pricingLabel = selectedSelectLabel(form.elements.uniformat_pricing_id)
  const level4Label = selectedSelectLabel(form.elements.uniformat_level_4_code)
  const level3Label = selectedSelectLabel(form.elements.uniformat_level_3_code)

  return {
    ...asset,
    asset_name: form.elements.asset_name?.value ?? asset.asset_name,
    // Do not fall back to saved values for live preview fields the user can clear.
    vintage: formNumberValue(new FormData(form), 'vintage'),
    condition_rating: form.elements.condition_rating?.value ?? asset.condition_rating,
    priority: form.elements.priority?.value || null,
    action: form.elements.action?.value ?? asset.action,
    // Term is always the derived term shown in the live calculation panel;
    // there is no manual override.
    term: form.dataset.effectiveTerm || null,
    material: pricingLabel,
    level_4_description: level4Label
      ? uniformatLabelDescription(level4Label)
      : null,
    level_3_description: level3Label
      ? uniformatLabelDescription(level3Label)
      : null,
  }
}

function generateAssetDescription(asset) {
  const name = asset.asset_name?.trim() || 'This asset'
  const component = (
    asset.level_4_description
    || asset.material
    || asset.level_3_description
    || 'building components'
  ).toLowerCase()
  const vintage = asset.vintage ? ` constructed circa ${asset.vintage}` : ''
  const intro = `${name} consists of ${component}${vintage}.`
  const condition = conditionDescriptionSentence(asset.condition_rating)
  return condition ? `${intro} ${condition}` : intro
}

function actionLocksPriority(action) {
  return NO_PRIORITY_ACTIONS.has(action)
}

function prioritySelectOptions(locked) {
  if (locked) {
    return [{ value: NO_PRIORITY_VALUE, label: NO_PRIORITY_VALUE }]
  }
  return [
    { value: '', label: 'Select priority' },
    ...PRIORITY_VALUES.map((value) => ({ value, label: value })),
  ]
}

/**
 * When action is Maintain / No Action, force priority to No Priority (only option) and disable.
 * For other actions, rebuild High/Medium/Low options without No Priority.
 * Returns true if the priority value was changed.
 */
function syncPriorityFieldForAction(form) {
  const actionSelect = form.elements.action
  const prioritySelect = form.elements.priority
  if (!actionSelect || !prioritySelect) return false

  const locked = actionLocksPriority(actionSelect.value)
  const previous = prioritySelect.value
  const nextValue = locked
    ? NO_PRIORITY_VALUE
    : PRIORITY_VALUES.includes(previous)
      ? previous
      : ''

  setSelectOptions(prioritySelect, prioritySelectOptions(locked), nextValue)
  prioritySelect.disabled = locked
  return previous !== prioritySelect.value
}

function priorityRecommendationPhrase(priority) {
  const phrases = {
    High:
      'This is high priority work: it addresses code, safety, or immediate health concerns, or work that if deferred is likely to cause substantial further deterioration, much higher repair cost, or system failure.',
    Medium:
      'This is medium priority work expected from the age and remaining service life of the component.',
    Low:
      'This is low priority work beyond what is needed to keep the facility operating and is not driven by code or condition; it is suggested as an optional upgrade for energy performance, appearance, or improved function.',
  }
  return phrases[priority] ?? null
}

/** Timing clause from the asset term field, matching sample BCA phrasing. */
function termTimingPhrase(term) {
  const phrases = {
    Immediate: 'in the immediate term',
    'Short Term': 'in the short term',
    'Medium Term': 'in the medium term',
    'Long Term': 'in the long term',
    'End of Life': 'at the end of its useful life',
  }
  return phrases[term] ?? null
}

function generateAssetRecommendation(asset) {
  const action = asset.action
  const name = asset.asset_name?.trim() || 'This component'
  const timing = termTimingPhrase(asset.term)
  const timingOrHorizon = timing || 'within the capital planning horizon'

  const actionPhrases = {
    Decommission: timing
      ? `${name} is no longer in service and remains on site. Removal and disposal from the property is recommended ${timing}.`
      : `${name} is no longer in service and remains on site. Removal and disposal from the property is recommended.`,
    Install: timing
      ? `${name} is not currently present. Installation is recommended ${timing} based on site observations and applicable code or best-practice requirements.`
      : `${name} is not currently present. Installation is recommended based on site observations and applicable code or best-practice requirements.`,
    Investigate: timing
      ? `Additional study of ${name} is recommended ${timing} to establish the required scope of work.`
      : `Additional study of ${name} is recommended to establish the required scope of work.`,
    Maintain:
      `Replacement of ${name} is not expected within the term of analysis; continue to maintain the asset in service.`,
    'No Action':
      `${name} is expected to remain serviceable through the full term of analysis without capital intervention.`,
    Refurbish: timing
      ? `Full replacement of ${name} is not preferred given site, facility, or client constraints. Renewal or limited upgrade of the existing installation is recommended ${timing}.`
      : `Full replacement of ${name} is not preferred given site, facility, or client constraints. Renewal or limited upgrade of the existing installation is recommended instead.`,
    Repair: timing
      ? `${name} requires adjustment or corrective work so it can perform as intended. Repair is recommended ${timing}.`
      : `${name} requires adjustment or corrective work so it can perform as intended.`,
    Replace:
      `Replacement of ${name} is recommended ${timingOrHorizon}.`,
  }

  const parts = []
  if (action) {
    parts.push(actionPhrases[action] ?? `Recommend ${action.toLowerCase()} for ${name}.`)
  }
  if (action && !actionLocksPriority(action)) {
    const priorityPhrase = priorityRecommendationPhrase(asset.priority)
    if (priorityPhrase) {
      parts.push(priorityPhrase)
    }
  }

  if (parts.length === 0) {
    return 'Select an action type and priority to generate a recommendation.'
  }
  return parts.join(' ')
}

function createGeneratedTextSection({ sectionTitle, fieldName, generatedText, finalValue }) {
  const section = document.createElement('section')
  section.className = 'home-asset-generated-section'

  const header = document.createElement('div')
  header.className = 'home-asset-generated-header'
  const title = document.createElement('h3')
  title.textContent = sectionTitle
  header.appendChild(title)

  const wordCount = document.createElement('span')
  wordCount.className = 'home-asset-generated-word-count'
  wordCount.textContent = `Words: ${countWords(finalValue)}`
  header.appendChild(wordCount)
  section.appendChild(header)

  const row = document.createElement('div')
  row.className = 'home-asset-generated-row'

  const generatedCol = document.createElement('div')
  generatedCol.className = 'home-asset-generated-col'
  const generatedLabel = document.createElement('span')
  generatedLabel.className = 'home-asset-generated-label'
  generatedLabel.textContent = 'Generated Text'
  generatedCol.appendChild(generatedLabel)
  const generatedArea = document.createElement('textarea')
  generatedArea.className = 'home-asset-generated-preview'
  generatedArea.readOnly = true
  generatedArea.value = generatedText
  generatedArea.setAttribute('aria-label', `${sectionTitle} generated text`)
  generatedCol.appendChild(generatedArea)

  const transferBtn = document.createElement('button')
  transferBtn.type = 'button'
  transferBtn.className = 'home-asset-generated-transfer'
  transferBtn.textContent = '›› Final Text'
  transferBtn.title = 'Copy generated text into final text'
  transferBtn.setAttribute('aria-label', `Copy generated text into final ${sectionTitle.toLowerCase()}`)

  const finalCol = document.createElement('div')
  finalCol.className = 'home-asset-generated-col'
  const finalLabel = document.createElement('span')
  finalLabel.className = 'home-asset-generated-label'
  finalLabel.textContent = 'Final Text'
  finalCol.appendChild(finalLabel)
  const finalArea = document.createElement('textarea')
  finalArea.name = fieldName
  finalArea.className = 'home-asset-generated-final'
  finalArea.readOnly = false
  finalArea.value = finalValue ?? ''
  finalArea.setAttribute('aria-label', `${sectionTitle} final text`)
  finalArea.addEventListener('input', () => {
    wordCount.textContent = `Words: ${countWords(finalArea.value)}`
  })
  transferBtn.addEventListener('click', () => {
    finalArea.value = generatedArea.value
    finalArea.dispatchEvent(new Event('input', { bubbles: true }))
    finalArea.focus()
  })
  finalCol.appendChild(finalArea)

  row.append(generatedCol, transferBtn, finalCol)
  section.appendChild(row)
  return { section, generatedArea, finalArea }
}

function getAssetSummary(asset) {
  const parts = [
    asset.level_2_group_element,
    asset.condition_rating ? `Condition: ${asset.condition_rating}` : null,
    asset.priority && asset.priority !== NO_PRIORITY_VALUE ? `Priority: ${asset.priority}` : null,
    asset.action ? `Action: ${asset.action}` : null,
  ].filter(Boolean)
  return parts.join(' | ')
}

function buildAssetPayloadFromForm(form) {
  const fd = new FormData(form)
  const payload = {}
  payload.uniformat_pricing_id = formTextValue(fd, 'uniformat_pricing_id')
  for (const field of assetFields) {
    if (field.type === 'checkbox') {
      payload[field.name] = form.elements[field.name]?.checked ? 1 : 0
      continue
    }
    if (field.type === 'number') {
      payload[field.name] = formNumberValue(fd, field.name)
      continue
    }
    // Disabled controls are omitted from FormData; read the live element value.
    let text = formTextValue(fd, field.name)
    const el = form.elements[field.name]
    if (text == null && el?.disabled) {
      text = String(el.value ?? '').trim() || null
    }
    payload[field.name] = text
  }
  payload.description = formTextValue(fd, 'description')
  payload.recommendation = formTextValue(fd, 'recommendation')
  return payload
}

/** Merge a saved payload into homeState and derive Uniformat display fields from the open form. */
function mergeAssetLocalState(assetId, form, payload) {
  const index = homeState.assets.findIndex((entry) => entry.id === assetId)
  if (index < 0) return null
  const prev = homeState.assets[index]
  const level2Label = selectedSelectLabel(form.elements.uniformat_level_2_code)
  const level3Label = selectedSelectLabel(form.elements.uniformat_level_3_code)
  const level4Label = selectedSelectLabel(form.elements.uniformat_level_4_code)
  const materialLabel = selectedSelectLabel(form.elements.uniformat_pricing_id)
  const next = {
    ...prev,
    ...payload,
    level_2_code: form.elements.uniformat_level_2_code?.value || prev.level_2_code,
    level_3_code: form.elements.uniformat_level_3_code?.value || prev.level_3_code,
    level_4_code: form.elements.uniformat_level_4_code?.value || prev.level_4_code,
    level_2_group_element: level2Label || prev.level_2_group_element,
    level_3_description: level3Label
      ? uniformatLabelDescription(level3Label)
      : prev.level_3_description,
    level_4_description: level4Label
      ? uniformatLabelDescription(level4Label)
      : prev.level_4_description,
    material: materialLabel || prev.material,
  }
  homeState.assets[index] = next
  return next
}

function updateAssetRowHeader(asset) {
  const item = document.querySelector(`.home-asset-item[data-asset-id="${asset.id}"]`)
  if (!item) return
  const nameEl = item.querySelector('.home-asset-row-text strong')
  if (nameEl) {
    nameEl.textContent = asset.asset_name?.trim() || `Asset #${asset.id}`
  }
  const textWrap = item.querySelector('.home-asset-row-text')
  if (!textWrap) return
  let summary = textWrap.querySelector('.home-asset-summary')
  const summaryText = getAssetSummary(asset)
  if (summaryText) {
    if (!summary) {
      summary = document.createElement('span')
      summary.className = 'home-asset-summary'
      textWrap.appendChild(summary)
    }
    summary.textContent = summaryText
  } else if (summary) {
    summary.remove()
  }
}

function getAssetFormValue(asset, field) {
  if (field.name === 'vintage' && asset.vintage == null) {
    return getSelectedBuilding()?.property_vintage ?? ''
  }
  return asset[field.name] ?? ''
}

function createSelectField({ name, label, value, required = false, layout = 'uniformat' }) {
  const wrap = document.createElement('label')
  wrap.className = [
    'home-asset-field',
    layout ? `home-asset-field--${layout}` : null,
  ].filter(Boolean).join(' ')
  const labelText = document.createElement('span')
  labelText.textContent = label
  wrap.appendChild(labelText)

  const select = document.createElement('select')
  select.name = name
  select.required = required
  select.dataset.currentValue = value ?? ''
  wrap.appendChild(select)
  return { wrap, select }
}

function setSelectOptions(select, options, value, placeholder) {
  select.replaceChildren()
  for (const option of options) {
    const item = document.createElement('option')
    item.value = option.value
    item.textContent = option.label
    if (option.unitOfMeasure != null && option.unitOfMeasure !== '') {
      item.dataset.unitOfMeasure = option.unitOfMeasure
    }
    if (option.meanServiceLife != null && option.meanServiceLife !== '') {
      item.dataset.meanServiceLife = option.meanServiceLife
    }
    if (option.practicalLife != null && option.practicalLife !== '') {
      item.dataset.practicalLife = option.practicalLife
    }
    select.appendChild(item)
  }
  // Allow empty-string values (blank options); only fall back when value is missing or invalid.
  const hasMatch = options.some((option) => option.value === value)
  select.value = hasMatch ? value : (options[0]?.value ?? '')
  select.disabled = options.length === 0
}

function pricingItemLabel(item) {
  return item.label || item.pricing_id
}

function applyDefaultUnitMeasureFromPricing(form, { onlyIfEmpty = true } = {}) {
  const unitSelect = form.elements.unit_measure
  const pricing = form.elements.uniformat_pricing_id
  if (!unitSelect || !pricing) return false
  if (onlyIfEmpty && unitSelect.value) return false
  const selected = pricing.selectedOptions?.[0]
  const mapped = mapPricingUnitToUnitMeasure(selected?.dataset?.unitOfMeasure)
  if (!mapped || mapped === unitSelect.value) return false
  const hasOption = Array.from(unitSelect.options).some((option) => option.value === mapped)
  if (!hasOption) return false
  unitSelect.value = mapped
  return true
}

function applyDefaultServiceLifeFromPricing(form, { onlyIfEmpty = true } = {}) {
  const serviceLife = form.elements.service_life
  const pricing = form.elements.uniformat_pricing_id
  if (!serviceLife || !pricing) return false
  if (onlyIfEmpty && serviceLife.value !== '') return false
  const selected = pricing.selectedOptions?.[0]
  const value = selected?.dataset?.meanServiceLife || selected?.dataset?.practicalLife
  if (!value || serviceLife.value === value) return false
  serviceLife.value = value
  return true
}

function hydrateUniformatSelectors(
  form,
  asset,
  onSelectorsChange,
  {
    canReplaceServiceLife = () => true,
    canReplaceUnitMeasure = () => true,
    onStart = () => {},
    onSuccess = () => {},
    onError = () => {},
  } = {},
) {
  const api = window.electronAPI
  if (!api?.listUniformatLevel2Groups) {
    return { ready: Promise.resolve(), settle: async () => {} }
  }

  const level2 = form.elements.uniformat_level_2_code
  const level3 = form.elements.uniformat_level_3_code
  const level4 = form.elements.uniformat_level_4_code
  const pricing = form.elements.uniformat_pricing_id
  const level1GroupName = homeState.activeBuildingTab
  let cascadeGeneration = 0
  let pendingCascade = Promise.resolve()

  const isCurrent = (generation) => generation === cascadeGeneration

  function setDisabled(controls, disabled) {
    for (const control of controls) {
      control.disabled = disabled || control.options.length === 0
    }
  }

  async function loadLevel2(generation) {
    const rows = await api.listUniformatLevel2Groups(level1GroupName)
    if (!isCurrent(generation)) return false
    setSelectOptions(
      level2,
      rows.map((row) => ({ value: row.level_2_code, label: row.label })),
      asset.level_2_code,
      'Select Level 2',
    )
    return true
  }

  async function loadLevel3(value = asset.level_3_code, generation) {
    const selectedLevel2 = level2.value
    const rows = level2.value && api.listUniformatLevel3Groups
      ? await api.listUniformatLevel3Groups(level1GroupName, level2.value)
      : []
    if (!isCurrent(generation) || level2.value !== selectedLevel2) return false
    setSelectOptions(
      level3,
      rows.map((row) => ({ value: row.level_3_code, label: row.label })),
      value,
      'Select Level 3',
    )
    return true
  }

  async function loadLevel4(value = asset.level_4_code, generation) {
    const selectedLevel2 = level2.value
    const selectedLevel3 = level3.value
    const rows = level2.value && level3.value && api.listUniformatLevel4Groups
      ? await api.listUniformatLevel4Groups(level1GroupName, level2.value, level3.value)
      : []
    if (
      !isCurrent(generation) ||
      level2.value !== selectedLevel2 ||
      level3.value !== selectedLevel3
    ) {
      return false
    }
    // Blank (empty label) is always available — same pattern as condition rating.
    setSelectOptions(
      level4,
      [
        { value: '', label: '' },
        ...rows.map((row) => ({ value: row.level_4_code, label: row.label })),
      ],
      value ?? '',
    )
    return true
  }

  async function loadPricing(
    value = asset.uniformat_pricing_id,
    { pricingChanged = false } = {},
    generation,
  ) {
    const selectedLevel2 = level2.value
    const selectedLevel3 = level3.value
    const selectedLevel4 = level4.value
    const rows = level2.value && level3.value && level4.value && api.listUniformatPricingItems
      ? await api.listUniformatPricingItems(
          level1GroupName,
          level2.value,
          level3.value,
          level4.value,
        )
      : []
    if (
      !isCurrent(generation) ||
      level2.value !== selectedLevel2 ||
      level3.value !== selectedLevel3 ||
      level4.value !== selectedLevel4
    ) {
      return null
    }
    setSelectOptions(
      pricing,
      rows.map((row) => ({
        value: row.pricing_id,
        label: pricingItemLabel(row),
        unitOfMeasure: row.unit_of_measure,
        meanServiceLife: row.mean_service_life,
        practicalLife: row.practical_life,
      })),
      value,
      'Select item',
    )
    const defaultedUnitMeasure =
      !pricingChanged || canReplaceUnitMeasure()
        ? applyDefaultUnitMeasureFromPricing(form, {
            onlyIfEmpty: !pricingChanged,
          })
        : false
    const defaultedServiceLife =
      !pricingChanged || canReplaceServiceLife()
        ? applyDefaultServiceLifeFromPricing(form, {
            onlyIfEmpty: !pricingChanged,
          })
        : false
    return { defaultedServiceLife, defaultedUnitMeasure }
  }

  function startCascade(run, controlsToDisable) {
    const generation = ++cascadeGeneration
    onStart()
    setDisabled(controlsToDisable, true)
    const request = (async () => {
      try {
        await run(generation)
        if (isCurrent(generation)) onSuccess()
      } catch (err) {
        if (!isCurrent(generation)) return
        onError(err)
        throw err
      } finally {
        if (isCurrent(generation)) setDisabled(controlsToDisable, false)
      }
    })()
    // Event listeners intentionally do not await this promise. Attach a handler
    // here so failures are surfaced through onError without becoming unhandled;
    // settle() still awaits the original rejecting promise and blocks teardown.
    void request.catch(() => {})
    pendingCascade = request
    return request
  }

  async function settle() {
    for (;;) {
      const request = pendingCascade
      await request
      if (request === pendingCascade) return
    }
  }

  level2.addEventListener('change', () => {
    setSelectOptions(level3, [], null, 'Select Level 3')
    setSelectOptions(level4, [{ value: '', label: '' }], '')
    setSelectOptions(pricing, [], null, 'Select item')
    startCascade(async (generation) => {
      if (!(await loadLevel3(null, generation))) return
      if (!(await loadLevel4(null, generation))) return
      const defaults = await loadPricing(null, { pricingChanged: true }, generation)
      if (defaults && isCurrent(generation)) onSelectorsChange?.(defaults)
    }, [level3, level4, pricing])
  })
  level3.addEventListener('change', () => {
    setSelectOptions(level4, [{ value: '', label: '' }], '')
    setSelectOptions(pricing, [], null, 'Select item')
    startCascade(async (generation) => {
      if (!(await loadLevel4(null, generation))) return
      const defaults = await loadPricing(null, { pricingChanged: true }, generation)
      if (defaults && isCurrent(generation)) onSelectorsChange?.(defaults)
    }, [level4, pricing])
  })
  level4.addEventListener('change', () => {
    setSelectOptions(pricing, [], null, 'Select item')
    startCascade(async (generation) => {
      const defaults = await loadPricing(null, { pricingChanged: true }, generation)
      if (defaults && isCurrent(generation)) onSelectorsChange?.(defaults)
    }, [pricing])
  })
  pricing.addEventListener('change', () => {
    const defaultedUnitMeasure = canReplaceUnitMeasure()
      ? applyDefaultUnitMeasureFromPricing(form, { onlyIfEmpty: false })
      : false
    const defaultedServiceLife = canReplaceServiceLife()
      ? applyDefaultServiceLifeFromPricing(form, { onlyIfEmpty: false })
      : false
    onSelectorsChange?.({ defaultedServiceLife, defaultedUnitMeasure })
  })

  const hydrateAll = () => startCascade(async (generation) => {
    if (!(await loadLevel2(generation))) return
    if (!(await loadLevel3(asset.level_3_code, generation))) return
    if (!(await loadLevel4(asset.level_4_code, generation))) return
    const defaults = await loadPricing(
      asset.uniformat_pricing_id,
      { pricingChanged: false },
      generation,
    )
    if (defaults && isCurrent(generation)) onSelectorsChange?.(defaults)
  }, [level2, level3, level4, pricing])

  const ready = hydrateAll()
  return { ready, settle, retry: hydrateAll }
}

function createAssetForm(asset) {
  disposeAssetFormController(asset.id)

  const form = document.createElement('form')
  form.className = 'home-asset-form'
  form.dataset.assetId = String(asset.id)
  form.addEventListener('click', (event) => {
    event.stopPropagation()
  })

  const autosaveStatus = document.createElement('span')
  autosaveStatus.className = 'home-asset-autosave-status'
  autosaveStatus.setAttribute('aria-live', 'polite')
  autosaveStatus.textContent = ''

  const retryUniformatBtn = document.createElement('button')
  retryUniformatBtn.type = 'button'
  retryUniformatBtn.className =
    'home-action-btn home-action-btn--inline home-asset-uniformat-retry'
  retryUniformatBtn.textContent = 'Retry pricing choices'
  retryUniformatBtn.hidden = true

  let saveTimer = null
  let saveInFlight = null
  let dirtyRevision = 0
  let disposed = false
  // Block autosave until initial Uniformat hydration finishes (avoids silent writes).
  let allowAutosave = false
  let unregisterDraftFlusher = null
  let uniformatCascadeController = {
    ready: Promise.resolve(),
    settle: async () => {},
    retry: () => Promise.resolve(),
  }
  const dirtyFields = new Map()
  const userTouchedFields = new Set()
  const ASSET_AUTOSAVE_MS = 400

  function dispose() {
    disposed = true
    allowAutosave = false
    if (saveTimer != null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    unregisterDraftFlusher?.()
    unregisterDraftFlusher = null
  }

  function markDirty(name) {
    if (name) dirtyFields.set(name, ++dirtyRevision)
  }

  function buildSavePayload() {
    const payload = buildAssetPayloadFromForm(form)
    // Prefills (building vintage and catalogue defaults) must not write until
    // the field itself or the pricing row is touched.
    if (!dirtyFields.has('vintage')) {
      payload.vintage = asset.vintage ?? null
    }
    if (
      !dirtyFields.has('service_life') &&
      !dirtyFields.has('uniformat_pricing_id')
    ) {
      payload.service_life = asset.service_life ?? null
    }
    if (
      !dirtyFields.has('unit_measure') &&
      !dirtyFields.has('uniformat_pricing_id')
    ) {
      payload.unit_measure = asset.unit_measure ?? null
    }
    return payload
  }

  async function saveAssetNow({ force = false } = {}) {
    // force: pagehide / teardown flush — write even if the form was just disposed.
    if (!force && (disposed || !form.isConnected || !allowAutosave)) return
    if (dirtyFields.size === 0) return
    const api = window.electronAPI
    if (!api?.updateAsset) {
      if (force) throw new Error('Asset saving is unavailable')
      return
    }

    for (;;) {
      // Parent Uniformat changes finish asynchronously. Do not snapshot the form
      // until the newest cascade has populated its material selector.
      await uniformatCascadeController.settle()

      // Never let an older payload finish after a newer one and overwrite it.
      while (saveInFlight) {
        await saveInFlight
      }
      // A new cascade may have started while an older write was in flight.
      await uniformatCascadeController.settle()
      if (!force && (disposed || !form.isConnected || !allowAutosave)) return
      if (dirtyFields.size === 0) return

      const payload = buildSavePayload()
      // JOIN-based asset lists require a pricing row; do not wipe it with an empty select.
      if (!payload.uniformat_pricing_id) {
        if (!disposed && form.isConnected) {
          autosaveStatus.textContent = 'Choose a material to save'
        }
        if (force) throw new Error('Choose a material before leaving this asset')
        return
      }

      const savingFields = new Map(dirtyFields)
      if (!disposed && form.isConnected) {
        autosaveStatus.textContent = 'Saving…'
      }
      const request = (async () => {
        try {
          await api.updateAsset(asset.id, payload)
          for (const [name, revision] of savingFields) {
            if (dirtyFields.get(name) === revision) dirtyFields.delete(name)
          }
          if (disposed || !form.isConnected) return
          if (dirtyFields.size === 0) {
            const next = mergeAssetLocalState(asset.id, form, payload)
            if (next) {
              Object.assign(asset, next)
              updateAssetRowHeader(next)
            }
            autosaveStatus.textContent = 'Saved'
          }
        } catch (err) {
          if (!disposed && form.isConnected) {
            autosaveStatus.textContent = 'Save failed'
          }
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

      if (!force || dirtyFields.size === 0) return
      // A field changed during the forced write. Loop until the form reaches a
      // clean revision before its caller is allowed to dispose or navigate.
    }
  }

  function scheduleAssetSave({ immediate = false } = {}) {
    if (disposed || !allowAutosave) return
    if (saveTimer != null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    if (immediate) {
      void saveAssetNow().catch(() => {})
      return
    }
    saveTimer = setTimeout(() => {
      saveTimer = null
      void saveAssetNow().catch(() => {})
    }, ASSET_AUTOSAVE_MS)
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    scheduleAssetSave({ immediate: true })
  })
  form.addEventListener('input', (event) => {
    const name = event.target?.name
    if (name) userTouchedFields.add(name)
    markDirty(name)
    scheduleAssetSave()
  })
  form.addEventListener('change', (event) => {
    const name = event.target?.name
    if (name) userTouchedFields.add(name)
    markDirty(name)
    // Cascading Uniformat selects save from onSelectorsChange after children reload.
    if (UNIFORMAT_SELECT_NAMES.has(name)) return
    scheduleAssetSave()
  })

  const uniformatFields = [
    createSelectField({
      name: 'uniformat_level_2_code',
      label: 'Level 2 Group',
      value: asset.level_2_code,
      required: true,
    }),
    createSelectField({
      name: 'uniformat_level_3_code',
      label: 'Level 3 Group',
      value: asset.level_3_code,
      required: true,
    }),
    createSelectField({
      name: 'uniformat_level_4_code',
      label: 'Level 4 Group',
      value: asset.level_4_code,
      required: false,
    }),
    createSelectField({
      name: 'uniformat_pricing_id',
      label: 'Material',
      value: asset.uniformat_pricing_id,
      required: true,
    }),
  ]

  for (const field of assetFields) {
    if (field.type === 'select') {
      const { wrap, select } = createSelectField({
        name: field.name,
        label: field.label,
        value: getAssetFormValue(asset, field),
        layout: field.layout,
      })
      const options = [
        { value: '', label: field.placeholder ?? 'Select' },
        ...field.options.map((option) =>
          typeof option === 'string'
            ? { value: option, label: option }
            : { value: option.value, label: option.label },
        ),
      ]
      setSelectOptions(select, options, getAssetFormValue(asset, field))
      form.appendChild(wrap)
    } else if (field.type === 'checkbox') {
      const label = document.createElement('label')
      label.className = ['home-asset-field', 'home-asset-field--checkbox', field.layout ? `home-asset-field--${field.layout}` : null]
        .filter(Boolean)
        .join(' ')
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.name = field.name
      input.checked = Boolean(Number(getAssetFormValue(asset, field)))
      const labelText = document.createElement('span')
      labelText.textContent = field.label
      label.append(input, labelText)
      form.appendChild(label)
    } else {
      const label = document.createElement('label')
      label.className = [
        'home-asset-field',
        field.type === 'textarea' ? 'home-asset-field--wide' : null,
        field.layout ? `home-asset-field--${field.layout}` : null,
      ].filter(Boolean).join(' ')
      const labelText = document.createElement('span')
      labelText.textContent = field.label
      label.appendChild(labelText)

      const input = field.type === 'textarea'
        ? document.createElement('textarea')
        : document.createElement('input')
      input.name = field.name
      if (field.type !== 'textarea') {
        input.type = field.type
      }
      if (field.step) input.step = field.step
      input.value = getAssetFormValue(asset, field)
      label.appendChild(input)
      form.appendChild(label)
    }
    if (field.name === 'service_life') {
      for (const uniformatField of uniformatFields) {
        form.appendChild(uniformatField.wrap)
      }
    }
  }

  const calcPanel = document.createElement('section')
  calcPanel.className = 'home-asset-calc-panel'
  calcPanel.innerHTML = `
    <h3 class="home-asset-calc-title">Asset calculation preview</h3>
    <dl class="home-asset-calc-grid">
      <div><dt>Catalogue unit price</dt><dd data-calc="unit_price"></dd></div>
      <div><dt>Adjusted unit cost</dt><dd data-calc="adjusted_unit_cost"></dd></div>
      <div><dt>Calculated OPC</dt><dd data-calc="calculated_opc"></dd></div>
      <div><dt>Condition grade</dt><dd data-calc="condition_grade"></dd></div>
      <div><dt>Age</dt><dd data-calc="age"></dd></div>
      <div><dt>Remaining life</dt><dd data-calc="remaining_life"></dd></div>
      <div><dt>Estimated replacement year</dt><dd data-calc="replacement_year"></dd></div>
      <div><dt>Effective action year</dt><dd data-calc="effective_action_year"></dd></div>
      <div><dt>Recurrence interval</dt><dd data-calc="recurrence_interval"></dd></div>
      <div><dt>Effective term</dt><dd data-calc="effective_term"></dd></div>
      <div><dt>Building FCI · 0–2 years</dt><dd data-calc="fci_0_2"></dd></div>
      <div><dt>Building FCI · 0–5 years</dt><dd data-calc="fci_0_5"></dd></div>
      <div><dt>Building FCI · 0–10 years</dt><dd data-calc="fci_0_10"></dd></div>
      <div><dt>Building FCI · 0–25 years</dt><dd data-calc="fci_0_25"></dd></div>
    </dl>
    <p class="home-asset-calc-note">Overrides are identified beside the value. FCI is calculated for the building, not assigned to this asset. Location factor comes from Building Info (default 1.0).</p>
  `
  form.appendChild(calcPanel)

  const formatCatalogueUnitPrice = (raw) => {
    const text = String(raw ?? '').trim()
    if (!text) return '—'
    if (/[a-zA-Z]| to |–|—/i.test(text)) return text
    const amount = Number(text.replace(/[^0-9.-]/g, ''))
    if (!Number.isFinite(amount)) return text
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: 'CAD',
      maximumFractionDigits: 2,
    }).format(amount)
  }
  const money = (value) =>
    value == null || !Number.isFinite(value)
      ? '—'
      : new Intl.NumberFormat('en-CA', {
          style: 'currency',
          currency: 'CAD',
          maximumFractionDigits: 0,
        }).format(value)

  const numberWithUnit = (value, unit) =>
    value == null || !Number.isFinite(Number(value))
      ? '—'
      : `${Number(value).toLocaleString('en-CA', { maximumFractionDigits: 2 })} ${unit}`
  const year = (value) =>
    value == null || !Number.isFinite(Number(value)) ? '—' : String(Math.trunc(Number(value)))
  const sourceLabel = (source) => ({
    asset: 'asset vintage',
    asset_value: 'asset service life',
    building: 'building vintage',
    override: 'override',
    derived: 'derived',
    allowance_override: 'allowance override',
    catalogue_mean: 'catalogue mean life',
    catalogue_practical: 'catalogue practical life',
  })[source] ?? source
  const withSource = (value, source) => {
    if (value === '—' || value == null || value === '') return '—'
    return source ? `${value} (${sourceLabel(source)})` : String(value)
  }
  const fciValue = (row) =>
    row?.percent == null
      ? '—'
      : `${Number(row.percent).toLocaleString('en-CA', { maximumFractionDigits: 1 })}% · ${row.grade ?? '—'}`

  let previewSeq = 0
  let refreshGeneratedText = () => {}
  const refreshCostPreview = () => {
    const seq = ++previewSeq
    const api = window.electronAPI
    if (!api?.previewAssetPlan) return
    const fd = new FormData(form)
    const formValues = {
      uniformat_pricing_id: form.elements.uniformat_pricing_id?.value || null,
      quantity: formNumberValue(fd, 'quantity'),
      unit_cost_override: formNumberValue(fd, 'unit_cost_override'),
      life_adjustment_years: formNumberValue(fd, 'life_adjustment_years'),
      allowance_interval_years: formNumberValue(fd, 'allowance_interval_years'),
      action_year: formNumberValue(fd, 'action_year'),
      opinion_of_probable_cost: formNumberValue(fd, 'opinion_of_probable_cost'),
      vintage: formNumberValue(fd, 'vintage'),
      service_life: formNumberValue(fd, 'service_life'),
      condition_rating: form.elements.condition_rating?.value ?? null,
      action: form.elements.action?.value ?? null,
      unit_measure: form.elements.unit_measure?.value || null,
    }
    void api.previewAssetPlan(asset.id, formValues).then((plan) => {
      if (seq !== previewSeq || disposed) return
      calcPanel.querySelector('[data-calc="unit_price"]').textContent = formatCatalogueUnitPrice(
        plan?.catalogueUnitPriceText ?? plan?.catalogueUnitPrice,
      )
      calcPanel.querySelector('[data-calc="adjusted_unit_cost"]').textContent = money(
        plan?.adjustedUnitCost,
      )
      calcPanel.querySelector('[data-calc="calculated_opc"]').textContent = money(
        plan?.opinionOfProbableCost,
      )
      calcPanel.querySelector('[data-calc="condition_grade"]').textContent =
        plan?.conditionGrade ?? '—'
      calcPanel.querySelector('[data-calc="age"]').textContent = withSource(
        numberWithUnit(plan?.age, 'yr'),
        plan?.vintageSource,
      )
      calcPanel.querySelector('[data-calc="remaining_life"]').textContent =
        numberWithUnit(plan?.remainingLife, 'yr')
      calcPanel.querySelector('[data-calc="replacement_year"]').textContent =
        year(plan?.estimatedReplacementYear)
      calcPanel.querySelector('[data-calc="effective_action_year"]').textContent =
        withSource(year(plan?.actionYear), plan?.actionYearSource)
      calcPanel.querySelector('[data-calc="recurrence_interval"]').textContent =
        withSource(
          numberWithUnit(plan?.recurrenceInterval, 'yr'),
          plan?.recurrenceIntervalSource,
        )
      // A suppressed asset has no term because it funds no window; say so rather
      // than showing a bare dash the assessor has to interpret.
      calcPanel.querySelector('[data-calc="effective_term"]').textContent =
        plan?.effectiveTerm == null && plan?.suppressed
          ? 'Not scheduled'
          : withSource(plan?.effectiveTerm ?? '—', plan?.termSource)
      const fciById = new Map((plan?.buildingFci ?? []).map((row) => [row.id, row]))
      calcPanel.querySelector('[data-calc="fci_0_2"]').textContent =
        fciValue(fciById.get('years_0_2'))
      calcPanel.querySelector('[data-calc="fci_0_5"]').textContent =
        fciValue(fciById.get('years_0_5'))
      calcPanel.querySelector('[data-calc="fci_0_10"]').textContent =
        fciValue(fciById.get('years_0_10'))
      calcPanel.querySelector('[data-calc="fci_0_25"]').textContent =
        fciValue(fciById.get('years_0_25'))
      form.dataset.effectiveTerm = plan?.effectiveTerm ?? ''
      refreshGeneratedText()
    })
  }
  refreshCostPreview()
  form.addEventListener('input', refreshCostPreview)
  form.addEventListener('change', refreshCostPreview)
  const descriptionSection = createGeneratedTextSection({
    sectionTitle: 'Observations & Description',
    fieldName: 'description',
    generatedText: generateAssetDescription(asset),
    finalValue: asset.description,
  })
  form.appendChild(descriptionSection.section)

  const recommendationSection = createGeneratedTextSection({
    sectionTitle: 'Recommendations',
    fieldName: 'recommendation',
    generatedText: generateAssetRecommendation(asset),
    finalValue: asset.recommendation,
  })
  form.appendChild(recommendationSection.section)

  refreshGeneratedText = () => {
    const draft = assetDraftFromForm(form, asset)
    descriptionSection.generatedArea.value = generateAssetDescription(draft)
    recommendationSection.generatedArea.value = generateAssetRecommendation(draft)
  }

  uniformatCascadeController = hydrateUniformatSelectors(
    form,
    asset,
    () => {
      refreshGeneratedText()
      refreshCostPreview()
      if (!allowAutosave || disposed) return
      markDirty('uniformat_pricing_id')
      markDirty('unit_measure')
      scheduleAssetSave()
    },
    {
      canReplaceServiceLife: () => !userTouchedFields.has('service_life'),
      canReplaceUnitMeasure: () => !userTouchedFields.has('unit_measure'),
      onStart: () => {
        retryUniformatBtn.disabled = true
        retryUniformatBtn.hidden = true
        if (autosaveStatus.dataset.uniformatError === 'true') {
          delete autosaveStatus.dataset.uniformatError
          autosaveStatus.textContent = 'Loading pricing choices…'
        }
      },
      onSuccess: () => {
        if (disposed) return
        retryUniformatBtn.disabled = false
        retryUniformatBtn.hidden = true
        allowAutosave = true
        if (dirtyFields.size > 0) scheduleAssetSave()
      },
      onError: (err) => {
        retryUniformatBtn.disabled = false
        retryUniformatBtn.hidden = false
        autosaveStatus.dataset.uniformatError = 'true'
        autosaveStatus.textContent = `Could not load pricing choices: ${String(
          err?.message ?? err,
        )}`
      },
    },
  )

  for (const fieldName of ['asset_name', 'vintage', 'condition_rating', 'priority', 'action']) {
    form.elements[fieldName]?.addEventListener('change', refreshGeneratedText)
    form.elements[fieldName]?.addEventListener('input', refreshGeneratedText)
  }

  // Maintain / No Action force priority to No Priority and grey out the control.
  const applyPriorityLock = ({ saveIfChanged = false } = {}) => {
    const changed = syncPriorityFieldForAction(form)
    if (changed) {
      markDirty('priority')
      refreshGeneratedText()
      if (saveIfChanged && allowAutosave && !disposed) scheduleAssetSave()
    }
  }
  applyPriorityLock({ saveIfChanged: false })
  form.elements.action?.addEventListener('change', () => {
    applyPriorityLock({ saveIfChanged: true })
  })

  const imageSection = createAssetImageSection(asset)
  form.appendChild(imageSection)

  const actions = document.createElement('div')
  actions.className = 'home-asset-form-actions'
  retryUniformatBtn.addEventListener('click', () => {
    void uniformatCascadeController.retry().catch(() => {})
  })
  actions.append(autosaveStatus, retryUniformatBtn)

  const deleteBtn = document.createElement('button')
  deleteBtn.type = 'button'
  deleteBtn.className = 'home-action-btn home-action-btn--inline home-action-btn--danger'
  deleteBtn.textContent = 'Delete asset'
  deleteBtn.addEventListener('click', async (event) => {
    event.stopPropagation()
    const api = window.electronAPI
    if (!api?.deleteAsset) return
    const result = await api.deleteAsset(asset.id)
    // Only tear down the form after a confirmed delete — cancel must keep autosave alive.
    if (result?.canceled) return
    dispose()
    activeAssetFormControllers.delete(Number(asset.id))
    homeState.openAssetIds.delete(asset.id)
    await loadActiveAssets()
  })
  actions.appendChild(deleteBtn)
  form.appendChild(actions)

  const controller = {
    dispose,
    flush: () => saveAssetNow({ force: true }),
  }
  unregisterDraftFlusher = registerRendererDraftFlusher(controller.flush)
  activeAssetFormControllers.set(Number(asset.id), controller)
  return form
}
