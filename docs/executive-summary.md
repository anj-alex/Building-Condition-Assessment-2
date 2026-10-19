# Executive summary (`src/executive-summary.js`, `pages/executive-summary.html`)

Per-building narrative editor. The executive summary stores the narrative sections used by the report's front-matter Executive Summary, including Accessibility, Designated Substance Survey, the building-system sections, Immediate Concerns, Facility Overview, and Capital Needs (see [property-report](property-report.md)).

The report editor stores twelve text fields per building: `accessibility`, `designated_substance_survey`, `architectural_structural`, `plumbing`, `mechanical`, `electrical`, `fire_life_safety`, `site`, `code_compliance`, `immediate_concerns`, `facility_overview`, and `capital_needs`.

## Entry

`editExecutiveSummary(projectId, buildingId)` loads `executive-summary.html#<projectId>:<buildingId>`. Both ids are parsed from the hash.

## Sections

`summaryFields` lists the twelve database columns, mirrored by the HTML form:

1. `accessibility` — Accessibility Executive Summary
2. `designated_substance_survey` — Designated Substance Survey Executive Summary
3. `architectural_structural` — Architectural & Structural Executive Summary
4. `plumbing` — Plumbing Executive Summary
5. `mechanical` — Mechanical Executive Summary
6. `electrical` — Electrical Executive Summary
7. `fire_life_safety` — Fire and Life Safety Executive Summary
8. `site` — Site Executive Summary
9. `code_compliance` — Code Compliance Executive Summary
10. `immediate_concerns` — Immediate Concerns
11. `facility_overview` — Facility Overview
12. `capital_needs` — Capital Renewal Summary

Each is a `<textarea rows="5">` with a **Generate with AI** button in the field header. The `capital_needs` section is separated on the report (rendered after the other sections, before the capital needs table) but edited here as just another field.

## Bootstrap

`loadContext` fetches the building and sets the context line under the title to `"<property name> - <address>"` (or just the name). `loadExecutiveSummary` fetches the summary row (or the all-null default from `db.getExecutiveSummary`) and populates each textarea. Autosave is enabled only after load completes.

## Autosave + history

No Save/Cancel buttons. Uses `createFormAutosave` (see [editing-model](editing-model.md)):

- Debounced typing; **Back** flushes before leaving
- AI-generated prose is written into the field and autosaved immediately
- Field updates record coalesced `executive-summary-update` undo steps
- **Clear summary** still soft-deletes the row (`executive-summary-delete`, undoable)

## AI section generation

Each section has a **Generate with AI** control that:

1. Requires the session OpenRouter key loaded at startup (same packaging as photo labels; no Settings unlock password).
2. Calls `generateExecutiveSummarySection(buildingId, field)` → main `ai:generateExecutiveSummarySection`.
3. Main loads the building, all visible assets, and the building's capital plan (`db.getBuildingCapitalPlan`), builds a section-specific prompt, and calls OpenRouter with **`OPENROUTER_SUMMARY_MODEL`** (default `deepseek/deepseek-v4-pro`). This is separate from the vision model used for photo captions (`OPENROUTER_VISION_MODEL`).
4. On success, the returned prose is placed in the matching textarea and marked dirty for autosave.

Failures (locked, missing model, API error) show under the field. While generating, the button shows “Generating…”, the textarea is read-only, and a status line updates.

### In-flight generation ownership

Direct generation is asynchronous, so each request receives a monotonically
increasing identity and owns its field only while that identity is current.
**Clear summary**, a matching undo/redo reload, **Back**, and `pagehide` revoke
all current identities before they clear, reload, save, or leave. A replacement
generation for the same field receives a new identity.

Revocation does not attempt to cancel the OpenRouter call in the main process;
it makes the eventual renderer result inert. A stale success or failure cannot
change the textarea or status, queue autosave, or unlock a field now owned by a
newer request. This preserves the user's latest direct action even when network
responses finish out of order.

Main also rechecks the database-file identity after the awaited OpenRouter call.
An app-data replacement can reuse the same numeric building id while that call
is in flight; when the identity/latch changed, main invalidates old AI and undo
state and returns a canceled, non-OK response without the generated prose. The
renderer therefore has nothing from the old building context to place in the
new building's field or autosave. The request also compares the caption
service's workspace epoch, so it still detects the replacement when another DB
call already consumed the one-shot change latch.

