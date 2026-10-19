const assert = require('node:assert/strict')
const test = require('node:test')

const { Cdp } = require('../scripts/ui-driver')

class FakeWebSocket {
  send(message) {
    const request = JSON.parse(message)
    this.onmessage({
      data: JSON.stringify({ id: request.id, result: { echoed: request.method } }),
    })
  }

  close() {
    this.onclose?.()
  }
}

test('Cdp.send registers a request before a synchronous transport can reply', async () => {
  const cdp = new Cdp(new FakeWebSocket(), 'test')
  assert.deepEqual(await cdp.send('Runtime.enable'), { echoed: 'Runtime.enable' })
})

test('Cdp rejects pending commands when the websocket closes', async () => {
  const socket = new FakeWebSocket()
  socket.send = () => {}
  const cdp = new Cdp(socket, 'renderer')
  const pending = cdp.send('Runtime.evaluate', {}, { timeoutMs: 5_000 })

  socket.onclose()

  await assert.rejects(pending, /renderer: websocket closed/)
  assert.equal(cdp.pending.size, 0)
})

test('Cdp.until keeps condition and diagnostic reads inside its own deadline', async () => {
  const cdp = new Cdp(new FakeWebSocket(), 'renderer')
  const calls = []
  cdp.eval = async (expression, options) => {
    calls.push({ expression, timeoutMs: options?.timeoutMs })
    return expression === 'diagnose()' ? { state: 'still waiting' } : false
  }

  const started = Date.now()
  await assert.rejects(
    cdp.until('ready()', 'readiness', 40, 'diagnose()'),
    /page state: \{"state":"still waiting"\}/,
  )
  const elapsed = Date.now() - started

  assert.ok(elapsed < 250, `40ms wait actually took ${elapsed}ms`)
  assert.ok(calls.length >= 2)
  assert.equal(calls.at(-1).expression, 'diagnose()')
  assert.ok(
    calls.every(({ timeoutMs }) => Number.isFinite(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 40),
  )
})

test('Cdp.key carries modifier and physical-key metadata on both events', async () => {
  const cdp = new Cdp(new FakeWebSocket(), 'renderer')
  const events = []
  cdp.send = async (method, params) => events.push({ method, params })

  await cdp.key('z', 90, { code: 'KeyZ', modifiers: 2 })

  assert.deepEqual(
    events.map(({ method, params }) => ({ method, ...params })),
    [
      {
        method: 'Input.dispatchKeyEvent',
        type: 'keyDown',
        key: 'z',
        code: 'KeyZ',
        modifiers: 2,
        windowsVirtualKeyCode: 90,
      },
      {
        method: 'Input.dispatchKeyEvent',
        type: 'keyUp',
        key: 'z',
        code: 'KeyZ',
        modifiers: 2,
        windowsVirtualKeyCode: 90,
      },
    ],
  )
})

test('Cdp.connect times out a websocket that never opens', async (t) => {
  const originalWebSocket = global.WebSocket
  class NeverOpeningWebSocket {
    close() {}
  }
  global.WebSocket = NeverOpeningWebSocket
  t.after(() => {
    global.WebSocket = originalWebSocket
  })

  await assert.rejects(
    Cdp.connect('ws://never-opens.invalid', 'main', { timeoutMs: 10 }),
    /main: websocket did not open within 10ms/,
  )
})
