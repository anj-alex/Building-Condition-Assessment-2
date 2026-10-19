function parseCsv(text) {
  const rows = []
  let row = []
  let value = ''
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"'
        i += 1
      } else {
        quoted = !quoted
      }
    } else if (char === ',' && !quoted) {
      row.push(value)
      value = ''
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      row.push(value)
      rows.push(row)
      row = []
      value = ''
    } else {
      value += char
    }
  }

  if (value || row.length > 0) {
    row.push(value)
    rows.push(row)
  }

  return rows
}

function getRequiredCsvColumn(headers, name, sourceName = 'CSV') {
  const index = headers.indexOf(name)
  if (index === -1) {
    throw new Error(`${sourceName} is missing required column: ${name}`)
  }
  return index
}

function cleanCsvValue(value) {
  const cleaned = String(value ?? '').trim()
  return cleaned || null
}

function csvInteger(value) {
  const cleaned = cleanCsvValue(value)
  if (cleaned == null) return null
  const parsed = Number(cleaned)
  return Number.isInteger(parsed) ? parsed : null
}

/**
 * Parse the Uniformat catalogue from CSV text.
 *
 * Separate from the path-taking reader so tests (and any caller that already
 * has the bytes) cannot drift from `readUniformatPricingRows`.
 */
function parseUniformatPricingRows(csvText) {
  const rows = parseCsv(String(csvText))
  const headerIndex = rows.findIndex((row) => row.includes('Uni-Format Pricing ID'))
  if (headerIndex === -1) {
    throw new Error('uniformat_pricing.csv does not contain a Uni-Format Pricing ID header row')
  }

  const headers = rows[headerIndex].map((header) => String(header ?? '').trim())
  const col = (name) => getRequiredCsvColumn(headers, name, 'uniformat_pricing.csv')
  const columns = {
    pricing_id: col('Uni-Format Pricing ID'),
    level_1_code: col('Level 1'),
    level_1_description: col('Level 1 Description'),
    level_2_code: col('Level 2'),
    level_2_description: col('Level 2 Description'),
    level_3_code: col('Level 3'),
    level_3_description: col('Level 3 Description'),
    level_4_code: col('Level 4'),
    level_4_description: col('Level 4 Description'),
    material: col('Material'),
    mean_service_life: col('Mean Service Life (yrs)'),
    practical_life: col('Practical Life (yrs)'),
    unit_price: col('Unit Price'),
    unit_of_measure: col('Unit of Measure'),
  }

  const records = rows.slice(headerIndex + 1).flatMap((row, index) => {
    const pricing_id = cleanCsvValue(row[columns.pricing_id])
    if (pricing_id == null) return []
    const record = {
      source_row: headerIndex + index + 2,
      pricing_id,
      level_1_code: cleanCsvValue(row[columns.level_1_code]),
      level_1_description: cleanCsvValue(row[columns.level_1_description]),
      level_2_code: cleanCsvValue(row[columns.level_2_code]),
      level_2_description: cleanCsvValue(row[columns.level_2_description]),
      level_3_code: cleanCsvValue(row[columns.level_3_code]),
      level_3_description: cleanCsvValue(row[columns.level_3_description]),
      level_4_code: cleanCsvValue(row[columns.level_4_code]),
      level_4_description: cleanCsvValue(row[columns.level_4_description]),
      material: cleanCsvValue(row[columns.material]),
      mean_service_life: csvInteger(row[columns.mean_service_life]),
      practical_life: csvInteger(row[columns.practical_life]),
      unit_price: cleanCsvValue(row[columns.unit_price]),
      unit_of_measure: cleanCsvValue(row[columns.unit_of_measure]),
    }
    for (const required of [
      'level_1_code',
      'level_1_description',
      'level_2_code',
      'level_2_description',
      'level_3_code',
      'level_3_description',
      'level_4_code',
      'level_4_description',
    ]) {
      if (record[required] == null) {
        throw new Error(`uniformat_pricing.csv row ${record.source_row} is missing ${required}`)
      }
    }
    return [record]
  })

  if (records.length === 0) {
    throw new Error('uniformat_pricing.csv contains no pricing records')
  }
  const sourceRowById = new Map()
  for (const record of records) {
    if (sourceRowById.has(record.pricing_id)) {
      throw new Error(
        `uniformat_pricing.csv has duplicate Uni-Format Pricing ID "${record.pricing_id}" ` +
          `on rows ${sourceRowById.get(record.pricing_id)} and ${record.source_row}`,
      )
    }
    sourceRowById.set(record.pricing_id, record.source_row)
  }
  return records
}

function readUniformatPricingRows(csvPath) {
  const fs = require('node:fs')
  return parseUniformatPricingRows(fs.readFileSync(csvPath, 'utf8'))
}

function csvNumber(value) {
  const cleaned = cleanCsvValue(value)
  if (cleaned == null) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Parse location factors from CSV text.
 *
 * Separate from the path-taking reader so `db.js` (which caches parsed rows)
 * and tests cannot drift from `readLocationFactorRows`.
 */
function parseLocationFactorRows(csvText) {
  const rows = parseCsv(String(csvText))
  const headerIndex = rows.findIndex((row) => row.includes('province') && row.includes('city'))
  if (headerIndex === -1) {
    throw new Error('location_factors.csv does not contain a province/city header row')
  }
  const headers = rows[headerIndex].map((header) => String(header ?? '').trim())
  const columns = {
    province: getRequiredCsvColumn(headers, 'province', 'location_factors.csv'),
    city: getRequiredCsvColumn(headers, 'city', 'location_factors.csv'),
    material_index: getRequiredCsvColumn(headers, 'material_index', 'location_factors.csv'),
    installation_index: getRequiredCsvColumn(headers, 'installation_index', 'location_factors.csv'),
    total_index: getRequiredCsvColumn(headers, 'total_index', 'location_factors.csv'),
    factor: getRequiredCsvColumn(headers, 'factor', 'location_factors.csv'),
  }
  return rows.slice(headerIndex + 1).flatMap((row, index) => {
    const province = cleanCsvValue(row[columns.province])
    const city = cleanCsvValue(row[columns.city])
    if (province == null || city == null) return []
    const factor = csvNumber(row[columns.factor])
    if (factor == null) {
      throw new Error(`location_factors.csv row ${headerIndex + index + 2} has invalid factor`)
    }
    return [
      {
        province,
        city,
        material_index: csvNumber(row[columns.material_index]),
        installation_index: csvNumber(row[columns.installation_index]),
        total_index: csvNumber(row[columns.total_index]),
        factor,
        label: `${city}, ${province}`,
      },
    ]
  })
}

function readLocationFactorRows(csvPath) {
  const fs = require('node:fs')
  return parseLocationFactorRows(fs.readFileSync(csvPath, 'utf8'))
}

module.exports = {
  parseCsv,
  getRequiredCsvColumn,
  cleanCsvValue,
  csvInteger,
  csvNumber,
  parseLocationFactorRows,
  parseUniformatPricingRows,
  readUniformatPricingRows,
  readLocationFactorRows,
}
