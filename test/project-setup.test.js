const assert = require('node:assert/strict')
const test = require('node:test')

const { loadPage } = require('./helpers/renderer-page')

test('editing an existing project loads its values into the form', async () => {
  const { document, calls, flush } = loadPage('project-setup.html', {
    hash: '123',
    electronAPI: { getProject: () => ({ id: 123, client: 'Acme Property Co' }) },
  })
  await flush()

  assert.equal(document.getElementById('project-number').value, '123')
  assert.equal(document.getElementById('client').value, 'Acme Property Co')
  assert.equal(document.querySelector('.setup-title').textContent, 'Edit project')
  assert.ok(calls.some((c) => c.method === 'getProject' && c.args[0] === 123))
})

test('an existing project shows a delete button that deletes then goes home', async () => {
  const { document, calls, flush } = loadPage('project-setup.html', {
    hash: '123',
    electronAPI: {
      getProject: () => ({ id: 123, client: 'Acme' }),
      deleteProject: () => ({ canceled: false }),
    },
  })
  await flush()

  const del = document.querySelector('#project-delete-slot .btn-danger')
  assert.ok(del, 'delete button rendered for an existing project')
  del.click()
  await flush()

  assert.ok(calls.some((c) => c.method === 'deleteProject' && c.args[0] === 123))
  assert.ok(calls.some((c) => c.method === 'goHome'))
})

test('a canceled delete keeps the user on the form', async () => {
  const { document, calls, flush } = loadPage('project-setup.html', {
    hash: '123',
    electronAPI: {
      getProject: () => ({ id: 123, client: 'Acme' }),
      deleteProject: () => ({ canceled: true }),
    },
  })
  await flush()

  document.querySelector('#project-delete-slot .btn-danger').click()
  await flush()

  assert.ok(calls.some((c) => c.method === 'deleteProject'))
  assert.equal(calls.some((c) => c.method === 'goHome'), false)
})

test('a new project (no hash) renders no delete button and does not fetch', async () => {
  const { document, calls, flush } = loadPage('project-setup.html', {})
  await flush()

  assert.equal(document.querySelector('#project-delete-slot .btn-danger'), null)
  assert.equal(calls.some((c) => c.method === 'getProject'), false)
})

test('Back keeps a dirty project form open when its flush fails', async () => {
  const { window, document, calls, flush } = loadPage('project-setup.html', {
    hash: '123',
    electronAPI: {
      getProject: () => ({ id: 123, client: 'Acme' }),
      updateProject: () => Promise.reject(new Error('disk full')),
    },
  })
  window.console.error = () => {}
  await flush()

  const client = document.getElementById('client')
  client.value = 'Unsaved client'
  client.dispatchEvent(new window.Event('input', { bubbles: true }))
  document.getElementById('back-home').click()
  await flush()

  assert.ok(calls.some((call) => call.method === 'updateProject'))
  assert.equal(calls.some((call) => call.method === 'goHome'), false)
  assert.equal(document.getElementById('project-autosave-status').textContent, 'Save failed')
  assert.equal(client.value, 'Unsaved client')
})

test('Back flushes an edit made while its first save is still in flight', async () => {
  let resolveFirst
  const firstWrite = new Promise((resolve) => {
    resolveFirst = resolve
  })
  const payloads = []
  const { window, document, calls, flush } = loadPage('project-setup.html', {
    hash: '123',
    electronAPI: {
      getProject: () => ({ id: 123, client: 'Acme' }),
      updateProject: (_id, payload) => {
        payloads.push(payload)
        return payloads.length === 1 ? firstWrite : null
      },
    },
  })
  await flush()

  const client = document.getElementById('client')
  client.value = 'First draft'
  client.dispatchEvent(new window.Event('input', { bubbles: true }))
  document.getElementById('back-home').click()
  await flush()
  assert.equal(payloads.length, 1)

  client.value = 'Final draft'
  client.dispatchEvent(new window.Event('input', { bubbles: true }))
  resolveFirst()
  await flush()
  await flush()

  assert.deepEqual(payloads.map((payload) => payload.client), ['First draft', 'Final draft'])
  assert.ok(calls.some((call) => call.method === 'goHome'))
})

test('window close acknowledges only after a pending project draft is saved', async () => {
  let requestClose
  const order = []
  const { window, document, flush } = loadPage('project-setup.html', {
    hash: '123',
    electronAPI: {
      getProject: () => ({ id: 123, client: 'Acme' }),
      onCloseRequested: (listener) => {
        requestClose = listener
      },
      updateProject: (_id, payload) => {
        order.push({ type: 'save', payload })
      },
      completeCloseRequest: (requestId, result) => {
        order.push({ type: 'ack', requestId, result })
      },
    },
  })
  await flush()

  const client = document.getElementById('client')
  client.value = 'Saved during close'
  client.dispatchEvent(new window.Event('input', { bubbles: true }))
  requestClose(73)
  await flush()
  await flush()

  assert.equal(order.length, 2)
  assert.equal(order[0].type, 'save')
  assert.equal(order[0].payload.client, 'Saved during close')
  assert.equal(order[1].type, 'ack')
  assert.equal(order[1].requestId, 73)
  assert.equal(order[1].result.ok, true)
})

test('window close reports a failed draft flush instead of claiming success', async () => {
  let requestClose
  let closeResult
  const { window, document, flush } = loadPage('project-setup.html', {
    hash: '123',
    electronAPI: {
      getProject: () => ({ id: 123, client: 'Acme' }),
      onCloseRequested: (listener) => {
        requestClose = listener
      },
      updateProject: () => Promise.reject(new Error('disk full')),
      completeCloseRequest: (_requestId, result) => {
        closeResult = result
      },
    },
  })
  window.console.error = () => {}
  await flush()

  const client = document.getElementById('client')
  client.value = 'Still in the form'
  client.dispatchEvent(new window.Event('input', { bubbles: true }))
  requestClose(74)
  await flush()
  await flush()

  assert.equal(closeResult.ok, false)
  assert.equal(closeResult.error, 'disk full')
  assert.equal(client.value, 'Still in the form')
  assert.equal(document.getElementById('project-autosave-status').textContent, 'Save failed')
})

test('window close waits for every draft flusher before reporting the first failure', async () => {
  let requestClose
  let closeResult
  const { window, flush } = loadPage('project-setup.html', {
    electronAPI: {
      onCloseRequested: (listener) => {
        requestClose = listener
      },
      completeCloseRequest: (_requestId, result) => {
        closeResult = result
      },
    },
  })
  await flush()

  window.eval(`
    window.__slowDraftFinished = false
    registerRendererDraftFlusher(() => new Promise((resolve) => {
      window.__finishSlowDraft = () => {
        window.__slowDraftFinished = true
        resolve()
      }
    }))
    registerRendererDraftFlusher(() => Promise.reject(new Error('first draft failed')))
  `)

  requestClose(75)
  await flush()
  assert.equal(closeResult, undefined, 'failure acknowledgement waits for the sibling write')
  assert.equal(window.__slowDraftFinished, false)

  window.__finishSlowDraft()
  await flush()
  await flush()

  assert.equal(window.__slowDraftFinished, true)
  assert.equal(closeResult.ok, false)
  assert.equal(closeResult.error, 'first draft failed')
})
