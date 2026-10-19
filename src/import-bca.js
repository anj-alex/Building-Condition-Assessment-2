// Import a parsed BCA workbook (see src/lib/bca-workbook.js) into a project's
// buildings and assets. Runs in the main process against a better-sqlite3
// database handle so it can be unit-tested against an in-memory database.
//
// Rows map to assets by a stable import key (workbook Sheet ID). On re-import,
// "update" matches that key and refreshes the workbook-sourced fields while
// leaving photos untouched; "new" only adds rows that are not already present.
// Costs, action years and terms are recalculated by the shared engine from the
// imported inputs rather than trusting the workbook's computed columns. See
// docs/excel-import.md.

const { loadCapitalPlanningRules } = require('./lib/capital-planning')
const { hasText } = require('./lib/asset-completeness')
const { mapPricingUnitToUnitMeasure } = require('./shared')

/**
 * Text the workbook uses to mean "nothing recorded". Stored as NULL rather than
 * as content, so a "-" in General State of Repair never reaches the report as a
 * description and never makes a master-library row look assessed.
 */
function importedText(value) {
  return hasText(value) ? String(value).trim() : null
}

/**
 * A construction year, or null. The template writes 0 in Vintage on rows nobody
 * has filled in (576 of 4,091 in the sample); carried through as-is it makes the
 * component 2,025 years old and back-dates its whole lifecycle. Anything that is
 * not a plausible year is not a vintage.
 */
function importedVintage(value, baseYear) {
  const year = Number(value)
  if (!Number.isFinite(year)) return null
  const truncated = Math.trunc(year)
  if (truncated < 1800) return null
  if (baseYear && truncated > baseYear + 5) return null
  return truncated
}

function conditionLabelForScore(score, rules) {
  if (score == null) return null
  const rounded = Math.round(Number(score))
  const match = (rules.condition_ratings ?? []).find((rating) => rating.score === rounded)
  return match?.stored_value ?? null
}

/**
 * Preload the catalogue once. The old row-at-a-time resolver prepared and ran
 * up to three SQL statements for every workbook row (more than 12,000 lookups
 * for the client sample) and preview repeated the work before apply.
 */
function buildPricingLookup(database) {
  const maps = {
    level_1_code: new Map(),
    level_2_code: new Map(),
    level_3_code: new Map(),
  }
  const rows = database
    .prepare(
      `SELECT pricing_id, level_1_code, level_2_code, level_3_code
         FROM uniformat_pricing
        ORDER BY pricing_id`,
    )
    .all()
  for (const row of rows) {
    for (const column of Object.keys(maps)) {
      const code = row[column]
      if (code != null && code !== '' && !maps[column].has(String(code))) {
        maps[column].set(String(code), row.pricing_id)
      }
    }
  }
  return maps
}

/** Resolve a catalogue pricing_id from workbook level codes (L3 → L2 → L1). */
function resolvePricingId(database, row, lookup = null) {
  const maps = lookup ?? buildPricingLookup(database)
  return (
    (row.level3 ? maps.level_3_code.get(String(row.level3)) : null) ||
    (row.level2 ? maps.level_2_code.get(String(row.level2)) : null) ||
    (row.level1 ? maps.level_1_code.get(String(row.level1)) : null) ||
    null
  )
}

/** Map one workbook row to the app's asset fields (no ids). */
function mapRowToAssetFields(row, rules, baseYear = null) {
  // Prefer recalculation from inputs; only carry the workbook OPC as an
  // override when there is nothing to recompute it from.
  const opcOverride =
    row.quantity == null && row.referenceCost == null && row.opc != null && row.opc > 0
      ? row.opc
      : null
  return {
    asset_name: row.assetName ?? null,
    vintage: importedVintage(row.vintage, baseYear),
    service_life: row.normalLife ?? null,
    description: importedText(row.description),
    recommendation: importedText(row.recommendation),
    condition_rating: conditionLabelForScore(row.conditionScore, rules),
    priority: null,
    action: importedText(row.actionType),
    term: null,
    conservation_lens: null,
    unit_measure: mapPricingUnitToUnitMeasure(row.unit) ?? row.unit ?? null,
    quantity: row.quantity ?? null,
    unit_cost_override: row.referenceCost ?? null,
    life_adjustment_years: row.adjustment == null ? 0 : Math.trunc(row.adjustment),
    allowance_interval_years: row.allowanceInterval ?? null,
    action_year: row.allowanceYear ?? null,
    opinion_of_probable_cost: opcOverride,
    import_key: row.importKey,
  }
}

const ASSET_COLUMNS = [
  'asset_name',
  'vintage',
  'service_life',
  'description',
  'recommendation',
  'condition_rating',
  'priority',
  'action',
  'term',
  'conservation_lens',
  'unit_measure',
  'quantity',
  'unit_cost_override',
  'life_adjustment_years',
  'allowance_interval_years',
  'action_year',
  'opinion_of_probable_cost',
  'import_key',
]

function importAssetKey(buildingRef, importKey) {
  return JSON.stringify([buildingRef, String(importKey ?? '')])
}