### Token budget (the summary model reasons before it writes)

`SUMMARY_MAX_TOKENS = 16384` is a **safety bound, not a target**. Actual prose is ~300 tokens.

OpenRouter counts a reasoning model's thinking tokens against `max_tokens`, and the default summary model reasons first. When the budget is smaller than the reasoning trace, the model spends the whole allowance thinking and returns **no content at all** — `finish_reason: "length"` with an empty message. At the original budget of 700 that broke *every* section, not just the large ones.

Measured reasoning traces for a 24-asset building, one per section: 212 (designated substance survey) up to 2,161 (mechanical). 16,384 leaves roughly 7× headroom over the worst.

Why not simply set it to the model's maximum:

- **There is no single maximum.** It is per-provider, from 16,384 to 1,048,576, and several providers declare none.
- **The real ceiling is rejected.** The prompt and the output budget share the context window, so a `max_tokens` at the context limit returns HTTP 400. Any static value near it becomes a latent failure that triggers as buildings gain assets.
- **Large values shrink the provider pool** that failover depends on. 16,384 is the largest value every provider serving the model can honour; 1,048,576 leaves 6 of 18.
- **`max_tokens` bounds a runaway.** Reasoning length is not otherwise controllable — `reasoning_effort` is accepted by every provider but does not bound this model (measured at a 6,000 budget: baseline 856, minimal 1,284, low 1,445, medium 1,907, high 1,790 — no monotonic relationship), and `reasoning: { max_tokens: N }` is likewise inert. Completion pricing spans 4× across providers, so the budget is what caps the cost of a looping trace.

Both truncation cases fail loudly rather than silently:

- **No content** plus `finish_reason: "length"` reports the budget, since "empty response" describes the symptom and hides the cause.
- **Partial content** plus `finish_reason: "length"` is also an error. Prose that stops at the budget stops mid-sentence, and autosave would commit it to the field.

Captions deliberately skip this check: a caption legitimately runs out at `CAPTION_MAX_TOKENS`, and `sanitizeCaption` clamps it anyway.

`OPENROUTER_REQUEST_TIMEOUT_MS = 120_000` caps the whole request operation's
wall clock (summaries observed at 11–16s), including a `429`/`503` backoff and
its one retry. Each HTTP attempt receives only the time left on that absolute
deadline, including receipt of the response body after its headers arrive.
`Retry-After` accepts both delta-seconds and the HTTP-date form and is
capped at 60 seconds. Without the deadline a stalled socket holds the field
read-only indefinitely, and under bulk fill it blocks navigation until every
job settles.

**Settings → Generate AI for all blank fields** also fills every empty executive-summary section across visible buildings (same session key + summary model), writing results directly to the database with the same concurrency / free-model RPM caps as photo captions. See [ai-photo-labels](ai-photo-labels.md).

Prompt construction lives in `src/ai/openrouter-client.js` (`buildExecutiveSummaryPrompt`); aggregation lives in `src/lib/asset-rollup.js`. Generation entry point: `captionService.generateExecutiveSummarySection` (single field) / `captionService.enqueueSummaryJobs` (bulk blank fill).

### What the prompt contains

Every section gets four blocks, in order:

1. **Property facts** — name, address, gross floor area, storeys, vintage, date of assessment.
2. **Building-wide capital position** — CRV (and whether derived or overridden), the four FCI windows with IFMA grades, capital totals per term, and the scheduled/unscheduled 25-year totals. All of it comes from `calculateCapitalPlan`, the same engine as the report, so quoted figures reconcile with the report tables.
3. **Aggregate rollups** (`summarizeAssets`) — asset count, mean condition rating on the 1–6 dropdown scale, condition/action/priority/term/asset-FCI histograms, vintage range and mean age, count past service life, total opinion of probable cost, and capital by term. Emitted building-wide, plus a section-scoped copy when the section is a strict subset of the register.
4. **Asset detail lines** — per-section, see below.

Costs are rounded to the nearest $1,000 (`formatMoney`) so the model has no spurious precision to quote. The system prompt permits citing provided figures verbatim but forbids deriving new ones, and states that FCI and mean condition rating are separate metrics that must not be conflated.

### Per-section asset detail

