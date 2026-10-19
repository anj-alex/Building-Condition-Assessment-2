/**
 * Drive the real Electron app from Node, with no test-runner dependency.
 *
 * Exists because `npm test` cannot answer "does the window actually do this?".
 * The unit suites run under `ELECTRON_RUN_AS_NODE=1` with no renderer at all,
 * and `scripts/smoke-packaged-app.js` proves a packaged build opens a window but
 * never clicks anything. This module fills that gap: launch the dev app, click
 * through it, read the DOM back, and screenshot it.
 *
 * Dependency-free on purpose. Electron exposes the Chrome DevTools Protocol over
 * `--remote-debugging-port`, and Node has a global `WebSocket`, so there is
 * nothing to install and nothing to keep in step with the Electron version.
 * Playwright's `_electron` fixture is the richer tool when it is available; this
 * works in a bare container with no browsers and no X display.
 *
 * See docs/ui-driver.md for the flow, the gotchas, and how to add a scenario.
 */
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.join(__dirname, '..')
const electronBinary = path.join(
  repoRoot,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One CDP session: a WebSocket plus id-matched request/response bookkeeping. */
class Cdp {
  constructor(ws, label) {
    this.ws = ws
    this.label = label
    this.seq = 0
    this.pending = new Map()
    ws.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch (error) {
        this.#rejectPending(
          new Error(`${this.label}: received an invalid CDP response (${error.message})`),
        )
        return
      }
      const entry = this.pending.get(message.id)
      // Events (no id) and replies to a closed session are both uninteresting.
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    }
    ws.onerror = () => {
      this.#rejectPending(new Error(`${this.label}: websocket failed`))
    }
    ws.onclose = () => {
      this.#rejectPending(new Error(`${this.label}: websocket closed`))
    }
  }

  static async connect(webSocketDebuggerUrl, label = 'cdp', { timeoutMs = 10_000 } = {}) {
    const ws = new WebSocket(webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          ws.close()
        } catch {
          // A half-open socket has nothing else to release.
        }
        reject(new Error(`${label}: websocket did not open within ${timeoutMs}ms`))
      }, timeoutMs)
      ws.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error(`${label}: websocket failed to open`))
      }
    })
    const cdp = new Cdp(ws, label)
    // Runtime must be enabled before `evaluate` works on a page target.
    await cdp.send('Runtime.enable')
    return cdp
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {{ timeoutMs?: number }} [options] default 60s — without a bound,
   *   a wedged renderer (or a Runtime.evaluate awaitPromise that never
   *   settles) holds the whole harness until the CI job is cancelled.
   */
  send(method, params = {}, { timeoutMs = 60_000 } = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (!this.pending.has(id)) return
              this.pending.delete(id)
              reject(
                new Error(
                  `${this.label}: ${method} timed out after ${timeoutMs}ms`,
                ),
              )
            }, timeoutMs)
          : null
      this.pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          if (timer) clearTimeout(timer)
          reject(error)
        },
      })
      try {
        // Register before sending: a fake/test transport, and some in-process
        // WebSocket implementations, may answer synchronously.
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        const entry = this.pending.get(id)
        this.pending.delete(id)
        entry.reject(error)
      }
    })
  }

  #rejectPending(error) {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) entry.reject(error)
  }

  /** Evaluate an expression in the target and return it by value. */
  async eval(expression, { timeoutMs = 60_000 } = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      { timeoutMs },
    )
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          `${this.label}: evaluate failed`,
      )
    }
    return result.result.value
  }

  /**
   * Poll an expression until it is truthy. Errors count as "not yet" — during
   * navigation the old execution context is torn down and evaluate throws for a
   * moment before the new document is ready.
   *
   * `diagnose` is an optional expression evaluated once, only on timeout, and
   * appended to the error. Because errors are swallowed above, a wait that never
   * comes true otherwise reports nothing but "timed out waiting for X" — and an
   * intermittent failure on the release gate then costs another full dispatch
   * (Windows bills at 2x) purely to learn what the page was showing. Pass
   * whatever would have answered that question: an error toast, a count, a
   * status line. It is evaluated in the page like any other expression, so its
   * own failure is reported rather than hidden — an evaluate that times out
   * here is itself the finding.
   */
  async until(expression, label, timeoutMs = 20_000, diagnose = null) {
    const deadline = Date.now() + timeoutMs
    // Keep a small slice of the caller's budget for the one diagnostic read.
    // Otherwise a hung condition evaluation can consume the whole wait and
    // then the diagnostic gets a fresh 60 seconds of its own.
    const diagnosticBudget = diagnose
      ? Math.min(2_000, Math.max(1, Math.floor(timeoutMs / 5)))
      : 0
    const pollingDeadline = deadline - diagnosticBudget
    for (;;) {
      let value = null
      try {
        value = await this.eval(expression, {
          timeoutMs: Math.max(1, pollingDeadline - Date.now()),
        })
      } catch {
        value = null
      }
      if (value) return value
      if (Date.now() >= pollingDeadline) {
        let detail = ''
        if (diagnose) {
          try {
            detail = ` — page state: ${JSON.stringify(
              await this.eval(diagnose, {
                timeoutMs: Math.max(1, deadline - Date.now()),
              }),
            )}`
          } catch (error) {
            detail = ` — page state unavailable (${error?.message ?? error})`
          }
        }
        throw new Error(`${this.label}: timed out waiting for ${label}${detail}`)
      }
      await sleep(Math.min(200, Math.max(1, pollingDeadline - Date.now())))
    }
  }

  /**
   * Real key events, dispatched through the browser. Needed for anything the app
   * handles on `keydown` (Escape, undo) — those never fire from `element.click()`.
   */
  async key(key, windowsVirtualKeyCode, { code = key, modifiers = 0 } = {}) {
    for (const type of ['keyDown', 'keyUp']) {
      await this.send('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        modifiers,
        windowsVirtualKeyCode,
      })
    }
  }

  /**
   * Click the way a user does: check the element really is what sits at those
   * screen coordinates, then dispatch a real mouse event there.
   *
   * `element.click()` fires straight at the node, so it drives through anything
   * covering it. 1.6.1 shipped an export overlay that sat over the whole report
   * page and swallowed every toolbar click, and every scenario still passed,
   * because they all clicked elements directly. Hit-testing first means a
   * covered or invisible control fails here instead of at the user's desk.
   */
  async click(selector, { timeoutMs = 240_000 } = {}) {
    const literal = JSON.stringify(selector)
    const hit = await this.eval(`(() => {
      const el = document.querySelector(${literal})
      if (!el) return { ok: false, reason: 'no element matches' }
      el.scrollIntoView({ block: 'center', inline: 'center' })
      const box = el.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) return { ok: false, reason: 'no on-screen box' }
      const x = box.left + box.width / 2
      const y = box.top + box.height / 2
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) {
        return { ok: false, reason: 'centre point is outside the viewport' }
      }
      const top = document.elementFromPoint(x, y)
      if (!top) return { ok: false, reason: 'nothing is at its centre point' }
      if (top !== el && !el.contains(top)) {
        const name = top.id ? '#' + top.id : top.className || top.tagName
        return { ok: false, reason: 'covered by ' + name }
      }
      return { ok: true, x, y }
    })()`)
    if (!hit || !hit.ok) {
      throw new Error(`${this.label}: cannot click ${selector} — ${hit ? hit.reason : 'hit test failed'}`)
    }
    // Not the 60s default, because clicking a button is how a scenario starts
    // work that blocks the main process — and CDP is answered by that same main
    // process, so the reply to this very command can queue behind the export it
    // just kicked off. At 60s a working two-minute export on a slow runner fails
    // as `Input.dispatchMouseEvent timed out`, which points at the driver rather
    // than at anything real.
    //
    // Being generous here is safe: the hit test above is an `eval` on its own
    // 60s bound, so the renderer has already proven it answers before a single
    // event is dispatched. The only thing this can now be waiting on is the main
    // process doing the work the click asked for. A genuine wedge is still
    // caught, by this and then by the scenario budget behind it.
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send(
        'Input.dispatchMouseEvent',
        { type, x: hit.x, y: hit.y, button: 'left', clickCount: 1 },
        { timeoutMs },
      )
    }
  }

  /**
   * What a user would actually hit at this selector's centre: the selector
   * itself, a descendant of it, or whatever is covering it. Lets a scenario
   * assert reachability without clicking.
   */
  async topElementAt(selector) {
    const literal = JSON.stringify(selector)
    return this.eval(`(() => {
      const el = document.querySelector(${literal})
      if (!el) return 'no element matches'
      const box = el.getBoundingClientRect()
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      if (!top) return 'nothing'
      if (top === el || el.contains(top)) return ${literal}
      return top.id ? '#' + top.id : top.className || top.tagName
    })()`)
  }

  /** Screenshot the visible viewport. Look at the file — a blank frame is a failure. */
  async screenshot(filePath) {
    await this.send('Page.enable')
    const result = await this.send('Page.captureScreenshot', {})
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'))
    return filePath
  }

  close() {
    try {
      this.ws.close()
    } catch {
      // Already gone — nothing to release.
    }
  }
}

