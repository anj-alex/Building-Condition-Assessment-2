const assert = require('node:assert/strict')
const test = require('node:test')

const {
  CLOSE_REQUEST_CHANNEL,
  createWindowCloseCoordinator,
} = require('../src/main/window-close')

function fakeTimers() {
  let nextId = 0
  const timers = new Map()
  return {
    setTimeoutFn(callback, delay) {
      const id = ++nextId
      timers.set(id, { callback, delay })
      return id
    },
    clearTimeoutFn(id) {
      timers.delete(id)
    },
    fire(id) {
      const timer = timers.get(id)
      if (!timer) return
      timers.delete(id)
      timer.callback()
    },
    entries() {
      return [...timers.entries()]
    },
  }
}

function fakeWindow() {
  const sent = []
  let destroyed = false
  let destroyCalls = 0
  return {
    sent,
    isDestroyed: () => destroyed,
    destroy() {
      destroyCalls += 1
      destroyed = true
    },
    get destroyCalls() {
      return destroyCalls
    },
    webContents: {
      send(channel, ...args) {
        sent.push({ channel, args })
      },
    },
  }
}

function closeEvent() {
  let prevented = 0
  return {
    preventDefault() {
      prevented += 1
    },
    get prevented() {
      return prevented
    },
  }
}

function coordinator(overrides = {}) {
  const timers = fakeTimers()
  const prompts = []
  const deferredCloses = []
  const aborted = []
  const closeCoordinator = createWindowCloseCoordinator({
    dialog: {
      async showMessageBox(_win, options) {
        prompts.push(options)
        return { response: 0 }
      },
      ...overrides.dialog,
    },
    timeoutMs: 25,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    deferCloseFn: (close) => deferredCloses.push(close),
    onCloseAborted: (win) => aborted.push(win),
    logger: { warn() {}, error() {} },
  })
  return { closeCoordinator, timers, prompts, deferredCloses, aborted }
}

test('normal close waits for the matching renderer flush acknowledgement', () => {
  const { closeCoordinator, timers, deferredCloses } = coordinator()
  const win = fakeWindow()
  const event = closeEvent()

  closeCoordinator.begin(win, event)
  closeCoordinator.begin(win, event)

  assert.equal(event.prevented, 2)
  assert.deepEqual(win.sent, [
    { channel: CLOSE_REQUEST_CHANNEL, args: [1] },
  ])
  assert.equal(win.destroyCalls, 0)
  assert.equal(timers.entries().length, 1)

  assert.deepEqual(closeCoordinator.respond(win, 999, { ok: true }), {
    accepted: false,
  })
  assert.equal(win.destroyCalls, 0)
  assert.deepEqual(closeCoordinator.respond(win, 1, { ok: true }), {
    accepted: true,
    closing: true,
  })
  assert.equal(win.destroyCalls, 0, 'the IPC response gets a task to reach its renderer')
  assert.equal(deferredCloses.length, 1)
  deferredCloses.shift()()
  assert.equal(win.destroyCalls, 1)
  assert.equal(timers.entries().length, 0)
})

test('a reported save failure keeps the draft open and permits a clean retry', async () => {
  const { closeCoordinator, prompts, aborted } = coordinator()
  const win = fakeWindow()

  closeCoordinator.begin(win, closeEvent())
  assert.deepEqual(
    closeCoordinator.respond(win, 1, { ok: false, error: 'disk full' }),
    { accepted: true, closing: false },
  )
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(win.destroyCalls, 0)
  assert.deepEqual(aborted, [win])
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].defaultId, 0)
  assert.equal(prompts[0].cancelId, 0)
  assert.deepEqual(prompts[0].buttons, [
    'Keep Window Open',
    'Close Without Saving',
  ])

  closeCoordinator.begin(win, closeEvent())
  assert.deepEqual(win.sent.at(-1), {
    channel: CLOSE_REQUEST_CHANNEL,
    args: [2],
  })
})

test('the bounded timeout reaches an explicit force-close path', async () => {
  const { closeCoordinator, timers, prompts } = coordinator({
    dialog: { showMessageBox: async () => ({ response: 1 }) },
  })
  const win = fakeWindow()

  closeCoordinator.begin(win, closeEvent())
  const [[timerId, timer]] = timers.entries()
  assert.equal(timer.delay, 25)
  timers.fire(timerId)
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(win.destroyCalls, 1)
  // The override owns the prompt, so the default recorder is intentionally bypassed.
  assert.equal(prompts.length, 0)
  assert.deepEqual(closeCoordinator.respond(win, 1, { ok: true }), {
    accepted: false,
  })
})

test('abandon clears a pending timeout after an external forced close', () => {
  const { closeCoordinator, timers } = coordinator()
  const win = fakeWindow()
  closeCoordinator.begin(win, closeEvent())
  assert.equal(timers.entries().length, 1)

  closeCoordinator.abandon(win)
  assert.equal(timers.entries().length, 0)
  assert.deepEqual(closeCoordinator.respond(win, 1, { ok: true }), {
    accepted: false,
  })
})
