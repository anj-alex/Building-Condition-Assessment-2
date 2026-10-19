/**
 * Every GitHub Actions workflow in this repo is manual kickoff only.
 *
 * Nothing starts itself: no push, no pull_request, no schedule, no release
 * event. This is a deliberate policy (see AGENTS.md) — CI minutes are spent
 * when the developer decides a run is worth it, not on every commit.
 *
 * The check is textual rather than YAML-parsed on purpose: no yaml dependency,
 * and it reads the `on:` block exactly as a person scanning the file would.
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows')

/** Top-level keys under `on:` — the workflow's triggers. */
function triggerKeys(yaml) {
  const lines = yaml.split(/\r?\n/)
  const start = lines.findIndex((line) => /^on:\s*$/.test(line))
  assert.notEqual(start, -1, 'workflow must declare a block-form `on:` mapping')

  const keys = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break // dedented back to a top-level key: `on:` is over
    const match = /^ {2}([A-Za-z_]+):/.exec(line)
    if (match) keys.push(match[1])
  }
  return keys
}

test('every workflow is workflow_dispatch only', () => {
  const files = fs
    .readdirSync(WORKFLOW_DIR)
    .filter((name) => /\.ya?ml$/.test(name))

  assert.ok(files.length > 0, 'expected at least one workflow')

  for (const file of files) {
    const yaml = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8')

    // Single-line `on: push` / flow-sequence forms would slip past the block
    // parse below, so refuse them outright rather than parse every YAML shape.
    assert.doesNotMatch(
      yaml,
      /^on:[ \t]*\S/m,
      `${file}: use a block-form \`on:\` mapping so triggers stay reviewable`,
    )

    assert.deepEqual(
      triggerKeys(yaml),
      ['workflow_dispatch'],
      `${file}: workflows are manual kickoff only (see AGENTS.md)`,
    )
  }
})

// The Windows verification gate was deleted once already (with the Temporary
// Shares removal). Turning "someone deleted it again" into a failing unit test
// is the whole point of Part 1: the pre-release desktop gate must keep existing
// and must keep exercising both platforms.
test('verify-desktop.yml exists and defines both matrix legs', () => {
  const file = path.join(WORKFLOW_DIR, 'verify-desktop.yml')
  assert.ok(fs.existsSync(file), 'verify-desktop.yml is the non-publishing pre-release gate; it must exist')

  const yaml = fs.readFileSync(file, 'utf8')

  // Both operating systems, pinned exactly as the release workflow pins them.
  assert.match(yaml, /windows-2022/, 'verify-desktop.yml must run the Windows leg on windows-2022')
  assert.match(yaml, /ubuntu-24\.04/, 'verify-desktop.yml must run the Linux leg on ubuntu-24.04')

  // Both platform values must appear so the packaged/make/verify steps target
  // the right OS on each leg.
  assert.match(yaml, /platform:\s*win32/, 'verify-desktop.yml must define the win32 matrix platform')
  assert.match(yaml, /platform:\s*linux/, 'verify-desktop.yml must define the linux matrix platform')

  // It is a verification gate, not a release: it must never publish or upload
  // installers the way release-windows.yml does.
  assert.doesNotMatch(yaml, /action-gh-release/, 'verify-desktop.yml must not publish a GitHub Release')
  assert.doesNotMatch(yaml, /az storage blob upload/, 'verify-desktop.yml must not upload to Azure')
})

test('release workflow enforces a successful Verify Desktop run for its exact SHA', () => {
  const yaml = fs.readFileSync(
    path.join(WORKFLOW_DIR, 'release-windows.yml'),
    'utf8',
  )

  assert.match(yaml, /^  actions: read$/m, 'release workflow must be able to read Actions runs')
  assert.match(yaml, /^  verify-gate:$/m, 'release workflow must define the verification gate')
  assert.match(yaml, /actions\/workflows\/verify-desktop\.yml\/runs/)
  assert.match(yaml, /\.head_sha == \$sha/)
  assert.match(yaml, /^    needs: verify-gate$/m, 'release tests must wait for the gate')
  assert.match(yaml, /^    needs: test$/m, 'release builds must wait for gated tests')
  assert.match(yaml, /^    needs: build$/m, 'every publishing job must wait for gated builds')
})
