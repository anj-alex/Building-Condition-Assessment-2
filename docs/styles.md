# Styles

The app UI supports a dark (default) and light theme via CSS custom properties.
The report screen is an app-themed shell around pages materialized from the
prepared DOCX. CSS is plain (no preprocessor) with one file per concern.

## Design direction

Professional AEC / civil-engineering product UI: cool slate surfaces, steel-blue accent, clear hierarchy, card-based panels, and restrained motion. Not playful — dense enough for field-office work, refined enough for client-facing firms.

## Theme system

All app-UI colors are CSS custom properties defined on `:root` (dark defaults) and overridden under `[data-theme="light"]`. The variable names are semantic (`--bg`, `--text`, `--border`, `--accent`, etc.), declared once at the top of `styles/styles.css`. Shared form CSS (`styles/project-setup.css`, `styles/building-info.css`, `styles/firm-setup.css`, `styles/settings.css`) consumes these same variables — they do not define their own color tokens.

Design tokens also include a tight radius scale (`--radius-xs` … `--radius-xl`, ~1–3px — industrial, not soft), elevation (`--shadow-xs` … `--shadow-lg`), an opaque three-pixel accent focus indicator (`--shadow-focus`) that remains distinct on both theme surfaces, motion (`--ease`, `--duration`), and type stacks (`--font-sans`, `--font-mono`).

`src/theme.js` is loaded (via `<script defer>`) on every page after `src/shared.js` and before the page-specific script. Preference is stored in `localStorage` key `app-theme` as one of `light`, `dark`, or `system` (default when missing). `getThemePreference` / `setThemePreference` / `resolveTheme` map that to an effective theme; `system` follows `prefers-color-scheme` and updates when the OS preference changes. Effective light sets `data-theme="light"` on `<html>`; dark removes the attribute. `localStorage` is shared across pages in the same origin.

The user selects Light / Dark / System on the **Settings** page (`pages/settings.html`) via a three-button segmented control (`role="radiogroup"`, each segment `role="radio"`) wired in `src/settings.js`.

