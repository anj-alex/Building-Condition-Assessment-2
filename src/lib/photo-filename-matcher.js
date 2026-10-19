'use strict'
// Safe, deterministic matching of workbook photo references to imported files.
// No database writes: callers must confirm matches before attaching photos.
const path = require('node:path')
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.tif', '.tiff'])
function normalize(value) {
  if (value == null) return ''
  const base = String(value).trim().replace(/\\/g, '/').split('/').pop()
  return base.normalize('NFKC').trim().toLowerCase()
}
function references(value) {
  if (Array.isArray(value)) return value.flatMap(references)
  return String(value ?? '').split(/[;,\n\r|]+/).map(s => s.trim()).filter(Boolean)
}
function matchPhotoReferences(rows, files, { column = 'photo_filename' } = {}) {
  const lookup = new Map()
  for (const file of files) {
    const filePath = typeof file === 'string' ? file : file?.path
    if (!filePath) continue
    const name = normalize(filePath)
    if (!IMAGE_EXTENSIONS.has(path.extname(name))) continue
    if (!lookup.has(name)) lookup.set(name, [])
    lookup.get(name).push(filePath)
  }
  return rows.map((row, rowIndex) => ({
    rowIndex,
    matches: references(row[column]).map(reference => {
      const name = normalize(reference)
      const candidates = lookup.get(name) || []
      return {
        reference,
        status: candidates.length === 1 ? 'matched' : candidates.length > 1 ? 'ambiguous' : 'missing',
        filePath: candidates.length === 1 ? candidates[0] : null,
        candidates: [...candidates],
      }
    }),
  }))
}
module.exports = { matchPhotoReferences, normalize, references }
