// Shared definition of whether an asset carries property-specific assessment
// data — the single rule that decides whether an asset gets a page in the
// report.
//
// The distinction that matters is **master-library row vs. assessed component**.
// A BCA workbook (and the app's own "add asset" button) seeds a building with
// the full Uniformat component library: every row already has a name, a
// Uniformat class, a catalogue reference cost, a template vintage and a service
// life before anyone has visited the site. None of that says anything about
// *this* property. Only an assessor's own findings do.
//
// So a field counts here only when it cannot have been filled in by the
// template. That rules out the identity/catalogue fields (`asset_name` on an
// imported row, `uniformat_pricing_id`, `vintage`, `service_life`,
// `unit_cost_override`) no matter how populated they look. See
// docs/property-report.md.
//
// Wrapped in an IIFE so it can be loaded as a classic <script> (publishing
// `window.assetCompleteness`) without leaking top-level names into the shared
// page scope, while `module.exports` serves the main process.
;(function () {
  // Text a template writes to mean "nothing recorded here". The client's
  // workbook fills its General State of Repair column with "-" on every
  // un-inspected row (3,532 of 4,091 in the sample), so treating these as
  // content would readmit the whole master library through the description
  // field alone.
  const PLACEHOLDER_TEXT = new Set([
    '-',
    '--',
    '---',
    '.',
    'n/a',
    'n.a.',
    'na',
    'none',
    'nil',
    'tbd',
    'tba',
    'unknown',
    '?',
  ])

  // Assessor findings. Every one of these is something a person decided about
  // this specific component; none is prefilled by createAsset or carried in on
  // a master-library workbook row.
  const ASSESSED_TEXT_FIELDS = [
    'condition_rating',
    'description',
    'recommendation',
    'action',
    'priority',
    'conservation_lens',
  ]
  // Measured or estimated on site. All must be positive: a quantity of 0 is the
  // template saying the component is not present, which is the opposite of an
  // assessment.
  const ASSESSED_NUMBER_FIELDS = [
    'quantity',
    'opinion_of_probable_cost',
    'action_year',
    'allowance_interval_years',
  ]

  function hasText(value) {
    const text = String(value ?? '').trim()
    if (!text) return false
    return !PLACEHOLDER_TEXT.has(text.toLowerCase())
  }

  function hasPositiveNumber(value) {
    if (value == null || value === '') return false
    const number = Number(value)
    return Number.isFinite(number) && number > 0
  }

  function assetPhotoCount(asset, images) {
    if (Array.isArray(images)) return images.length
    if (Array.isArray(asset?.images)) return asset.images.length
    if (hasPositiveNumber(asset?.photo_count)) return Number(asset.photo_count)
    return 0
  }

  /**
   * True when this asset came in on a workbook row rather than being created in
   * the app. Import writes a stable `import_key` on every row it inserts.
   */
  function isImportedAsset(asset) {
    return hasText(asset?.import_key)
  }

  /**
   * True when the assessor has recorded something real about this component.
   *
   * `images` may be passed explicitly, or carried on `asset.images` /
   * `asset.photo_count`.
   */
  function isAssetAssessed(asset, images) {
    if (!asset) return false
    // Naming an asset is assessor input only when the assessor did the naming.
    // An imported row's name is the master library's, and every row has one.
    if (!isImportedAsset(asset) && hasText(asset.asset_name)) return true
    if (ASSESSED_TEXT_FIELDS.some((field) => hasText(asset[field]))) return true
    if (ASSESSED_NUMBER_FIELDS.some((field) => hasPositiveNumber(asset[field]))) return true
    // A life adjustment is only ever entered by hand against one component.
    if (Number.isFinite(Number(asset.life_adjustment_years)) && Number(asset.life_adjustment_years) !== 0) {
      return true
    }
    return assetPhotoCount(asset, images) > 0
  }

  /**
   * Whether this asset appears in the final report at all. Assessed assets
   * always do; a master-library row only if the user explicitly opted it in via
   * the "Include in report as Not Assessed" flag.
   */
  function includeAssetInReport(asset, images) {
    return isAssetAssessed(asset, images) || Boolean(Number(asset?.include_as_not_assessed))
  }

  const assetCompleteness = {
    isAssetAssessed,
    includeAssetInReport,
    isImportedAsset,
    assetPhotoCount,
    hasText,
    PLACEHOLDER_TEXT,
    ASSESSED_TEXT_FIELDS,
    ASSESSED_NUMBER_FIELDS,
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = assetCompleteness
  } else if (typeof window !== 'undefined') {
    window.assetCompleteness = assetCompleteness
  }
})()
