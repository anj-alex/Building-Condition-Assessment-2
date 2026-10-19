'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { matchPhotoReferences } = require('../src/lib/photo-filename-matcher')
test('matches case-insensitive Windows and POSIX filenames', () => {
  const result = matchPhotoReferences([{ photo_filename: 'C:\\photos\\ROOF01.JPG; wall.png' }], ['/tmp/roof01.jpg', '/tmp/wall.png'])
  assert.deepEqual(result[0].matches.map(x => x.status), ['matched', 'matched'])
})
test('reports missing and ambiguous names without silently selecting a file', () => {
  const result = matchPhotoReferences([{ photo_filename: 'roof.jpg, absent.jpg' }], ['/a/roof.jpg', '/b/ROOF.JPG'])
  assert.deepEqual(result[0].matches.map(x => x.status), ['ambiguous', 'missing'])
  assert.equal(result[0].matches[0].filePath, null)
})
test('ignores unsupported files and empty references', () => {
  assert.equal(matchPhotoReferences([{ photo_filename: 'notes.pdf' }], ['/a/notes.pdf'])[0].matches[0].status, 'missing')
  assert.deepEqual(matchPhotoReferences([{}], [])[0].matches, [])
})
