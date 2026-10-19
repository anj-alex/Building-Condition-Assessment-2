// Parser for the client's BCA Excel workbook (the "Worksheet" sheet of
// Asset-List_*-BCA_Worksheet_draft_v1.xlsx). Turns a workbook into a normalized
// { baseYear, buildings, rows, missingColumns, errors, warnings } structure the
// importer maps onto projects/buildings/assets. Pure: it takes an already-read
// SheetJS workbook so it can be unit-tested against the sample file without
// booting Electron. See docs/excel-import.md.

// Fixed column layout of the sample template (header row 3, data rows 4+),
// documented in docs/workbook-calculation-reference.md §2. Each field is read
// from its letter; the header at that letter is checked so a changed template
// surfaces as a missing/renamed column instead of silently mis-reading.
const FIELD_COLUMNS = [
  { key: 'componentNo', letter: 'A', header: 'Component' },
  { key: 'sheetId', letter: 'B', header: 'Sheet ID' },
  { key: 'siteId', letter: 'C', header: 'Site ID', required: true },
  { key: 'buildingName', letter: 'D', header: 'Building' },
  { key: 'level1', letter: 'F', header: 'Level 1', required: true },
  { key: 'level2', letter: 'G', header: 'Level 2', required: true },
  { key: 'level3', letter: 'H', header: 'Level 3', required: true },
  { key: 'level3Component', letter: 'I', header: 'Level 3 - Component' },
  { key: 'assetName', letter: 'J', header: 'Asset Name', required: true },
  { key: 'description', letter: 'L', header: 'General State of Repair' },
  { key: 'recommendation', letter: 'M', header: 'Recommendation' },
  { key: 'groupId', letter: 'N', header: 'GROUP ID' },
  { key: 'conditionScore', letter: 'S', header: 'Condition Average', numeric: true },
  { key: 'actionType', letter: 'U', header: 'Action Type' },
  { key: 'vintage', letter: 'W', header: 'Vintage', numeric: true },
  { key: 'normalLife', letter: 'Y', header: 'Normal Life', numeric: true },
  { key: 'adjustment', letter: 'AA', header: 'Adjustment', numeric: true },
  { key: 'allowanceYear', letter: 'AC', header: 'Allowance Year', numeric: true },
  { key: 'allowanceInterval', letter: 'AD', header: 'Allowance Interv', numeric: true },
  { key: 'actionYear', letter: 'AE', header: 'Action Year', numeric: true },
  { key: 'unit', letter: 'AG', header: 'Unit' },
  { key: 'quantity', letter: 'AH', header: 'Quantity', numeric: true },
  { key: 'referenceCost', letter: 'AI', header: 'Unit Repl. Cost', money: true },
  { key: 'opc', letter: 'AK', header: 'Opinion of Probable Cost', money: true },
]

const HEADER_ROW = 3 // 1-based; data begins on row 4.

/** The Legend sheet carries its own header on row 3, so its sites start at 4. */
const LEGEND_FIRST_ROW = 4

function cellAt(sheet, letter, row) {
  return sheet[`${letter}${row}`] ?? null
}

function isErrorCell(cell) {
  return cell != null && cell.t === 'e'
}

