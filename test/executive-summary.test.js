const assert = require('node:assert/strict')
const test = require('node:test')

const { loadPage } = require('./helpers/renderer-page')

const building = {
  id: 2,
  property_name: 'Riverbend Tower',
  address: '1200 West Georgia',
  city: 'Vancouver',
  province_short: 'BC',
}

function open(overrides = {}) {
  return loadPage('executive-summary.html', {
    hash: '1:2',
    electronAPI: {
      getBuilding: () => building,
      getExecutiveSummary: () => ({ plumbing: 'Piping is serviceable.', electrical: 'Panels are aging.' }),
      ...overrides,
    },
  })
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function summaryUpdates(calls) {
  return calls.filter((call) => call.method === 'updateExecutiveSummary')
}

test('the summary form fills from getExecutiveSummary and shows building context', async () => {
  const { document, calls, flush } = open()
  await flush()

  assert.ok(calls.some((c) => c.method === 'getExecutiveSummary' && c.args[0] === 2))
  const form = document.getElementById('executive-summary-form')
  assert.equal(form.elements.namedItem('plumbing').value, 'Piping is serviceable.')
  assert.equal(form.elements.namedItem('electrical').value, 'Panels are aging.')
  assert.match(document.getElementById('executive-summary-context').textContent, /Riverbend Tower/)
})

test('Generate with AI fills the field and marks it generated', async () => {
  const { document, calls, flush } = open({
    generateExecutiveSummarySection: () => ({ ok: true, text: 'AI-written plumbing narrative.' }),
  })
  await flush()

  const form = document.getElementById('executive-summary-form')
  const btn = form.querySelector('.btn-ai-generate[data-summary-field="plumbing"]')
  assert.ok(btn, 'a generate button exists for plumbing')
  btn.click()
  await flush()

  assert.ok(calls.some((c) => c.method === 'generateExecutiveSummarySection' && c.args[1] === 'plumbing'))
  assert.equal(form.elements.namedItem('plumbing').value, 'AI-written plumbing narrative.')
  const status = form.querySelector('.field-ai-status[data-summary-status="plumbing"]')
  assert.match(status.textContent, /Generated/)
})

test('a failed AI generation surfaces the error and restores the button', async () => {
  const { document, flush } = open({
    generateExecutiveSummarySection: () => ({ ok: false, error: 'Model unavailable' }),
  })
  await flush()

  const form = document.getElementById('executive-summary-form')
  const btn = form.querySelector('.btn-ai-generate[data-summary-field="mechanical"]')
  btn.click()
  await flush()

  const status = form.querySelector('.field-ai-status[data-summary-status="mechanical"]')
  assert.match(status.textContent, /Model unavailable/)
  assert.ok(status.classList.contains('is-error'))
  assert.equal(btn.disabled, false)
  assert.equal(btn.textContent, 'Generate with AI')
})

test('Clear executive summary deletes and blanks every field', async () => {
  const { document, calls, flush } = open({ deleteExecutiveSummary: () => ({ canceled: false }) })
  await flush()

  document.getElementById('clear-executive-summary').click()
  await flush()

  assert.ok(calls.some((c) => c.method === 'deleteExecutiveSummary' && c.args[0] === 2))
  const form = document.getElementById('executive-summary-form')
  assert.equal(form.elements.namedItem('plumbing').value, '')
  assert.equal(form.elements.namedItem('electrical').value, '')
})

test('Clear revokes an in-flight generation before its text can autosave', async () => {
  const generation = deferred()
  const { document, calls, flush } = open({
    generateExecutiveSummarySection: () => generation.promise,
    deleteExecutiveSummary: () => ({ canceled: false }),
  })
  await flush()

  const form = document.getElementById('executive-summary-form')
  const field = form.elements.namedItem('plumbing')
  const button = form.querySelector('.btn-ai-generate[data-summary-field="plumbing"]')
  button.click()
  await flush()
  assert.equal(button.disabled, true)

  document.getElementById('clear-executive-summary').click()
  await flush()
  assert.equal(field.value, '')
  assert.equal(button.disabled, false)

  generation.resolve({ ok: true, text: 'Stale generated plumbing text.' })
  await flush()
  await flush()
  assert.equal(field.value, '')
  assert.equal(summaryUpdates(calls).length, 0)
})

for (const historyEvent of ['app-undo', 'app-redo']) {
  test(`${historyEvent} revokes in-flight generation and keeps restored text`, async () => {
    const generation = deferred()
    let summaryRead = 0
    const { window, document, calls, flush } = open({
      getExecutiveSummary: () => {
        summaryRead += 1
        return summaryRead === 1
          ? { plumbing: 'Piping is serviceable.' }
          : { plumbing: 'Text restored from history.' }
      },
      generateExecutiveSummarySection: () => generation.promise,
    })
    await flush()

    const form = document.getElementById('executive-summary-form')
    const field = form.elements.namedItem('plumbing')
    form.querySelector('.btn-ai-generate[data-summary-field="plumbing"]').click()
    await flush()

    window.dispatchEvent(
      new window.CustomEvent(historyEvent, {
        detail: {
          undone: historyEvent === 'app-undo',
          redone: historyEvent === 'app-redo',
          type: 'executive-summary-update',
          buildingId: 2,
        },
      }),
    )
    await flush()
    assert.equal(field.value, 'Text restored from history.')

    generation.resolve({ ok: true, text: 'Stale generated plumbing text.' })
    await flush()
    await flush()
    assert.equal(field.value, 'Text restored from history.')
    assert.equal(summaryUpdates(calls).length, 0)
  })
}

test('Back navigation revokes an in-flight generation', async () => {
  const generation = deferred()
  const { document, calls, flush } = open({
    generateExecutiveSummarySection: () => generation.promise,
  })
  await flush()

  const form = document.getElementById('executive-summary-form')
  const field = form.elements.namedItem('plumbing')
  form.querySelector('.btn-ai-generate[data-summary-field="plumbing"]').click()
  await flush()
  document.getElementById('back-home').click()
  await flush()
  assert.ok(calls.some((call) => call.method === 'goHome'))

  generation.resolve({ ok: true, text: 'Stale generated plumbing text.' })
  await flush()
  await flush()
  assert.equal(field.value, 'Piping is serviceable.')
  assert.equal(summaryUpdates(calls).length, 0)
})

test('pagehide revokes an in-flight generation', async () => {
  const generation = deferred()
  const { window, document, calls, flush } = open({
    generateExecutiveSummarySection: () => generation.promise,
  })
  await flush()

  const form = document.getElementById('executive-summary-form')
  const field = form.elements.namedItem('plumbing')
  form.querySelector('.btn-ai-generate[data-summary-field="plumbing"]').click()
  await flush()
  window.dispatchEvent(new window.Event('pagehide'))

  generation.resolve({ ok: true, text: 'Stale generated plumbing text.' })
  await flush()
  await flush()
  assert.equal(field.value, 'Piping is serviceable.')
  assert.equal(summaryUpdates(calls).length, 0)
})

test('an older result cannot overwrite or unlock a newer generation', async () => {
  const older = deferred()
  const newer = deferred()
  let generationCall = 0
  const { document, calls, flush } = open({
    generateExecutiveSummarySection: () => {
      generationCall += 1
      return generationCall === 1 ? older.promise : newer.promise
    },
    // A canceled Clear still represents a newer user decision and revokes the
    // old request, while leaving the existing text in place.
    deleteExecutiveSummary: () => ({ canceled: true }),
  })
  await flush()

  const form = document.getElementById('executive-summary-form')
  const field = form.elements.namedItem('plumbing')
  const button = form.querySelector('.btn-ai-generate[data-summary-field="plumbing"]')
  button.click()
  await flush()
  document.getElementById('clear-executive-summary').click()
  await flush()
  assert.equal(button.disabled, false)

  button.click()
  await flush()
  assert.equal(button.disabled, true)

  older.resolve({ ok: true, text: 'Older generated plumbing text.' })
  await flush()
  await flush()
  assert.equal(field.value, 'Piping is serviceable.')
  assert.equal(button.disabled, true)
  assert.equal(summaryUpdates(calls).length, 0)

  newer.resolve({ ok: true, text: 'Newest generated plumbing text.' })
  await flush()
  await flush()
  assert.equal(field.value, 'Newest generated plumbing text.')
  assert.equal(button.disabled, false)
  const updates = summaryUpdates(calls)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].args[1].plumbing, 'Newest generated plumbing text.')
})
