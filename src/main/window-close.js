const CLOSE_REQUEST_CHANNEL = 'app:close-requested'
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000

/**
 * Coordinate a BrowserWindow close with the renderer's draft registry.
 *
 * The renderer either acknowledges a complete flush or reports a save error.
 * A silent renderer is bounded by timeout, after which the user gets an
 * explicit choice: keep the window (the safe default) or force it closed.
 *
 * @param {{
 *   dialog: { showMessageBox: Function },
 *   timeoutMs?: number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 *   deferCloseFn?: (close: () => void) => void,
 *   onCloseAborted?: (win: object) => void,
 *   logger?: Pick<Console, 'warn'|'error'>,
 * }} options
 */
function createWindowCloseCoordinator(options) {
  if (!options?.dialog || typeof options.dialog.showMessageBox !== 'function') {
    throw new TypeError('createWindowCloseCoordinator needs an Electron dialog.')
  }

  const dialog = options.dialog
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : DEFAULT_CLOSE_TIMEOUT_MS
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
  const deferCloseFn = options.deferCloseFn ?? setImmediate
  const onCloseAborted = options.onCloseAborted ?? (() => {})
  const logger = options.logger ?? console

  let nextRequestId = 0
  /** @type {WeakMap<object, { requestId: number, phase: string, timer: ReturnType<typeof setTimeout>|null }>} */
  const attempts = new WeakMap()

  function isLive(win) {
    return Boolean(win) && !win.isDestroyed?.()
  }

  function clearAttemptTimer(attempt) {
    if (attempt.timer == null) return
    clearTimeoutFn(attempt.timer)
    attempt.timer = null
  }

  function destroyWindow(win, attempt) {
    if (attempts.get(win) !== attempt) return
    clearAttemptTimer(attempt)
    attempts.delete(win)
    if (isLive(win)) win.destroy()
  }

  function approveWindowClose(win, attempt) {
    if (attempts.get(win) !== attempt) return
    clearAttemptTimer(attempt)
    attempt.phase = 'approved'
    // ipcMain.handle still has to serialize app:close-response back to the
    // renderer. Destroying synchronously here can dispose that sender first and
    // turn a successful acknowledgement into a false renderer-side rejection.
    deferCloseFn(() => destroyWindow(win, attempt))
  }

  async function offerForcedClose(win, attempt, reason) {
    if (attempts.get(win) !== attempt || attempt.phase !== 'flushing') return
    attempt.phase = 'decision'
    clearAttemptTimer(attempt)

    if (reason.timedOut) {
      logger.warn?.(`Renderer draft flush exceeded ${timeoutMs} ms during close.`)
    } else if (reason.error) {
      logger.warn?.('Renderer draft flush failed during close:', reason.error)
    }

    let response = 0
    try {
      const result = await dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Changes are not saved yet',
        message: reason.timedOut
          ? 'The app did not finish saving before the close timeout.'
          : 'The app could not save all pending changes.',
        detail:
          'Keep the window open and try again, or close without saving. Closing without saving may discard recent edits.',
        buttons: ['Keep Window Open', 'Close Without Saving'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      response = result?.response === 1 ? 1 : 0
    } catch (error) {
      // A broken dialog must fail safe: keep the renderer and its draft alive.
      logger.error?.('Could not show the unsaved-changes close dialog:', error)
    }

    if (attempts.get(win) !== attempt) return
    if (response === 1) {
      destroyWindow(win, attempt)
    } else {
      attempts.delete(win)
      onCloseAborted(win)
    }
  }

  /**
   * Intercept one normal `BrowserWindow` close event.
   * Duplicate close events share the existing attempt.
   */
  function begin(win, event) {
    event?.preventDefault?.()
    if (!isLive(win)) return false
    if (attempts.has(win)) return true

    const attempt = {
      requestId: ++nextRequestId,
      phase: 'flushing',
      timer: null,
    }
    attempts.set(win, attempt)
    attempt.timer = setTimeoutFn(() => {
      void offerForcedClose(win, attempt, { timedOut: true })
    }, timeoutMs)

    try {
      win.webContents.send(CLOSE_REQUEST_CHANNEL, attempt.requestId)
    } catch (error) {
      void offerForcedClose(win, attempt, { error })
    }
    return true
  }

  /**
   * Accept an acknowledgement only from the window and request that own it.
   */
  function respond(win, requestId, result) {
    const attempt = win ? attempts.get(win) : null
    if (
      !attempt ||
      attempt.phase !== 'flushing' ||
      attempt.requestId !== requestId
    ) {
      return { accepted: false }
    }

    if (result?.ok === true) {
      approveWindowClose(win, attempt)
      return { accepted: true, closing: true }
    }

    const error = String(result?.error ?? 'Renderer did not confirm a successful flush.')
    void offerForcedClose(win, attempt, { error })
    return { accepted: true, closing: false }
  }

  /** Cancel timers when a window disappears through a forced/crash path. */
  function abandon(win) {
    const attempt = win ? attempts.get(win) : null
    if (!attempt) return
    clearAttemptTimer(attempt)
    attempts.delete(win)
  }

  return { begin, respond, abandon }
}

module.exports = {
  CLOSE_REQUEST_CHANNEL,
  DEFAULT_CLOSE_TIMEOUT_MS,
  createWindowCloseCoordinator,
}