function normalizeHeader(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function moneyValue(cell) {
  if (cell == null || isErrorCell(cell)) return null
  if (typeof cell.v === 'number') return Number.isFinite(cell.v) ? cell.v : null
  const text = String(cell.v ?? cell.w ?? '').trim()
  if (!text) return null
  const cleaned = text.replace(/[^0-9.-]/g, '')
  if (!cleaned || cleaned === '-' || cleaned === '.') return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

function numericValue(cell) {
  if (cell == null || isErrorCell(cell)) return null
  if (typeof cell.v === 'number') return Number.isFinite(cell.v) ? cell.v : null
  const text = String(cell.v ?? '').trim()
  if (!text) return null
  const parsed = Number(text.replace(/[^0-9.-]/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

function textValue(cell) {
  if (cell == null || isErrorCell(cell)) return null
  const value = cell.w ?? cell.v
  const text = String(value ?? '').trim()
  return text || null
}

/**
 * Legend sheet: Site ID (A) -> { name (B), locationFactor (F) }, base year (B2).
 *
 * The site block runs from row 4 to the end of the sheet. It used to be read to
 * row 60, which silently dropped every site past the 57th — the 75-property
 * workbook lists its last eighteen from row 61 down, so those buildings were
 * created with no location factor and costed at 1.0 while the workbook priced
 * them at their own.
 *
 * Below the sites the sheet holds reference tables — condition ratings, action
 * types, unit measures — whose first column is a label rather than a site id.
 * They land in the map and are never read, because `parseBcaWorkbook` only asks
 * it about site ids the asset rows actually carry. The first entry for an id
 * wins, so nothing further down the sheet can displace a real site.
 */
function parseLegend(workbook) {
  const legend = workbook.Sheets?.Legend
  const buildings = new Map()
  let baseYear = null
  if (!legend) return { buildings, baseYear }
  const base = numericValue(cellAt(legend, 'B', 2))
  if (base && base > 1900) baseYear = Math.trunc(base)
  const lastRow = decodeRange(legend['!ref'])?.endRow ?? LEGEND_FIRST_ROW
  for (let row = LEGEND_FIRST_ROW; row <= lastRow; row += 1) {
    const site = textValue(cellAt(legend, 'A', row))
    if (!site || buildings.has(site)) continue
    buildings.set(site, {
      siteId: site,
      name: textValue(cellAt(legend, 'B', row)),
      locationFactor: numericValue(cellAt(legend, 'F', row)),
    })
  }
  return { buildings, baseYear }
}

/**
 * Stable identity for a workbook row, used to match it to an existing asset on
 * re-import. It must depend only on what the row *is*, never on where it sits:
 * a key derived from the row number renames every asset below an inserted line,
 * so the next import inserts duplicates of them all instead of updating them.
 * 912 of the 4,091 rows in the sample workbook carry no Sheet ID and used to
 * fall back to exactly that.
 *
 * Sheet ID wins when the template supplies one (it is unique across the sample).
 * Otherwise the key is the row's Uniformat classification plus its asset name,
 * which survives re-ordering, plus an occurrence number so a building that
 * genuinely lists the same component twice keeps two distinct assets.
 */
function importKeyFor(record, occurrences) {
  if (record.sheetId) return String(record.sheetId)
  const parts = [
    record.siteId,
    record.level1,
    record.level2,
    record.level3,
    record.level3Component,
    record.componentNo,
    record.assetName,
  ].map((value) => String(value ?? '').trim().replace(/\s+/g, ' '))
  const base = parts.join('|')
  const seen = (occurrences.get(base) ?? 0) + 1
  occurrences.set(base, seen)
  return seen === 1 ? base : `${base}#${seen}`
}

/**
 * @param {object} workbook a SheetJS workbook (XLSX.read/readFile output).
 * @returns {{ baseYear, buildings, rows, missingColumns, errors, warnings }}
 */
function parseBcaWorkbook(workbook) {
  const errors = []
  const warnings = []
  const missingColumns = []
  const sheet = workbook?.Sheets?.Worksheet
  if (!sheet) {
    return {
      baseYear: null,
      buildings: [],
      rows: [],
      missingColumns: [],
      errors: [{ code: 'missing_sheet', message: 'The workbook has no "Worksheet" sheet.' }],
      warnings: [],
    }
  }

  // Validate the template: each field's header must appear at its column.
  const headerByLetter = new Map()
  for (const field of FIELD_COLUMNS) {
    const header = normalizeHeader(cellAt(sheet, field.letter, HEADER_ROW)?.v)
    headerByLetter.set(field.letter, header)
    if (!header.includes(normalizeHeader(field.header))) {
      missingColumns.push({ column: field.letter, expected: field.header, found: header || '(empty)' })
      if (field.required) {
        errors.push({
          code: 'missing_column',
          message: `Required column ${field.letter} ("${field.header}") is missing or renamed (found "${header || 'empty'}").`,
        })
      }
    }
  }

  const legend = parseLegend(workbook)
  const range = decodeRange(sheet['!ref'])
  const lastRow = range ? range.endRow : HEADER_ROW
  // Seeded from the asset rows, not from the legend: the legend also holds
  // reference tables whose labels are not sites, and a site listed there with no
  // asset rows never becomes a building anyway.
  const buildings = new Map()
  const rows = []
  const keyOccurrences = new Map()
  let skipped = 0

  for (let row = HEADER_ROW + 1; row <= lastRow; row += 1) {
    // A real asset row has an Asset Name and a Site ID. Subtotal ("Total
    // <building>") rows, blank rows, and template rows whose broken formulas
    // read as #REF! carry no usable asset name and are skipped.
    const assetName = textValue(cellAt(sheet, 'J', row))
    const siteId = textValue(cellAt(sheet, 'C', row))
    if (!assetName || /^total\b/i.test(assetName) || !siteId) {
      skipped += 1
      continue
    }

    const record = { row }
    for (const field of FIELD_COLUMNS) {
      const cell = cellAt(sheet, field.letter, row)
      if (isErrorCell(cell)) {
        // Only report formula errors in the fields we actually import.
        if (field.key !== 'componentNo' && field.key !== 'sheetId') {
          errors.push({
            code: 'formula_error',
            row,
            column: field.letter,
            value: cell.w ?? '#ERR',
            message: `Formula error ${cell.w ?? ''} in ${field.header} (row ${row}).`,
          })
        }
        record[field.key] = null
        continue
      }
      record[field.key] = field.money
        ? moneyValue(cell)
        : field.numeric
          ? numericValue(cell)
          : textValue(cell)
    }

    record.siteId = String(siteId)
    record.importKey = importKeyFor(record, keyOccurrences)
    if (!buildings.has(record.siteId)) {
      // The legend names a site and gives it a location factor; the asset rows
      // name it too, which is the only name a site missing from the legend has.
      const meta = legend.buildings.get(record.siteId)
      buildings.set(record.siteId, {
        siteId: record.siteId,
        name: meta?.name || record.buildingName || `Site ${record.siteId}`,
        locationFactor: meta?.locationFactor ?? null,
      })
    }
    rows.push(record)
  }

  return {
    baseYear: legend.baseYear,
    buildings: [...buildings.values()],
    rows,
    missingColumns,
    errors,
    warnings,
    skipped,
  }
}

// Minimal A1 range decode (avoids depending on the xlsx utils shape here).
function decodeRange(ref) {
  if (!ref) return null
  const match = /^[A-Z]+\d+:([A-Z]+)(\d+)$/.exec(ref)
  if (!match) return null
  return { endRow: Number(match[2]) }
}

module.exports = { parseBcaWorkbook, importKeyFor, FIELD_COLUMNS }