The property report page (`styles/property-report.css`) is standalone and
defines `--preview-*` and `--toolbar-*` tokens for its sticky toolbar, review
panels, preview canvas, progress/error state, and save modal. The document
itself is styled by the OOXML generated in `src/docx-report.js` and interpreted
by `docx-preview`; there is no duplicate browser report theme to synchronize.
See [word-export](word-export.md#appearance).

## File map

| File | Scope |
|---|---|
| `styles/styles.css` | Theme variables (`:root` + `[data-theme="light"]`), global reset, home page layout, project/property lists, building detail, asset editor, image gallery, modals |
| `src/theme.js` | Preference helpers + applies resolved `data-theme` on every page; listens for OS scheme changes when preference is `system` |
| `src/shared.js` | Renderer utilities loaded on every page (`toFileUrl`, form helpers, navigation, `mapPricingUnitToUnitMeasure` / `displayUnitMeasure`) |
| `styles/project-setup.css` | Shared form shell (`.setup-shell`, `.setup-form`, `.setup-section` cards, `.field`, `.btn-primary`, `.btn-secondary`, `.btn-back-fixed`) used by project, firm, building, settings, and executive-summary pages |
| `styles/settings.css` | Settings page theme segmented control and Uniformat status card |
| `styles/building-info.css` | Two-column field rows, property photo grid, autosave status, responsive breakpoints |
| `styles/firm-setup.css` | Logo field layout and preview |
| `styles/property-report.css` | Standalone report shell: toolbar, quality review, preparation/error state, DOCX-viewer canvas overrides, and save modal |

## Dark app theme (`styles/styles.css`)

- `color-scheme: dark`, background `#0c1017` with a faint radial cool-blue wash.
- System UI font stack (`--font-sans`).
- Accent steel blue `#5d9cd4` for focus rings, selected states, primary buttons, and tab underlines.
- Surfaces use cool slate elevation steps (`--bg-elevated`, `--bg-elevated-2`, …) with subtle borders and soft shadows.
- Home layout: centered sidebar (max-width ~44rem) of card panels that expands to full width with a framed detail panel when a building is selected (`.home-main.has-building-selection`).
- Asset form: a 20-column CSS grid (`grid-template-columns: repeat(20, minmax(0, 1fr))`) with field spans controlling layout — primary span 12, compact span 4, uniformat span 5, fifth span 4, wide span 10. The full-width calculation panel uses four columns, then two below the tablet breakpoint and one below 640px.
- Tabs (`.home-detail-tab`): underline style; active tab uses bottom border accent and soft fill.
- Primary actions use `.home-action-btn--primary` (or `.btn-primary` on form pages); danger styles win when combined with sizing helpers.
- Image gallery: fixed overlay with blur, centered dialog, prev/next nav buttons.
- `.home-modal` / `.home-modal-dialog`: reusable centered modal on an elevated surface, with `.home-modal-list` scrolling its checkbox rows. Used by the project report building picker. The full-screen blurred scrim is declared once as `.home-image-gallery, .home-modal` — a new overlay joins that selector instead of repeating the block.
- `.home-action-btn:disabled` dims to 50% and drops its shadow; `.home-panel-header-actions` wraps multiple panel-header buttons.

## Light app theme

- Background `#e8edf3`, elevated surfaces pure white, accent `#1d6bb5`.
- Softer cool shadows; same component structure as dark.

## Settings appearance (`styles/settings.css`)

`.theme-segmented` is a horizontal three-button control (Light / Dark / System). Selected segment uses `.is-selected` with elevated surface treatment. Uniformat status shows file label + path beside **Choose CSV…**.

## Form shell (`styles/project-setup.css`)

Shared by project-setup, firm-setup, building-info, settings, and executive-summary pages. `body.page-scrollable-form` switches from the centered home layout to a top-aligned scrollable form. `.setup-shell` is a centered `max-width: 34rem` container (overridden larger for building/firm/settings/executive summary). Each `.setup-section` is a card (elevated background, border, radius, shadow). `.setup-section-title` is uppercase tracked muted labels. `.btn-primary` is solid accent with light text; `.btn-secondary` is neutral elevated. `.btn-back-fixed` pins the Back button to the top-left corner. Executive summary fields use `.field-header` (label + `.btn-ai-generate`) and `.field-ai-status` for generation feedback.

## Building info (`styles/building-info.css`)

Form pages use `.form-autosave-status` in the actions bar (no primary Save button); styles live in `project-setup.css` (shared by building/project/firm/executive summary).

`.field-row` is a two-column grid (`minmax(0, 1fr) minmax(0, 1fr)`). `minmax(0, 1fr)` lets tracks shrink past long label min-content. Responsive: pairs collapse to one column under 480px. Property photos use `grid-template-columns: repeat(auto-fill, minmax(7.25rem, 1fr))` with 4:3 aspect-ratio thumbnails.

## Property report (`styles/property-report.css`)

The body is a dark slate viewing canvas (light slate under the light app theme),
so white Word pages remain visually distinct. Toolbar and shell controls use
the app's steel-blue action hierarchy; **Save Word Report…** is the primary
action.

- `.report-preview-badge` and `.report-preview-note` explicitly label the view
  as Word-derived and explain Word's pagination/live-field authority. The stale
  note changes to an amber state while AI updates are pending.
- `.report-review` is the screen-only quality gate. Severity badges, the error
  block, and **Export anyway** remain outside the DOCX pages.
- `.report-preview-state` supplies preparation, failure, and retry states. Its
  spinner and the save progress bar stop animating under
  `prefers-reduced-motion`.
- `.report-root .car-word-preview-wrapper` only provides canvas padding,
  horizontal overflow, page spacing, and shadows. Page size, margins, document
  typography, tables, headers, and footers come from `docx-preview`'s generated
  rules for the actual OOXML.
- `.report-export-modal` is the short save/write takeover. The expensive DOCX
  build is represented by the in-page preparation state instead.

There is no `@page` or browser-print report contract. Microsoft Word owns final
pagination.

## `hidden` needs a rule, on every page

`hidden` is an attribute, not a display mode. The browser hides it with a UA
stylesheet rule of the lowest possible precedence, so **any** author rule setting
`display` on that element wins and it stays on screen — while `el.hidden` still
reads `true` and every unit test still passes.

`styles/styles.css` therefore carries `[hidden] { display: none !important }`,
and `styles/property-report.css` repeats it because `pages/property-report.html`
is the one page that does not load `styles.css`. Overlay classes
(`.app-busy-modal`, `.settings-ai-bulk-modal`) also pin their own
`[hidden]` rule beside their `display: flex`, so the pair travels together if the
block is ever copied to a page without the global rule.

This is not hypothetical: 1.6.1 shipped `.report-export-modal { display: flex }`
on the one page lacking the global rule, and the export overlay covered the whole
report — swallowing every click on Back and the export button —
from the moment the report opened. `test/hidden-attribute.test.js` fails if a
page uses `hidden` without loading a stylesheet that neutralises it.

## Deciding whether a selector is dead

Grepping the source for a class name is the right first move, but two families
of class names are **built by interpolation** and never appear literally in any
`.js` file — they look dead and are not:

| Constructed as | Matching selectors |
|---|---|
| `home-asset-field--${layout}` (`src/renderer-asset-form.js`) | `.home-asset-field--compact` / `--fifth` / `--primary` / `--uniformat` |
| `app-toast--${tone}` (`src/shared.js`) | `.app-toast--error` |

Everything else in these files is referenced by its literal name, so a class that does not appear in `src/` or `pages/` after checking that table is genuinely unused. Selectors left over from removed features (a home-page theme toggle, an elevation preview strip, capital KPI/warning blocks) have been swept out on that basis.

## Content Security Policy

Each HTML page sets a CSP via `<meta http-equiv="Content-Security-Policy">`.
All pages restrict `default-src` and `script-src` to `'self'`; the DOCX viewer
is loaded from packaged `node_modules`, not a remote origin. Image policies
vary: the home page allows `file:` for user images and form/report pages allow
`file: blob: data:`.

The report page is the intentional exception to the normal no-inline-style
rule. `docx-preview` translates OOXML into generated style elements and inline
declarations, and can materialize embedded fonts as blob/data URLs. Its CSP
therefore adds `style-src 'self' 'unsafe-inline'` and
`font-src 'self' file: blob: data:`. Other pages do not inherit that relaxation.

`styles/property-report.css` also carries the only `@font-face` rules in the
app: the document face the DOCX names, bound to the bundled Carlito files so the
preview does not fall through to Chromium's default serif. See
[word-export](word-export.md#type-and-lists).