function legacyIdentityKey(buildingId, pricingId, assetName) {
  return JSON.stringify([
    Number(buildingId),
    String(pricingId ?? ''),
    String(assetName ?? ''),
  ])
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Decide every row's match and operation from one database snapshot. Preview
 * and apply both consume this plan, so the confirmation dialog cannot call a
 * legacy row "new" and then silently update/rekey it during apply.
 */
function planWorkbookImport({ database, parsed, projectId }) {
  const pricing = buildPricingLookup(database)
  const buildingRows = database
    .prepare('SELECT id, site_id FROM building WHERE project_id = ?')
    .all(Number(projectId))
  const buildingBySite = new Map(
    buildingRows.map((row) => [String(row.site_id), Number(row.id)]),
  )
  const siteByBuilding = new Map(
    buildingRows.map((row) => [Number(row.id), String(row.site_id)]),
  )
  const assetRows = database
    .prepare(
      `SELECT e.id, e.building_id, e.uniformat_pricing_id,
              e.asset_name, e.import_key
         FROM asset e
         JOIN building b ON b.id = e.building_id
        WHERE b.project_id = ?
        ORDER BY e.id`,
    )
    .all(Number(projectId))

  const exactByKey = new Map()
  const legacyByIdentity = new Map()
  for (const asset of assetRows) {
    if (asset.import_key != null) {
      exactByKey.set(
        importAssetKey(Number(asset.building_id), asset.import_key),
        { assetId: Number(asset.id), match: 'exact' },
      )
    }
    const siteId = siteByBuilding.get(Number(asset.building_id))
    if (!siteId || asset.import_key == null) continue
    const legacyPattern = new RegExp(`^${escapeRegExp(siteId)}-r[0-9]+$`)
    if (!legacyPattern.test(String(asset.import_key))) continue
    const identity = legacyIdentityKey(
      asset.building_id,
      asset.uniformat_pricing_id,
      asset.asset_name,
    )
    if (!legacyByIdentity.has(identity)) legacyByIdentity.set(identity, [])
    legacyByIdentity.get(identity).push(Number(asset.id))
  }

  const claimedLegacyIds = new Set()
  const entries = []
  for (const [index, row] of (parsed.rows ?? []).entries()) {
    const siteId = String(row.siteId)
    const buildingId = buildingBySite.get(siteId) ?? null
    const buildingRef = buildingId ?? `site:${siteId}`
    const pricingId = resolvePricingId(database, row, pricing)
    if (!pricingId) {
      entries.push({ index, row, siteId, buildingId, operation: 'unresolved' })
      continue
    }

    const key = importAssetKey(buildingRef, row.importKey)
    let match = exactByKey.get(key) ?? null
    if (!match && buildingId) {
      const candidates = legacyByIdentity.get(
        legacyIdentityKey(buildingId, pricingId, row.assetName),
      ) ?? []
      const assetId = candidates.find((id) => !claimedLegacyIds.has(id))
      if (assetId != null) {
        claimedLegacyIds.add(assetId)
        match = { assetId, match: 'legacy' }
        // A second copy of the same workbook key in this plan now resolves to
        // the same row, just as a query after the rekey would during apply.
        exactByKey.set(key, match)
      }
    }

    if (match) {
      entries.push({
        index,
        row,
        siteId,
        buildingId,
        pricingId,
        operation: 'update',
        match: match.match,
        assetId: match.assetId ?? null,
        plannedKey: match.plannedKey ?? null,
      })
      continue
    }

    const plannedKey = `row:${index}`
    exactByKey.set(key, { plannedKey, match: 'planned' })
    entries.push({
      index,
      row,
      siteId,
      buildingId,
      pricingId,
      operation: 'insert',
      match: null,
      assetId: null,
      plannedKey,
    })
  }

  return { entries, buildingBySite }
}

/**
 * Read-only summary of what an import would do, per building and overall.
 * @returns {{ buildings, totals, errors, warnings, missingColumns }}
 */
function previewImport({ database, parsed, projectId }) {
  const bySite = new Map()
  const metaBySite = new Map(
    (parsed.buildings ?? []).map((building) => [String(building.siteId), building]),
  )
  const plan = planWorkbookImport({ database, parsed, projectId })

  for (const entry of plan.entries) {
    if (!bySite.has(entry.siteId)) {
      const meta = metaBySite.get(entry.siteId)
      bySite.set(entry.siteId, {
        siteId: entry.siteId,
        name: meta?.name || `Site ${entry.siteId}`,
        buildingId: entry.buildingId,
        existing: Boolean(entry.buildingId),
        newAssets: 0,
        updateAssets: 0,
        unresolved: 0,
      })
    }
    const bucket = bySite.get(entry.siteId)
    if (entry.operation === 'unresolved') {
      bucket.unresolved += 1
    } else if (entry.operation === 'insert') {
      bucket.newAssets += 1
    } else {
      bucket.updateAssets += 1
    }
  }

  const buildings = [...bySite.values()]
  return {
    buildings,
    totals: {
      buildings: buildings.length,
      // Apply creates a missing site only when at least one resolved row reaches
      // ensureBuilding(). Keep unresolved-only sites visible in `buildings` so
      // their skipped rows are explained, but do not promise a building that the
      // apply phase will never materialize.
      newBuildings: buildings.filter((b) => !b.existing && b.newAssets > 0).length,
      newAssets: buildings.reduce((sum, b) => sum + b.newAssets, 0),
      updateAssets: buildings.reduce((sum, b) => sum + b.updateAssets, 0),
      unresolved: buildings.reduce((sum, building) => sum + building.unresolved, 0),
    },
    errors: parsed.errors ?? [],
    warnings: parsed.warnings ?? [],
    missingColumns: parsed.missingColumns ?? [],
  }
}

/**
 * Apply the import. mode: 'new' only adds rows not already present (by import
 * key); 'update' refreshes existing rows and adds new ones. Photos are never
 * touched. Returns a result summary and the affected building ids.
 */
function applyImport({ database, parsed, projectId, mode = 'update' }) {
  const rules = loadCapitalPlanningRules()
  const baseYear = parsed.baseYear
  const assessmentDate = baseYear ? `${baseYear}-01-01` : null
  const summary = {
    createdBuildings: 0,
    createdAssets: 0,
    updatedAssets: 0,
    // Assets a previous, row-number-keyed import created that this run moved
    // onto the stable key instead of duplicating.
    rekeyedAssets: 0,
    skipped: 0,
    unresolved: 0,
  }
  const buildingIdBySite = new Map()

  const insertBuilding = database.prepare(
    `INSERT INTO building (project_id, property_name, site_id, location_factor, date_of_assessment)
     VALUES (@project_id, @property_name, @site_id, @location_factor, @date_of_assessment)`,
  )
  const rekeyAsset = database.prepare('UPDATE asset SET import_key = ? WHERE id = ?')
  const insertAsset = database.prepare(
    `INSERT INTO asset (building_id, uniformat_pricing_id, ${ASSET_COLUMNS.join(', ')})
     VALUES (@building_id, @uniformat_pricing_id, ${ASSET_COLUMNS.map((c) => `@${c}`).join(', ')})`,
  )
  const updateAsset = database.prepare(
    `UPDATE asset SET uniformat_pricing_id = @uniformat_pricing_id, ${ASSET_COLUMNS.map((c) => `${c} = @${c}`).join(', ')}
     WHERE id = @id`,
  )
  const metaBySite = new Map(
    (parsed.buildings ?? []).map((building) => [String(building.siteId), building]),
  )
  const plan = planWorkbookImport({ database, parsed, projectId })
  for (const [siteId, buildingId] of plan.buildingBySite) {
    buildingIdBySite.set(siteId, buildingId)
  }

  function ensureBuilding(siteId) {
    if (buildingIdBySite.has(siteId)) return buildingIdBySite.get(siteId)
    const meta = metaBySite.get(siteId) ?? {}
    const info = insertBuilding.run({
      project_id: Number(projectId),
      property_name: meta.name || `Site ${siteId}`,
      site_id: siteId,
      location_factor: meta.locationFactor && meta.locationFactor > 0 ? meta.locationFactor : 1,
      date_of_assessment: assessmentDate,
    })
    summary.createdBuildings += 1
    const id = Number(info.lastInsertRowid)
    buildingIdBySite.set(siteId, id)
    return id
  }

  const run = database.transaction(() => {
    const insertedAssetIds = new Map()
    for (const entry of plan.entries) {
      if (entry.operation === 'unresolved') {
        summary.unresolved += 1
        summary.skipped += 1
        continue
      }
      const buildingId = ensureBuilding(entry.siteId)
      const fields = mapRowToAssetFields(entry.row, rules, baseYear)
      if (entry.operation === 'update') {
        if (mode === 'new') {
          summary.skipped += 1
          continue
        }
        const assetId = entry.assetId ?? insertedAssetIds.get(entry.plannedKey)
        if (!assetId) {
          throw new Error(`Import plan lost the matched asset for row ${entry.index + 1}`)
        }
        if (entry.match === 'legacy') {
          rekeyAsset.run(entry.row.importKey, assetId)
          summary.rekeyedAssets += 1
        }
        updateAsset.run({
          ...fields,
          uniformat_pricing_id: entry.pricingId,
          id: assetId,
        })
        summary.updatedAssets += 1
      } else {
        const info = insertAsset.run({
          ...fields,
          building_id: buildingId,
          uniformat_pricing_id: entry.pricingId,
        })
        insertedAssetIds.set(entry.plannedKey, Number(info.lastInsertRowid))
        summary.createdAssets += 1
      }
    }
  })
  run()

  return { summary, buildingIds: [...buildingIdBySite.values()] }
}

module.exports = {
  resolvePricingId,
  mapRowToAssetFields,
  conditionLabelForScore,
  planWorkbookImport,
  previewImport,
  applyImport,
}
