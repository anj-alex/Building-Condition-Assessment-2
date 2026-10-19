const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.join(__dirname, '..')
const pagesDirectory = path.join(repoRoot, 'pages')

/**
 * `hidden` is an attribute, not a display mode: the browser hides it with a UA
 * rule of the lowest possible precedence, so ANY author rule that sets `display`
 * on the element wins and it stays on screen — while `el.hidden` still reads
 * true and every unit test still passes.
 *
 * 1.6.1 shipped exactly that. `pages/property-report.html` is the one page that
 * does not load `styles/styles.css`, where the app-wide `[hidden]` rule lives,
 * and `.report-export-modal` sets `display: flex`. The export overlay therefore
 * covered the report page from the moment it opened and swallowed every click on
 * Back / Generate Word Report. It reached a client.
 *
 * These tests pin the two halves of the invariant: every page that uses `hidden`
 * loads a stylesheet that neutralises it, and no rule re-introduces a `display`
 * for an element that is toggled with `hidden`.
 */

/** Stylesheet hrefs a page loads, in document order, resolved to disk paths. */
function pageStylesheets(pageFile) {
  const html = fs.readFileSync(path.join(pagesDirectory, pageFile), 'utf8')
  return [...html.matchAll(/<link\b[^>]*\bhref="([^"]+\.css)"/g)]
    .map((match) => match[1])
    .filter((href) => !/^[a-z]+:|^\/\//i.test(href))
    .map((href) => path.join(pagesDirectory, href))
}

const pageFiles = fs.readdirSync(pagesDirectory).filter((file) => file.endsWith('.html'))

/** Does this stylesheet carry a bare `[hidden]` rule that sets `display: none`? */
function neutralisesHidden(cssPath) {
  if (!fs.existsSync(cssPath)) return false
  const css = fs.readFileSync(cssPath, 'utf8')
  return /(^|[\s,}])\[hidden\]\s*\{[^}]*display\s*:\s*none/m.test(css)
}

test('every page that uses hidden loads a stylesheet that neutralises it', () => {
  for (const pageFile of pageFiles) {
    const html = fs.readFileSync(path.join(pagesDirectory, pageFile), 'utf8')
    const usesHidden = /<[^>]+\shidden(\s|>|=)/.test(html)
    if (!usesHidden) continue
    const covered = pageStylesheets(pageFile).some(neutralisesHidden)
    assert.equal(
      covered,
      true,
      `${pageFile} uses the hidden attribute but loads no stylesheet with a ` +
        `[hidden] { display: none } rule — an author display rule would leave ` +
        `hidden elements on screen`,
    )
  }
})

test('no page leaves a hidden-toggled element with an overriding display rule', () => {
  for (const pageFile of pageFiles) {
    const sheets = pageStylesheets(pageFile)
    // A page whose stylesheets neutralise [hidden] with !important is safe by
    // construction; only unguarded pages need the per-selector check.
    const guarded = sheets.some((sheet) => {
      if (!fs.existsSync(sheet)) return false
      const css = fs.readFileSync(sheet, 'utf8')
      return /(^|[\s,}])\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/m.test(css)
    })
    assert.equal(
      guarded,
      true,
      `${pageFile} does not load a stylesheet with [hidden] { display: none !important }`,
    )
  }
})

test('the report export overlay is hidden by the report stylesheet', () => {
  // The specific regression, pinned by name so a refactor cannot quietly undo it.
  const css = fs.readFileSync(path.join(repoRoot, 'styles', 'property-report.css'), 'utf8')
  const hiddenRuleAt = css.search(/(^|[\s,}])\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/m)
  const overlayRuleAt = css.indexOf('.report-export-modal {')
  assert.notEqual(hiddenRuleAt, -1, 'property-report.css must neutralise [hidden]')
  assert.notEqual(overlayRuleAt, -1, 'property-report.css must still style the overlay')
  assert.equal(
    hiddenRuleAt < overlayRuleAt,
    true,
    'the [hidden] rule must come before .report-export-modal sets display: flex',
  )
})
