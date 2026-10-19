#!/usr/bin/env node
const path = require('node:path')
const { readUniformatPricingRows } = require('../src/lib/csv-utils')

function sqlValue(value) {
  if (value == null) return 'NULL'
  if (typeof value === 'number') return String(value)
  return `'${String(value).replaceAll("'", "''")}'`
}

const csvPath = process.argv[2] ?? path.join(__dirname, '..', 'data', 'uniformat_pricing.csv')
const records = readUniformatPricingRows(csvPath)

process.stdout.write('BEGIN;\n')
process.stdout.write('DROP TABLE IF EXISTS temp.current_uniformat_pricing_ids;\n')
process.stdout.write('CREATE TEMP TABLE current_uniformat_pricing_ids (pricing_id TEXT PRIMARY KEY);\n')
for (const record of records) {
  process.stdout.write(`INSERT OR IGNORE INTO current_uniformat_pricing_ids (pricing_id) VALUES (${sqlValue(record.pricing_id)});\n`)
  process.stdout.write(`INSERT INTO uniformat_pricing (pricing_id, level_1_code, level_1_description, level_2_code, level_2_description, level_3_code, level_3_description, level_4_code, level_4_description, material, mean_service_life, practical_life, unit_price, unit_of_measure) VALUES (${[
    record.pricing_id,
    record.level_1_code,
    record.level_1_description,
    record.level_2_code,
    record.level_2_description,
    record.level_3_code,
    record.level_3_description,
    record.level_4_code,
    record.level_4_description,
    record.material,
    record.mean_service_life,
    record.practical_life,
    record.unit_price,
    record.unit_of_measure,
  ].map(sqlValue).join(', ')}) ON CONFLICT(pricing_id) DO UPDATE SET level_1_code = excluded.level_1_code, level_1_description = excluded.level_1_description, level_2_code = excluded.level_2_code, level_2_description = excluded.level_2_description, level_3_code = excluded.level_3_code, level_3_description = excluded.level_3_description, level_4_code = excluded.level_4_code, level_4_description = excluded.level_4_description, material = excluded.material, mean_service_life = excluded.mean_service_life, practical_life = excluded.practical_life, unit_price = excluded.unit_price, unit_of_measure = excluded.unit_of_measure;\n`)
}
process.stdout.write(`DELETE FROM uniformat_pricing
WHERE NOT EXISTS (
  SELECT 1
  FROM current_uniformat_pricing_ids current
  WHERE current.pricing_id = uniformat_pricing.pricing_id
)
AND NOT EXISTS (
  SELECT 1
  FROM asset e
  WHERE e.uniformat_pricing_id = uniformat_pricing.pricing_id
);
DROP TABLE current_uniformat_pricing_ids;
`)
process.stdout.write('COMMIT;\n')