/** A launched app: the child process plus CDP access to its renderer and main process. */
class AppSession {
  constructor(child, { rendererPort, mainPort, userDataDir }) {
    this.child = child
    this.rendererPort = rendererPort
    this.mainPort = mainPort
    this.userDataDir = userDataDir
    this.sessions = []
    this.output = ''
  }

  /** Append to the retained tail (~8 KB) of the app's stdout/stderr. */
  recordOutput(text) {
    this.output = (this.output + text).slice(-8_192)
  }

  /** The retained tail of app output, for a post-mortem after a driver error. */
  recentOutput() {
    return this.output
  }

  /**
   * Attach to the page target whose URL contains `match`.
   *
   * Re-discover the target after every navigation rather than holding one
   * session: the app navigates the same `BrowserWindow` between pages, so the
   * document, the execution context, and any `Runtime.enable` state are all
   * replaced under you.
   */
  async page(match, timeoutMs = 30_000) {
    const target = await this.#findTarget(
      this.rendererPort,
      (entry) => entry.type === 'page' && entry.url.includes(match),
      `page target matching ${match}`,
      timeoutMs,
    )
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl, match)
    cdp.url = target.url
    this.sessions.push(cdp)
    return cdp
  }

  /**
   * Attach to the main process's Node inspector (`--inspect`).
   *
   * This is the only way to reach Electron APIs: the renderer's CDP endpoint
   * exposes only what Electron implements of the Page/Runtime domains, so
   * anything that lives on `app`, `BrowserWindow` or `webContents` is reachable
   * from here and nowhere else.
   */
  async mainProcess(timeoutMs = 30_000) {
    if (this.mainPort == null) {
      throw new Error(
        'main-process inspector was not enabled for this app (pass a mainPort when launching it).',
      )
    }
    const target = await this.#findTarget(
      this.mainPort,
      (entry) => Boolean(entry.webSocketDebuggerUrl),
      'main-process inspector target',
      timeoutMs,
    )
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl, 'main')
    this.sessions.push(cdp)
    return cdp
  }

  /**
   * Run an expression in the main process with `require` available.
   *
   * The inspector's default context is the module scope of whatever is executing,
   * where bare `require` may be undefined; `process.mainModule.require` is the
   * reliable fallback. `req` is in scope for the caller's expression.
   */
  async evalInMain(expression) {
    const main = this.main ?? (this.main = await this.mainProcess())
    return main.eval(`(async () => {
      const req = typeof require === 'function' ? require : process.mainModule.require
      return (${expression})
    })()`)
  }

  /** Where this run kept its database, images and localStorage. */
  async userDataPath() {
    return this.evalInMain(`req('electron').app.getPath('userData')`)
  }

  /** True while the child has neither exited nor been signalled. */
  get #running() {
    return this.child.exitCode === null && this.child.signalCode === null
  }

  async #waitForExit(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (this.#running && Date.now() < deadline) await sleep(100)
    return !this.#running
  }

  /**
   * Stop the app and do not return until its whole process tree is gone.
   *
   * Waiting matters because scenarios run back to back. Electron's browser
   * process has GPU, network and crashpad children that hold handles inside
   * `userData`; on Windows `kill()` is `TerminateProcess` on the parent alone,
   * so those children outlive it as orphans. Relaunching against the same
   * `userData` a moment later then produced a browser process that opened its
   * debugging port and never got as far as a window.
   *
   * Windows also gets asked before it gets forced. `taskkill` without `/f`
   * posts WM_CLOSE to the browser process's window, which is the path a real
   * user takes — the window closes, `app.quit()` runs, and Chromium commits
   * the preferences it is still holding in memory. One of those is the
   * `Local State` key that `safeStorage` seals secrets with, written on a
   * ~10-second timer, so a `/f` two seconds into a fresh profile takes it to
   * the grave and the next launch cannot open what this one wrote. A scenario
   * that kills the app is testing a crash; only a scenario that closes it is
   * testing a restart.
   */
  async stop() {
    for (const session of this.sessions) {
      try {
        session.close()
      } catch {
        // Session already gone.
      }
    }
    if (process.platform === 'win32') {
      // No `/t`: the descendants own no windows, so a graceful request only
      // makes sense to the one process that does.
      this.#taskkill([])
      if (!(await this.#waitForExit(5_000))) {
        // `/t` walks the tree that still exists, so kill the parent through
        // taskkill rather than killing it first and orphaning the descendants.
        // A taskkill that quietly failed leaves the next scenario to fail
        // instead, one launch later and with nothing pointing back here.
        const killed = this.#taskkill(['/t', '/f'])
        if (killed.status !== 0) {
          console.error(
            `taskkill /t /f on pid ${this.child.pid} exited ${killed.status}: ` +
              `${(killed.stderr || killed.stdout || '').trim() || killed.error?.message || 'no output'}`,
          )
        }
      }
      // Second force pass if a product child is still holding userData.
      if (!(await this.#waitForExit(3_000))) {
        this.#taskkill(['/t', '/f'])
        await this.#waitForExit(5_000)
      }
    } else {
      this.child.kill('SIGTERM')
    }
    if (!(await this.#waitForExit(5_000))) this.child.kill('SIGKILL')
    // Handle teardown trails process exit; the next launch shares its userData.
    await sleep(800)
  }

  #taskkill(extraArgs) {
    return spawnSync('taskkill', ['/pid', String(this.child.pid), ...extraArgs], {
      windowsHide: true,
      encoding: 'utf8',
    })
  }

  /** Poll a DevTools `/json/list` endpoint until a matching target appears. */
  async #findTarget(port, predicate, label, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        // The timeout is not politeness. A browser process whose UI thread is
        // wedged — blocked in a modal error box, say — still accepts the
        // connection and then never answers, and undici waits 300s for headers
        // by default. That turns a 30s deadline into a five-minute hang.
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(2_000),
        })
        const found = (await response.json()).find(predicate)
        if (found?.webSocketDebuggerUrl) return found
      } catch {
        // The endpoint is not listening yet, or the app died — the deadline decides.
      }
      if (!this.#running) {
        const outcome =
          this.child.exitCode !== null
            ? `code ${this.child.exitCode}`
            : `signal ${this.child.signalCode}`
        throw new Error(
          `app exited with ${outcome} before ${label} appeared` +
            ' (a dev app already holding the single-instance lock is the usual cause)',
        )
      }
      if (Date.now() > deadline) throw new Error(`no ${label} within ${timeoutMs}ms`)
      await sleep(300)
    }
  }
}

