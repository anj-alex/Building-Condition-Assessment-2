/**
 * Verify asset catalogue prefills and the derived calculation panel in the
 * running Electron app.
 *
 * The scenario uses an isolated userData directory because it creates assets.
 * It exercises the real cascading selects, autosave, IPC preview, SQLite
 * persistence, and the hand-maintained C3300 supplement row.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { repoRoot, runScenario, sleep } = require('./ui-driver')

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cara-asset-ui-'))
const outDir = path.join(repoRoot, 'out', 'ui-driver')

function formSelector(assetId) {
  return `.home-asset-form[data-asset-id="${assetId}"]`
}

function changeSelect(assetId, name, value) {
  return `(() => {
    const select = document.querySelector(${JSON.stringify(formSelector(assetId))}).elements[${JSON.stringify(name)}]
    select.value = ${JSON.stringify(value)}
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return select.value
  })()`
}

function inputValue(assetId, name, value) {
  return `(() => {
    const input = document.querySelector(${JSON.stringify(formSelector(assetId))}).elements[${JSON.stringify(name)}]
    input.value = ${JSON.stringify(String(value))}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  })()`
}

async function findPricingPair(home) {
  return home.eval(`(async () => {
    const api = window.electronAPI
    for (const level1 of await api.listUniformatLevel1Groups()) {
      for (const level2 of await api.listUniformatLevel2Groups(level1.name)) {
        for (const level3 of await api.listUniformatLevel3Groups(level1.name, level2.level_2_code)) {
          for (const level4 of await api.listUniformatLevel4Groups(
            level1.name,
            level2.level_2_code,
            level3.level_3_code,
          )) {
            const items = await api.listUniformatPricingItems(
              level1.name,
              level2.level_2_code,
              level3.level_3_code,
              level4.level_4_code,
            )
            const first = items[0]
            if (!first) continue
            const firstLife = first.mean_service_life ?? first.practical_life
            const firstUnit = mapPricingUnitToUnitMeasure(first.unit_of_measure)
            const second = items.find((item) => {
              const life = item.mean_service_life ?? item.practical_life
              const unit = mapPricingUnitToUnitMeasure(item.unit_of_measure)
              return life != null && life !== firstLife && unit && unit !== firstUnit
            })
            if (!second || firstLife == null || !firstUnit) continue
            return {
              level1: level1.name,
              level2: level2.level_2_code,
              level3: level3.level_3_code,
              level4: level4.level_4_code,
              first: {
                id: first.pricing_id,
                life: firstLife,
                unit: firstUnit,
              },
              second: {
                id: second.pricing_id,
                life: second.mean_service_life ?? second.practical_life,
                unit: mapPricingUnitToUnitMeasure(second.unit_of_measure),
              },
            }
          }
        }
      }
    }
    return null
  })()`)
}

async function selectTab(home, label) {
  const tabId = `building-tab-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  await home.click(`#${tabId}`)
  await home.until(
    `[...document.querySelectorAll('.home-detail-tab')].some((item) =>
      item.textContent === ${JSON.stringify(label)} &&
      item.getAttribute('aria-selected') === 'true'
    )`,
    `${label} tab`,
  )
}

async function addOpenAsset(home) {
  await home.click('.home-assets-heading .home-action-btn--primary')
  return home.until(
    `document.querySelector('.home-asset-form')?.dataset.assetId`,
    'new open asset form',
  )
}

async function scenario(session, checks) {
  const home = await session.page('index.html')
  await home.until(`document.querySelectorAll('[data-project-id]').length`, 'project list')
  checks.note('userData', await session.userDataPath())

  const target = await home.eval(`(async () => {
    const project = (await window.electronAPI.listProjects())[0]
    const buildingSummary = project ? (await window.electronAPI.listBuildings(project.id))[0] : null
    const building = buildingSummary
      ? await window.electronAPI.getBuilding(buildingSummary.id)
      : null
    return project && building ? { project, building } : null
  })()`)
  if (!target) throw new Error('isolated dev database did not seed a project and building')

  const candidate = await findPricingPair(home)
  if (!candidate) {
    throw new Error('catalogue has no pricing pair with distinct service-life and unit prefills')
  }
  checks.note(
    'pricing pair',
    `${candidate.first.id} (${candidate.first.life}, ${candidate.first.unit}) → ` +
      `${candidate.second.id} (${candidate.second.life}, ${candidate.second.unit})`,
  )

  await home.click(`[data-project-id="${target.project.id}"]`)
  await home.until(`document.querySelectorAll('.home-property-row').length`, 'property rows')
  await home.click('.home-property-row')
  await home.until(`document.querySelectorAll('.home-detail-tab').length`, 'building tabs')

  await selectTab(home, candidate.level1)
  const assetId = Number(await addOpenAsset(home))
  const form = formSelector(assetId)
  await home.until(
    `document.querySelector(${JSON.stringify(form)})?.elements.uniformat_pricing_id.options.length`,
    'initial pricing cascade',
  )
  checks.check(
    'new asset persists the first catalogue service-life default',
    await home.eval(`(async () => {
      const row = (await window.electronAPI.listAssets(
        ${target.building.id},
        ${JSON.stringify(candidate.level1)},
      )).find((asset) => asset.id === ${assetId})
      const expected = row?.mean_service_life ?? row?.practical_life ?? null
      return row?.service_life != null && row.service_life === expected
    })()`),
    true,
  )

  await home.eval(changeSelect(assetId, 'uniformat_level_2_code', candidate.level2))
  await home.until(
    `[...document.querySelector(${JSON.stringify(form)}).elements.uniformat_level_3_code.options]
      .some((option) => option.value === ${JSON.stringify(candidate.level3)})`,
    'candidate Level 3',
  )
  await home.eval(changeSelect(assetId, 'uniformat_level_3_code', candidate.level3))
  await home.until(
    `[...document.querySelector(${JSON.stringify(form)}).elements.uniformat_level_4_code.options]
      .some((option) => option.value === ${JSON.stringify(candidate.level4)})`,
    'candidate Level 4',
  )
  await home.eval(changeSelect(assetId, 'uniformat_level_4_code', candidate.level4))
  await home.until(
    `[...document.querySelector(${JSON.stringify(form)}).elements.uniformat_pricing_id.options]
      .some((option) => option.value === ${JSON.stringify(candidate.second.id)})`,
    'candidate pricing rows',
  )
  await home.until(
    `document.querySelector(${JSON.stringify(form)}).elements.service_life.value === ${JSON.stringify(String(candidate.first.life))}`,
    'first service-life prefill',
  )
  checks.check(
    'hierarchy change prefills catalogue service life and unit',
    await home.eval(`(() => {
      const form = document.querySelector(${JSON.stringify(form)})
      return [form.elements.service_life.value, form.elements.unit_measure.value]
    })()`),
    [String(candidate.first.life), candidate.first.unit],
  )

  await home.eval(changeSelect(assetId, 'uniformat_pricing_id', candidate.second.id))
  checks.check(
    'pricing-row change refreshes untouched prefills',
    await home.eval(`(() => {
      const form = document.querySelector(${JSON.stringify(form)})
      return [form.elements.service_life.value, form.elements.unit_measure.value]
    })()`),
    [String(candidate.second.life), candidate.second.unit],
  )

  await home.eval(inputValue(assetId, 'service_life', 42))
  await home.eval(changeSelect(assetId, 'uniformat_pricing_id', candidate.first.id))
  await home.eval(changeSelect(assetId, 'uniformat_pricing_id', candidate.second.id))
  checks.check(
    'assessor service-life override survives later pricing changes',
    await home.eval(`document.querySelector(${JSON.stringify(form)}).elements.service_life.value`),
    '42',
  )

  const startYear = Number(String(target.building.date_of_assessment).slice(0, 4))
  await home.eval(changeSelect(assetId, 'condition_rating', 'Fair'))
  await home.eval(inputValue(assetId, 'quantity', 1))
  await home.eval(inputValue(assetId, 'action_year', startYear + 4))
  await home.until(
    `document.querySelector(${JSON.stringify(form)}).querySelector('[data-calc="effective_term"]').textContent === 'Medium Term (derived)'`,
    'derived calculation panel',
  )

  checks.check(
    'per-asset qualitative FCI control is retired',
    await home.eval(`document.querySelector(${JSON.stringify(form)}).elements.fci == null`),
    true,
  )
  checks.check(
    'per-asset manual term override is retired (term is always derived)',
    await home.eval(`document.querySelector(${JSON.stringify(form)}).elements.term == null`),
    true,
  )
  checks.check(
    'condition letter grade is derived',
    await home.eval(`document.querySelector(${JSON.stringify(form)})
      .querySelector('[data-calc="condition_grade"]').textContent`),
    'C - Acceptable',
  )
  checks.check(
    'effective action year identifies its override source',
    await home.eval(`document.querySelector(${JSON.stringify(form)})
      .querySelector('[data-calc="effective_action_year"]').textContent`),
    `${startYear + 4} (override)`,
  )
  checks.check(
    'effective term follows the action-year window',
    await home.eval(`document.querySelector(${JSON.stringify(form)})
      .querySelector('[data-calc="effective_term"]').textContent`),
    'Medium Term (derived)',
  )
  checks.check(
    'building FCI is shown for all four windows',
    await home.eval(`(() => {
      const form = document.querySelector(${JSON.stringify(form)})
      return ['fci_0_2', 'fci_0_5', 'fci_0_10', 'fci_0_25']
        .map((key) => form.querySelector('[data-calc="' + key + '"]').textContent)
        .every((value) => /% · (Very Good|Good|Fair|Poor|Critical)/.test(value))
    })()`),
    true,
  )

  // Suppressing the asset must retract the derived term, not leave it claiming a
  // window its costs never fund.
  await home.eval(changeSelect(assetId, 'action', 'No Action'))
  await home.until(
    `document.querySelector(${JSON.stringify(form)})
      .querySelector('[data-calc="effective_term"]').textContent === 'Not scheduled'`,
    'suppressed term retraction',
  )
  checks.check(
    'No Action retracts the derived term instead of claiming a bucket',
    await home.eval(`document.querySelector(${JSON.stringify(form)})
      .querySelector('[data-calc="effective_term"]').textContent`),
    'Not scheduled',
  )
  await home.eval(changeSelect(assetId, 'action', 'Replace'))
  await home.until(
    `document.querySelector(${JSON.stringify(form)})
      .querySelector('[data-calc="effective_term"]').textContent === 'Medium Term (derived)'`,
    'term restored after un-suppressing',
  )

  await home.until(
    `document.querySelector(${JSON.stringify(form)})
      .querySelector('.home-asset-autosave-status').textContent === 'Saved'`,
    'asset autosave',
  )
  checks.check(
    'pricing prefills and overrides persist through autosave',
    await home.eval(`(async () => {
      const row = (await window.electronAPI.listAssets(
        ${target.building.id},
        ${JSON.stringify(candidate.level1)},
      )).find((asset) => asset.id === ${assetId})
      return row && {
        pricing: row.uniformat_pricing_id,
        serviceLife: row.service_life,
        unit: row.unit_measure,
        condition: row.condition_rating,
        actionYear: row.action_year,
      }
    })()`),
    {
      pricing: candidate.second.id,
      serviceLife: 42,
      unit: candidate.second.unit,
      condition: 'Fair',
      actionYear: startYear + 4,
    },
  )

  await selectTab(home, 'C Interiors')
  const accessibilityAssetId = Number(await addOpenAsset(home))
  const accessibilityForm = formSelector(accessibilityAssetId)
  await home.until(
    `[...document.querySelector(${JSON.stringify(accessibilityForm)})
      .elements.uniformat_level_2_code.options].some((option) => option.value === 'C33')`,
    'C33 Accessibility option',
  )
  await home.eval(changeSelect(accessibilityAssetId, 'uniformat_level_2_code', 'C33'))
  await home.until(
    `[...document.querySelector(${JSON.stringify(accessibilityForm)})
      .elements.uniformat_level_4_code.options].some((option) => option.value === 'C3300')`,
    'C3300 Level 4 option',
  )
  await home.eval(
    changeSelect(accessibilityAssetId, 'uniformat_level_4_code', 'C3300'),
  )
  await home.until(
    `document.querySelector(${JSON.stringify(accessibilityForm)})
      .elements.uniformat_pricing_id.value === 'SUPP-C3300-01'`,
    'supplemental accessibility pricing row',
  )
  checks.check(
    'C33 Accessibility is creatable with blank-price fallback defaults',
    await home.eval(`(() => {
      const form = document.querySelector(${JSON.stringify(accessibilityForm)})
      return {
        level3: form.elements.uniformat_level_3_code.value,
        pricing: form.elements.uniformat_pricing_id.value,
        serviceLife: form.elements.service_life.value,
        unit: form.elements.unit_measure.value,
        price: form.querySelector('[data-calc="unit_price"]').textContent,
      }
    })()`),
    {
      level3: 'C3300',
      pricing: 'SUPP-C3300-01',
      serviceLife: '12',
      unit: 'EA',
      price: '—',
    },
  )

  await home.eval(`document.querySelector(${JSON.stringify(accessibilityForm)})
    .querySelector('.home-asset-calc-panel').scrollIntoView({ block: 'center' })`)
  await sleep(300)
  await home.screenshot(path.join(outDir, 'asset-calculations.png'))
}

void (async () => {
  try {
    await runScenario(
      'verify-asset-calculations',
      {
        rendererPort: 9343,
        mainPort: 9344,
        userDataDir,
      },
      scenario,
    )
  } finally {
    fs.rmSync(userDataDir, { force: true, recursive: true })
  }
})()
