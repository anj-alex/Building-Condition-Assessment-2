const assert = require('node:assert/strict')
const test = require('node:test')

// The instrumented module itself — the same code the main process and renderer
// run. jsdom cannot supply a real 2D canvas context or layout box, so the arrow
// path (which needs both) is driven through a minimal fake element instead, with
// `document` briefly bound to it only for the duration of each render call.
const photoAnnotations = require('../src/lib/annotations')

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.className = ''
    this.style = {}
    this.clientWidth = 0
    this.clientHeight = 0
    this.offsetWidth = 0
    this.offsetHeight = 0
    this.width = 0
    this.height = 0
  }

  appendChild(child) {
    this.children.push(child)
    return child
  }

  getContext(kind) {
    if (this.tagName !== 'CANVAS' || kind !== '2d') return null
    const operations = []
    const context = {
      operations,
      beginPath: () => operations.push(['beginPath']),
      moveTo: (...args) => operations.push(['moveTo', ...args]),
      lineTo: (...args) => operations.push(['lineTo', ...args]),
      stroke: () => operations.push(['stroke']),
      closePath: () => operations.push(['closePath']),
      fill: () => operations.push(['fill']),
    }
    this._context = context
    return context
  }
}

function annotationRenderer() {
  const contexts = []
  const fakeDocument = { createElement: (tagName) => new FakeElement(tagName) }

  return {
    contexts,
    createLayer(width, height) {
      const layer = new FakeElement('div')
      layer.clientWidth = width
      layer.clientHeight = height
      return layer
    },
    // Bind the global `document` the module reads only while it renders, so no
    // other test in this process observes it.
    render(layer, annotations, opts) {
      const previous = global.document
      global.document = fakeDocument
      try {
        const result = photoAnnotations.renderAnnotationElements(layer, annotations, opts)
        for (const child of layer.children) {
          if (child._context) contexts.push(child._context)
        }
        return result
      } finally {
        global.document = previous
      }
    },
  }
}

test('photo annotation boxes carry their selected color in a complete border declaration', () => {
  const { createLayer, render } = annotationRenderer()
  const layer = createLayer(400, 200)

  render(
    layer,
    [{ kind: 'box', x: 0.1, y: 0.2, w: 0.3, h: 0.4, color: '#2f9e44' }],
    { boxClass: 'report-photo-box', boxBorderWidth: '1.5pt' },
  )

  assert.equal(layer.children.length, 1)
  const box = layer.children[0]
  assert.equal(box.tagName, 'DIV')
  assert.equal(box.className, 'report-photo-box')
  assert.equal(box.style.border, '1.5pt solid #2f9e44')
  assert.equal(box.style.borderColor, '#2f9e44')
  assert.equal(box.style.left, '10%')
  assert.equal(box.style.top, '20%')
  assert.equal(box.style.width, '30%')
  assert.equal(box.style.height, '40%')
})

test('photo annotation arrows are painted to a print-safe canvas in their selected color', () => {
  const { contexts, createLayer, render } = annotationRenderer()
  const layer = createLayer(400, 200)

  render(
    layer,
    [{ kind: 'arrow', x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.7, color: '#228be6' }],
    { arrowClass: 'report-photo-arrows' },
  )

  assert.equal(layer.children.length, 1)
  const canvas = layer.children[0]
  assert.equal(canvas.tagName, 'CANVAS')
  assert.equal(canvas.className, 'report-photo-arrows')
  assert.equal(canvas.width, 800)
  assert.equal(canvas.height, 400)
  assert.equal(
    canvas.style.cssText,
    'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none',
  )

  assert.equal(contexts.length, 1)
  const [context] = contexts
  assert.equal(context.strokeStyle, '#228be6')
  assert.equal(context.fillStyle, '#228be6')
  assert.ok(context.lineWidth >= 4)
  assert.ok(context.operations.some(([operation]) => operation === 'stroke'))
  assert.ok(context.operations.some(([operation]) => operation === 'fill'))
})

test('nothing is drawn that the database would refuse to store', () => {
  const { createLayer, render } = annotationRenderer()
  const layer = createLayer(400, 200)

  render(layer, [
    { kind: 'arrow' }, // no coordinates at all
    { kind: 'arrow', x1: 0.5, y1: 0.5, x2: 0.502, y2: 0.5 }, // shorter than a stray click
    { kind: 'box', x: 0.1, y: 0.1, w: 0, h: 0.4 }, // zero width
    { kind: 'box', x: 'left', y: 0.1, w: 0.2, h: 0.4 }, // unparseable
  ])

  assert.equal(layer.children.length, 0)
})

test('the draw path and the storage path accept exactly the same shapes', () => {
  const candidates = [
    { kind: 'box', x: 0.1, y: 0.1, w: 0.2, h: 0.2, color: '#2f9e44' },
    { x: 0.3, y: 0.3, w: 0.1, h: 0.1 }, // legacy box: no kind, no color
    { kind: 'arrow', x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9, color: '#ABC' },
    { kind: 'arrow', x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5 }, // zero length
    { kind: 'box', x: 0.1, y: 0.1, w: 0.2, h: 0 },
    null,
    'not a shape',
  ]

  const drawn = photoAnnotations.sanitizeAnnotations(candidates)
  const stored = photoAnnotations.parseAnnotationsJson(JSON.stringify(candidates))
  assert.deepEqual(drawn, stored)
  assert.equal(drawn.length, 3)

  // The renderer's per-item predicates classify the same set the same way.
  const byPredicate = candidates.filter(
    (item) =>
      photoAnnotations.isAnnotationBox(item) || photoAnnotations.isAnnotationArrow(item),
  )
  assert.equal(byPredicate.length, drawn.length)
  assert.equal(byPredicate.filter(photoAnnotations.isAnnotationBox).length, 2)
  assert.equal(byPredicate.filter(photoAnnotations.isAnnotationArrow).length, 1)
})

test('stored annotations are normalized: kind, default color, short hex, clamped fractions', () => {
  const [box, arrow] = photoAnnotations.sanitizeAnnotations([
    { x: -0.5, y: 0.2, w: 2, h: 0.4 },
    { kind: 'arrow', x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.7, color: '#ABC' },
  ])

  assert.deepEqual(box, {
    kind: 'box',
    x: 0,
    y: 0.2,
    w: 1,
    h: 0.4,
    color: photoAnnotations.DEFAULT_ANNOTATION_COLOR,
  })
  assert.equal(arrow.color, '#aabbcc')
})

test('unusable stored JSON degrades to an empty list', () => {
  assert.deepEqual(photoAnnotations.parseAnnotationsJson(null), [])
  assert.deepEqual(photoAnnotations.parseAnnotationsJson(''), [])
  assert.deepEqual(photoAnnotations.parseAnnotationsJson('{not json'), [])
  assert.deepEqual(photoAnnotations.parseAnnotationsJson('{"kind":"box"}'), [])
})