/**
 * Launch an Electron app with the renderer debugging endpoint open and,
 * unless `mainPort` is null, the main-process inspector open too.
 *
 * `userDataDir` is worth passing whenever a scenario writes anything. Without it
 * the run shares the developer's own database, images and localStorage (theme
 * preference included), so a scenario can leave visible changes behind — and the
 * single-instance lock means it will not even start while the dev app is open.
 * An empty directory needs no seeding: `--user-data-dir` becomes `userData`
 * verbatim, and a dev checkout seeds `data/dummy_data.sql` into any database with
 * no projects (`seedDummyDataIfEmpty` in src/db.js).
 *
 * `executablePath` / `appPath` make the same driver usable for a packaged
 * Electron executable. Pass `appPath: null` for a packaged app, and supply its
 * own arguments in `appArgs`. `mainPort: null` omits `--inspect` (needed when
 * a fuse disables the Node inspect argument); renderer CDP remains available.
 */
async function launchApp({
  rendererPort = 9333,
  mainPort = 9334,
  userDataDir = null,
  showOutput = false,
  env = {},
  executablePath = electronBinary,
  appPath = repoRoot,
  appArgs = [],
  chromiumArgs = ['--disable-gpu'],
} = {}) {
  if (typeof executablePath !== 'string' || executablePath.length === 0) {
    throw new TypeError('executablePath must be a non-empty Electron executable path.')
  }
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Electron binary not found (run npm install): ${executablePath}`)
  }
  if (appPath !== null && (typeof appPath !== 'string' || appPath.length === 0)) {
    throw new TypeError('appPath must be a non-empty path or null for a packaged executable.')
  }
  if (!Array.isArray(appArgs) || !appArgs.every((arg) => typeof arg === 'string')) {
    throw new TypeError('appArgs must be an array of strings.')
  }
  if (!Array.isArray(chromiumArgs) || !chromiumArgs.every((arg) => typeof arg === 'string')) {
    throw new TypeError('chromiumArgs must be an array of strings.')
  }

  const args = []
  if (rendererPort != null) args.push(`--remote-debugging-port=${rendererPort}`)
  if (mainPort != null) args.push(`--inspect=${mainPort}`)
  args.push(
    // Chromium's sandbox needs privileges a container usually will not have.
    '--no-sandbox',
    // CI runners give Chromium a small /dev/shm. When it fills, the renderer
    // process is killed while the browser process lives on — so the app stays
    // up with no page target and the driver times out looking for index.html,
    // exactly the shape that passes locally and fails under xvfb. Backing shared
    // memory with /tmp avoids it; harmless off-CI.
    '--disable-dev-shm-usage',
    // Keep Windows CI on the same software-rendered path as its packaged
    // smoke tests. This is harmless locally and avoids a GPU-dependent CDP
    // failure hiding the first Windows-driver result.
    ...chromiumArgs,
  )
  if (userDataDir) {
    fs.mkdirSync(userDataDir, { recursive: true })
    args.push(`--user-data-dir=${userDataDir}`)
  }
  args.push(...appArgs)
  if (appPath !== null) args.push(appPath)

  const child = spawn(executablePath, args, {
    cwd: repoRoot,
    // Always pipe: the tail must be available for a post-mortem even when the
    // app is otherwise silent (a scenario that never finds its first page has
    // no other clue why). `showOutput` additionally streams it live.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  const session = new AppSession(child, { rendererPort, mainPort, userDataDir })
  const record = (prefix, live) => (chunk) => {
    const text = `${prefix}${chunk}`
    if (showOutput) live.write(text)
    session.recordOutput(text)
  }
  child.stdout.on('data', record('[app] ', process.stdout))
  child.stderr.on('data', record('[app!] ', process.stderr))

  return session
}

/**
 * Collector for scenario assertions. Compares by JSON so DOM readbacks (arrays
 * of strings, small objects) can be asserted whole instead of field by field.
 */
function createChecks() {
  const failures = []
  return {
    check(label, actual, expected) {
      const ok = JSON.stringify(actual) === JSON.stringify(expected)
      const detail = ok ? '' : ` (expected ${JSON.stringify(expected)})`
      console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${detail}`)
      if (!ok) failures.push(label)
      return ok
    },
    note(label, value) {
      console.log(`  ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    },
    failures,
  }
}

/**
 * How long one scenario may run before it is declared stuck.
 *
 * Every individual CDP wait is already bounded, but the *sum* of them is not,
 * and neither is anything that blocks between them: a main process wedged
 * inside an import answers no command, so nothing it would have timed out ever
 * gets asked. Without this bound the only backstop is the CI job cap, which
 * kills the whole run with no diagnosis of which scenario hung.
 *
 * The entire five-scenario suite runs in 99 seconds on the Windows CI runner,
 * so this is generous several times over. It exists to catch a hang, not to
 * police a slow machine — raise it with CONDITION_ASSESSMENT_UI_BUDGET_MS
 * rather than trimming a scenario's own waits, which are what produce the
 * specific failure messages worth reading.
 */
const SCENARIO_BUDGET_MS = Number(process.env.CONDITION_ASSESSMENT_UI_BUDGET_MS) || 360_000

/**
 * Settle with `promise`, or reject once `budgetMs` has passed.
 *
 * A promise cannot be cancelled, so the losing scenario keeps running. The
 * caller stops the app immediately afterwards, which makes that scenario's next
 * CDP call reject into nothing — swallow it here. It is the expected
 * consequence of the timeout, not a second failure worth reporting over the
 * first, and an unhandled rejection would take the process down before the
 * budget message is printed.
 */
function withBudget(promise, budgetMs, label) {
  if (!(budgetMs > 0)) return promise
  let timer
  const budget = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      promise.catch(() => {})
      reject(
        new Error(
          `${label} was still running after ${Math.round(budgetMs / 1000)}s and is stuck. ` +
            'No single wait timed out, so the app stopped answering rather than ' +
            'failing a check — look at the app output below.',
        ),
      )
    }, budgetMs)
  })
  return Promise.race([promise, budget]).finally(() => clearTimeout(timer))
}

/**
 * Run a scenario against a freshly launched app and exit non-zero if anything
 * failed. Always stops the app — an orphaned instance keeps the single-instance
 * lock and every later run dies at startup.
 */
async function runScenario(name, options, scenario) {
  const checks = createChecks()
  const session = await launchApp(options)
  let error = null
  try {
    await withBudget(scenario(session, checks), SCENARIO_BUDGET_MS, name)
  } catch (caught) {
    error = caught
  } finally {
    await session.stop()
  }
  if (error) {
    console.error(`\n${name}: DRIVER ERROR — ${error.message}`)
    const tail = session.recentOutput().trim()
    if (tail) {
      console.error('--- app output (tail) ---')
      console.error(tail)
      console.error('--- end app output ---')
    }
    process.exitCode = 1
    return
  }
  if (checks.failures.length > 0) {
    console.error(`\n${name}: FAILED — ${checks.failures.join(', ')}`)
    process.exitCode = 1
    return
  }
  console.log(`\n${name}: all checks passed`)
}

module.exports = {
  AppSession,
  Cdp,
  createChecks,
  launchApp,
  repoRoot,
  runScenario,
  sleep,
}