`SECTION_DETAIL_POLICY` decides how many assets earn an individual line, and `selectSectionDetailAssets` applies it. Aggregates always cover the full register, so unlisted assets are still represented.

| Section | Mode | Detail |
|---|---|---|
| `facility_overview`, `designated_substance_survey`, `code_compliance` | `none` | No asset lines — these are building-wide statements the register holds no findings for. The prompt says so explicitly rather than leaving the model to invent specifics. |
| `accessibility` | `keyword` | Up to 5 assets matching accessibility keywords in **assessor-authored** fields only. |
| `architectural_structural` | `severity` | Up to 15 from the section's Uniformat scope. |
| `plumbing`, `mechanical`, `electrical`, `fire_life_safety`, `site` | `severity` | Up to 12 each. |
| `immediate_concerns` | `severity` | Up to 10 from the urgency-scoped subset. |
| `capital_needs` | `cost` | Up to 10 by opinion of probable cost, excluding assets suppressed from the plan (`No Action` / term `N/A`) — their replacement value is not a capital need. |

`severity` mode ranks by priority, then condition, then cost, then how overdue the asset is (`rankAssetsBySeverity`), so the assets that drive the narrative are the ones that survive the cap.

**Two fields are deliberately withheld.** `level_3_description` and `material` come from the `uniformat_pricing` join: they describe the priced catalogue line item, not the asset, and routinely disagree with it (a real row prices "Exterior Sealants & Joint Covers" as `Portable Roof Anchors`). Feeding them to the model produces confident, wrong prose. Asset identity in the prompt is `asset_name` plus the level-1/level-2 Uniformat grouping. For the same reason, keyword-based selection reads only `asset_name`, `description`, and `recommendation`.

Photos, project/firm records, unit prices, and service-life catalogue columns are never sent.

### Term on a detail line comes from the scheduled action year, not the column

An asset's `term` column is the assessor's; the capital position block's term totals are bucketed from the derived **action year**. They can disagree — on the dev database 7 of 24 assets do — and a prompt that quotes both makes the model contradict itself. Before this was fixed, one prompt offered `term Short Term; action year 2030; opinion of probable cost $890,000` alongside a Short Term total of `$437,000` spanning `2027–2028`, and the model dutifully reported an $890,000 Short Term item that no Short Term total contained.

`formatAssetForSummaryPrompt` therefore prints the bucket `termLabelForYear`
resolves from the plan's `scheduledActionYear`. The detail line prints that same
scheduled year. If the lifecycle year is overdue, it remains explicit context
(`action year 2026 (overdue; lifecycle date 1990)`) rather than being presented
as the recommendation. The column is used only when no bucket applies: a
suppressed asset (nothing is scheduled, so no bucket is its own), a year outside
every window, or no capital plan at all.

### Section scope vs. keyword fallbacks

`filterAssetsForSummarySection` scopes a section by Uniformat code first (`D20` plumbing, `D30` mechanical, `D40` fire/life safety, `D50` electrical, `G` site, `A`/`B`/`C` architectural), with a keyword fallback for assets no code assigns. The code wins even when the asset name disagrees with it, because the report's own tables and section tabs group by the same code — scoping a section any other way would put the prose and the tables in different places.

Two guards keep the fallback honest:

- `codeOwnedSection` — a keyword may not claim an asset a code already assigns elsewhere, because catalogue text such as the level-2 description "Site Civil/Mechanical Utilities" otherwise drags G-group site assets into Mechanical.
- The keyword haystack is `asset_name`, `level_1_description`, `level_2_description`, and `description` only. The level-3 description and material are excluded for the reason given above: an elevator priced against a boiler row would otherwise scope into Mechanical on the strength of a word the assessor never wrote.

### Immediate concerns scope

Urgency comes from `priority` = High, the capital plan's effective term = Immediate, or the severe end of the condition scale (Very poor / Critical). An unrated asset has no implicit urgency fallback: FCI is building-level. Assets the plan schedules nothing for (`No Action` / effective term `N/A`) are excluded outright.

`action` is deliberately **not** a signal. Replace and Repair are the two most common actions in a condition assessment and say nothing about *when* work is due, so matching them admitted most of the register: on the dev database it scoped 17 of 24 assets into Immediate Concerns, against 5 under the current rule.
