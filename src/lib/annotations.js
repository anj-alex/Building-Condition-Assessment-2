// Wrapped in an IIFE so nothing leaks into the renderer's global scope. Loaded as a
// classic <script>, top-level declarations here would otherwise collide with same-named
// declarations in renderer.js / property-report.js and break parsing of the whole file.
;(function () {
/**
 * One definition of what a photo annotation is, shared across the process
 * boundary: the renderer draws these, `src/db.js` stores them. Both sides route
 * every accept/reject decision through `sanitizeAnnotation`, so the renderer
 * cannot draw a shape the database would silently drop on save.
 *
 * Boxes:  { kind:'box',   x, y, w, h,      color }
 * Arrows: { kind:'arrow', x1, y1, x2, y2,  color }
 *
 * Coordinates are fractions (0..1) of the full picture, authored in the home
 * gallery and replayed over report photos. Legacy stored items omit `kind` and
 * `color`; they read as boxes in the default colour.
 */

/** Default stroke for photo annotations (boxes + arrows). */
const DEFAULT_ANNOTATION_COLOR = '#ff2d2d'

/** Arrows shorter than this fraction of the picture are stray clicks, not shapes. */
const MIN_ARROW_LENGTH = 0.01

function normalizeAnnotationColor(color) {
  if (typeof color !== 'string') return null
  const s = color.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase()
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const r = s[1]
    const g = s[2]
    const b = s[3]
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  return null
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value)))
}

function allFinite(values) {
  return values.every((value) => Number.isFinite(Number(value)))
}

/**
 * Normalize one raw annotation into its stored form, or null when it is not a
 * usable shape. Every other check here defers to this function.
 * @returns {object|null}
 */
function sanitizeAnnotation(item) {
  if (!item || typeof item !== 'object') return null
  const color = normalizeAnnotationColor(item.color) || DEFAULT_ANNOTATION_COLOR

  if (item.kind === 'arrow') {
    if (!allFinite([item.x1, item.y1, item.x2, item.y2])) return null
    const arrow = {
      kind: 'arrow',
      x1: clamp01(item.x1),
      y1: clamp01(item.y1),
      x2: clamp01(item.x2),
      y2: clamp01(item.y2),
      color,
    }
    if (Math.hypot(arrow.x2 - arrow.x1, arrow.y2 - arrow.y1) < MIN_ARROW_LENGTH) return null
    return arrow
  }

  if (!allFinite([item.x, item.y, item.w, item.h])) return null
  const box = {
    kind: 'box',
    x: clamp01(item.x),
    y: clamp01(item.y),
    w: clamp01(item.w),
    h: clamp01(item.h),
    color,
  }
  if (box.w <= 0 || box.h <= 0) return null
  return box
}

/**
 * Sanitized copy of an annotation list; unusable entries are dropped.
 * @returns {object[]}
 */
function sanitizeAnnotations(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    const shape = sanitizeAnnotation(item)
    if (shape) out.push(shape)
  }
  return out
}

/**
 * Parse a stored `bounding_boxes` JSON column. Invalid values degrade to [].
 * @returns {object[]}
 */
function parseAnnotationsJson(raw) {
  if (!raw) return []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  return sanitizeAnnotations(parsed)
}

function isAnnotationBox(item) {
  return sanitizeAnnotation(item)?.kind === 'box'
}

function isAnnotationArrow(item) {
  return sanitizeAnnotation(item)?.kind === 'arrow'
}

/**
 * Append box/arrow annotation elements into an overlay sized to the picture.
 * Boxes use bordered divs; arrows are drawn on a canvas, which rasterises
 * identically wherever the overlay is captured (SVG strokes do not).
 * @param {HTMLElement} layer
 * @param {object[]|null|undefined} annotations
 * @param {{boxClass?:string, arrowClass?:string, boxBorderWidth?:string}} [opts]
 */
function renderAnnotationElements(layer, annotations, opts = {}) {
  const boxClass = opts.boxClass || 'home-asset-image-box'
  const arrowClass = opts.arrowClass || 'home-asset-image-arrow'
  const boxBorderWidth = opts.boxBorderWidth || '2px'
  // Draw exactly what would be stored — no shape appears that a save would drop.
  const list = sanitizeAnnotations(annotations)
  const boxes = list.filter((item) => item.kind === 'box')
  const arrows = list.filter((item) => item.kind === 'arrow')

  for (const box of boxes) {
    const el = document.createElement('div')
    el.className = boxClass
    el.style.left = `${box.x * 100}%`
    el.style.top = `${box.y * 100}%`
    el.style.width = `${box.w * 100}%`
    el.style.height = `${box.h * 100}%`
    // Full border shorthand keeps the chosen colour (borderColor alone is unreliable).
    el.style.border = `${boxBorderWidth} solid ${box.color}`
    el.style.borderColor = box.color
    layer.appendChild(el)
  }

  if (arrows.length === 0) return

  // Prefer real layout size; fall back so draft hosts still paint something.
  const cssW = layer.clientWidth || layer.offsetWidth || 0
  const cssH = layer.clientHeight || layer.offsetHeight || 0
  if (cssW < 2 || cssH < 2) return

  // Draw at 2× for sharper print; CSS size stays 100% of the overlay.
  const scale = 2
  const w = Math.max(2, Math.round(cssW * scale))
  const h = Math.max(2, Math.round(cssH * scale))
  const canvas = document.createElement('canvas')
  canvas.className = arrowClass
  canvas.width = w
  canvas.height = h
  canvas.style.cssText =
    'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none'
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    layer.appendChild(canvas)
    return
  }

  const strokeW = Math.max(2 * scale, Math.min(w, h) * 0.008)
  const headLen = Math.max(8 * scale, Math.min(w, h) * 0.028)

  for (const arrow of arrows) {
    const color = arrow.color
    const x1 = arrow.x1 * w
    const y1 = arrow.y1 * h
    const x2 = arrow.x2 * w
    const y2 = arrow.y2 * h
    const angle = Math.atan2(y2 - y1, x2 - x1)
    const shorten = headLen * 0.85

    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = strokeW
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2 - shorten * Math.cos(angle), y2 - shorten * Math.sin(angle))
    ctx.stroke()

    const headAngle = Math.PI / 7
    const ax = x2 - headLen * Math.cos(angle - headAngle)
    const ay = y2 - headLen * Math.sin(angle - headAngle)
    const bx = x2 - headLen * Math.cos(angle + headAngle)
    const by = y2 - headLen * Math.sin(angle + headAngle)
    ctx.beginPath()
    ctx.moveTo(x2, y2)
    ctx.lineTo(ax, ay)
    ctx.lineTo(bx, by)
    ctx.closePath()
    ctx.fill()
  }
  layer.appendChild(canvas)
}

const photoAnnotations = {
  DEFAULT_ANNOTATION_COLOR,
  MIN_ARROW_LENGTH,
  isAnnotationArrow,
  isAnnotationBox,
  normalizeAnnotationColor,
  parseAnnotationsJson,
  renderAnnotationElements,
  sanitizeAnnotation,
  sanitizeAnnotations,
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = photoAnnotations
} else if (typeof window !== 'undefined') {
  window.photoAnnotations = photoAnnotations
}
})()
