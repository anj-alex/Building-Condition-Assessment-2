/**
 * Every GitHub Actions job declares its own `timeout-minutes`.
 *
 * GitHub's default when none is set is 360 minutes, and Windows runners bill at
 * 2x — so a single wedged job can spend 720 minutes, more than a third of a
 * 2,000-minute month, before anything stops it. Nothing this repo builds takes
 * remotely that long: the full Verify Desktop run is 7 minutes on Windows and 5
 * on Linux, and the entire five-scenario CDP suite inside it is 99 seconds.
 *
 * An uncapped job is therefore always a mistake, and it is a silent one — the
 * cost shows up on a bill weeks later rather than as a failure. This test makes
 * adding one loud instead.
 *
 * Textual rather than YAML-parsed, matching workflows-manual-only.test.js: no
 * yaml dependency, and it reads the file the way a person scanning it would.
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows')

/**
 * Job ids and their bodies, keyed by id.
 *
 * A job is a two-space-indented key under the top-level `jobs:`. Reading from
 * `jobs:` rather than from the start of the file is what keeps `workflow_dispatch`
 * — two-space indented under `on:` — from being counted as a job.
 */
function jobs(yaml) {
  const lines = yaml.split(/\r?\n/)
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line))
  assert.notEqual(start, -1, 'workflow must declare a `jobs:` mapping')

  const found = new Map()
  let current = null
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break // dedented to a top-level key: `jobs:` is over
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (match) {
      current = match[1]
      found.set(current, [])
    } else if (current) {
      found.get(current).push(line)
    }
  }
  return found
}

const workflowFiles = fs
  .readdirSync(WORKFLOW_DIR)
  .filter((name) => /\.ya?ml$/.test(name))

test('every workflow job declares a timeout-minutes', () => {
  assert.ok(workflowFiles.length > 0, 'expected at least one workflow')

  for (const file of workflowFiles) {
    const yaml = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8')
    const found = jobs(yaml)
    assert.ok(found.size > 0, `${file}: expected at least one job`)

    for (const [id, body] of found) {
      const declared = body.some((line) => /^ {4}timeout-minutes:\s*\d+\s*$/.test(line))
      assert.ok(
        declared,
        `${file}: job \`${id}\` has no timeout-minutes, so it inherits GitHub's ` +
          '360-minute default (720 billed minutes on Windows)',
      )
    }
  }
})

test('no job timeout is left at an unreasonable ceiling', () => {
  // Verify Desktop — the longest workflow here, and a superset of the release
  // build's steps — finishes in 7 minutes. Nothing justifies half an hour, and a
  // generous cap is the failure mode this file exists to prevent: it does not
  // break the build, it just quietly costs money whenever something hangs.
  const CEILING = 30

  for (const file of workflowFiles) {
    const yaml = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8')
    for (const [id, body] of jobs(yaml)) {
      for (const line of body) {
        const match = /^ {4}timeout-minutes:\s*(\d+)\s*$/.exec(line)
        if (!match) continue
        const minutes = Number(match[1])
        assert.ok(
          minutes <= CEILING,
          `${file}: job \`${id}\` allows ${minutes} minutes; real runs are under ` +
            `10, so anything over ${CEILING} is a hang being paid for, not a slow build`,
        )
      }
    }
  }
})

test('the steps that can hang carry their own timeout', () => {
  // A job-level cap is the outermost backstop: it kills the run without saying
  // which step hung. The steps that reach the network or drive a real app get
  // their own cap so the failure names itself.
  const mustBeCapped = /^ {6}- name: (Install dependencies|Drive the app over CDP|Build distribution)/

  for (const file of workflowFiles) {
    const lines = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8').split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      if (!mustBeCapped.test(line)) continue
      // The step's own keys run until the next `- name:` at the same indent.
      const rest = lines.slice(index + 1)
      const end = rest.findIndex((next) => /^ {6}- /.test(next))
      const body = end === -1 ? rest : rest.slice(0, end)
      assert.ok(
        body.some((next) => /^ {8}timeout-minutes:\s*\d+\s*$/.test(next)),
        `${file}: step "${line.trim().replace('- name: ', '')}" can hang on the ` +
          'network or a wedged app, so it needs its own timeout-minutes',
      )
    }
  }
})
