try {
  require('electron-reloader')(module, {
    ignore: ['out'],
  })
} catch {
  // electron-reloader is dev-only; omit from production installs
}

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage } = require('electron/main')
const { shell } = require('electron')

const mainPaths = require('./main/paths')
const linuxDesktop = require('./main/linux-desktop')
const menu = require('./main/menu')
const startup = require('./main/startup')
const ipcHandlers = require('./main/ipc-handlers')
const { createWindowCloseCoordinator } = require('./main/window-close')

// Squirrel runs the app with --squirrel-install/--squirrel-updated/etc. during
// install and update. Electron binaries advertise SquirrelAwareVersion, so
// Squirrel delegates shortcut creation to us and waits; without this the app
// opens a real window mid-install, gets killed, and no shortcuts are created.
const isSquirrelStartupEvent = require('electron-squirrel-startup')
if (isSquirrelStartupEvent) {
  app.quit()
}

/**
 * Linux (especially Wayland) does not use BrowserWindow `icon` for the dock /
 * taskbar. Compositors look up a matching XDG `.desktop` file by app id /
 * WM_CLASS. `setDesktopName` must run before `ready` so the running process
 * advertises the same id as the desktop entry we install under ~/.local.
 */
const APP_DESKTOP_ID = 'condition-assesment-report-generator'
if (process.platform === 'linux') {
  // Human-facing name (menus); desktop id is separate and must match the .desktop file.
  app.setName('Condition Assessment Report Generator')
  app.setDesktopName(`${APP_DESKTOP_ID}.desktop`)
}

/**
 * Report a startup failure somewhere a user can actually see it, then stop.
 *
 * A packaged Windows app has no attached console, so `console.error` alone
 * reaches nobody and the process just disappears — which is exactly how the
 * v1.0.2 release presented as "crashes on open". `showErrorBox` is one of the
 * few dialog calls allowed before `app.whenReady()`.
 */
let startupComplete = false

function reportFatalStartupError(error) {
  console.error(
    startupComplete ? 'Unhandled error:' : 'Application startup failed:',
    error,
  )
  if (!isSmokeTestEnvironment()) {
    try {
      dialog.showErrorBox(
        startupComplete
          ? 'condition-assesment-report-generator hit an unexpected error'
          : 'condition-assesment-report-generator could not start',
        String(error?.stack ?? error?.message ?? error),
      )
    } catch {
      // A dialog we cannot show must not replace the error we are reporting.
    }
  }
  app.exit(1)
}

// Read from the environment directly: the requires below define isSmokeTest,
// and they are the very thing that might not get far enough to do so.
function isSmokeTestEnvironment() {
  return process.env.CONDITION_ASSESSMENT_SMOKE_TEST === '1'
}

// Everything past this point can throw while loading — a native module built
// for the wrong ABI, a missing packaged data file, a throw in a module body.
// Without this handler those die before the whenReady catch below exists.
process.on('uncaughtException', reportFatalStartupError)
// Load project .env before AI config is required (model + API key).
require('./lib/load-env').loadProjectEnv()

const db = require('./db')
const appSettings = require('./app-settings')
const appDataIo = require('./app-data-io')
const undoHistory = require('./undo-history')
const { readUniformatPricingRows } = require('./lib/csv-utils')
const captionService = require('./ai/caption-service')
const {
  ensureOpenRouterSecretFromEnv,
} = require('./ai/sync-openrouter-secret')

const isSmokeTest = process.env.CONDITION_ASSESSMENT_SMOKE_TEST === '1'
const smokeTestUserData = process.env.CONDITION_ASSESSMENT_USER_DATA
// Opt the smoke test into building the real window and loading the renderer,
// instead of quitting as soon as the database is up.
const isWindowSmokeTest = isSmokeTest && process.env.CONDITION_ASSESSMENT_SMOKE_WINDOW === '1'
// Non-interactive recovery from an incompatible database (smoke tests, and an
// escape hatch for users who cannot reach the dialog).
const autoResetIncompatibleDb = process.env.CONDITION_ASSESSMENT_RESET_DB === '1'
if (isSmokeTest && smokeTestUserData) {
  app.setPath('userData', path.resolve(smokeTestUserData))
}

/**
 * One running copy per data file.
 *
 * Two instances open the same `app.db` through two independent connections and
 * two sets of in-memory renderer state, so each one's edits are invisible to
 * the other and the last writer wins — including for the migration prompt,
 * where a second copy could start upgrading a file the first is already using.
 * Double-clicking a Windows shortcut twice is all it takes.
 *
 * The lock is scoped to `userData`, so it has to be requested *after*
 * `setPath` above or a smoke test would contend with the developer's own
 * running app. Squirrel's install hooks are exempt: that process has already
 * been told to quit, and taking the lock during an install would deny it to
 * the app being installed.
 */
const hasSingleInstanceLock =
  isSquirrelStartupEvent || app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  console.error(
    `Another copy of this app is already using ${app.getPath('userData')}`,
  )
  // Smoke scenarios each get their own userData directory, so losing the lock
  // means a previous run never died. Exiting 0 would report that as a pass.
  // Interactive launches must not quit here: on Linux, dialogs before ready are
  // stderr-only, and an early quit can race the `whenReady` dialog below.
  if (isSmokeTest) app.exit(1)
}

app.on('second-instance', () => {
  // Before the first window exists there is nothing to raise, and creating one
  // here would race the database open still in flight.
  if (!startupComplete) return
  const [win] = BrowserWindow.getAllWindows()
  if (!win) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.focus()
})

const pagesDir = path.join(__dirname, '..', 'pages')

function getWindow(event) {
  return BrowserWindow.fromWebContents(event.sender)
}

function loadPage(win, fileName, hash = '') {
  if (!win) return
  if (busyTask) {
    // A long task owns the window until it finishes — refuse navigation.
    console.warn(`Navigation blocked while ${busyTask} is running:`, fileName)
    return
  }
  const normalizedHash = hash ? String(hash) : ''
  win.loadFile(path.join(pagesDir, fileName), normalizedHash ? { hash: normalizedHash } : undefined)
}

/**
 * Label of the long-running task that currently owns the UI, or null when idle.
 *
 * One lock serves every task that takes the window over behind a modal — bulk AI
 * generation from Settings, and the report export. The label is what the
 * "you cannot leave yet" dialog names, so it must describe the task actually
 * holding the lock rather than assuming AI.
 */
let busyTask = null

function setBusyTask(label) {
  busyTask = label ? String(label) : null
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.setClosable(!busyTask)
    } catch {
      // Some platforms may not support setClosable.
    }
  }
  // Rebuild menu so Reload / Quit stay disabled while locked in the modal.
  try {
    buildApplicationMenu()
  } catch {
    // Menu may not exist yet during early startup.
  }
  return { ok: true, busy: Boolean(busyTask), task: busyTask }
}

function busyTaskLabel() {
  return busyTask
}

function copyAssetImage(assetId, sourcePath) {
  return mainPaths.copyImageInto(
    mainPaths.assetImagesDir(app.getPath('userData')),
    'asset',
    assetId,
    sourcePath,
  )
}

function copyBuildingImage(buildingId, sourcePath) {
  return mainPaths.copyImageInto(
    mainPaths.buildingImagesDir(app.getPath('userData')),
    'building',
    buildingId,
    sourcePath,
  )
}

function copyFirmLogo(sourcePath) {
  return mainPaths.copyImageInto(
    mainPaths.firmAssetsDir(app.getPath('userData')),
    'firm-logo',
    1,
    sourcePath,
  )
}

let appQuitRequested = false
const windowCloseCoordinator = createWindowCloseCoordinator({
  dialog,
  onCloseAborted: () => {
    // A failed flush kept the window open, so a prior Cmd/Ctrl+Q is canceled.
    appQuitRequested = false
  },
})

ipcHandlers.registerIpcHandlers({
  ipcMain,
  app,
  dialog,
  shell,
  db,
  undoHistory,
  captionService,
  appSettings,
  appDataIo,
  readUniformatPricingRows,
  loadPage,
  getWindow,
  copyFirmLogo,
  copyBuildingImage,
  copyAssetImage,
  setBusyTask,
  respondToCloseRequest: windowCloseCoordinator.respond,
})

function openSettingsWindow() {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  if (win) loadPage(win, 'settings.html')
}

function buildApplicationMenu() {
  const template = menu.buildMenuTemplate({
    version: app.getVersion(),
    appName: app.getName(),
    bulkBusy: Boolean(busyTaskLabel()),
    platform: process.platform,
    onOpenSettings: () => openSettingsWindow(),
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Master PNG next to packaged/runtime resources (`assets/icon.png`). */
function resolveAppIconPath() {
  return path.join(__dirname, '..', 'assets', 'icon.png')
}

/** Load the app icon as a NativeImage; null if missing or unreadable. */
function loadAppIconImage() {
  const iconPath = resolveAppIconPath()
  if (!fs.existsSync(iconPath)) return null
  const img = nativeImage.createFromPath(iconPath)
  if (img.isEmpty()) return null
  // Mid-size is more reliable for window decorations than a raw 1024² bitmap.
  const { width } = img.getSize()
  return width > 512 ? img.resize({ width: 512, height: 512 }) : img
}

/**
 * Install a user-level .desktop entry + hicolor icon so Linux shells (Wayland
 * app_id / X11 WM_CLASS) can show our icon instead of the generic Electron one.
 * No-op outside Linux, and skipped in smoke tests so CI does not touch $HOME.
 */
function ensureLinuxDesktopIntegration() {
  return linuxDesktop.ensureLinuxDesktopIntegration({
    platform: process.platform,
    isSmokeTest,
    homeDir: os.homedir(),
    iconSrc: resolveAppIconPath(),
    appDesktopId: APP_DESKTOP_ID,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
  })
}

const createWindow = () => {
  const appIcon = loadAppIconImage()
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    title: 'condition-assesment-report-generator',
    ...(appIcon ? { icon: appIcon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // Re-apply after construction — some Linux WMs ignore constructor-only icons.
  if (appIcon) win.setIcon(appIcon)

  // Attached before the first load starts, so nothing can fail in the gap.
  // A renderer that fails to load leaves a blank window, which looks to a user
  // exactly like the app hanging — say what happened instead.
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, url) => {
    // Ignored aborts are ordinary: an in-flight navigation being superseded.
    if (errorCode === -3) return
    reportWindowFailure(`Failed to load ${url}: ${errorDescription} (${errorCode})`)
  })
  win.webContents.on('preload-error', (event, preloadPath, error) => {
    reportWindowFailure(`Preload script ${preloadPath} failed: ${error?.message ?? error}`)
  })
  win.webContents.on('render-process-gone', (event, details) => {
    if (busyTaskLabel()) setBusyTask(null)
    reportWindowFailure(
      `Renderer process gone: ${details?.reason ?? 'unknown'} (exit ${details?.exitCode})`,
      { fatal: true },
    )
  })

  win.on('close', (event) => {
    const task = busyTaskLabel()
    if (task) {
      event.preventDefault()
      void dialog.showMessageBox(win, {
        type: 'warning',
        title: `${task} in progress`,
        message: `${task} is still running. Wait until it finishes — you cannot leave or quit yet.`,
        buttons: ['OK'],
        defaultId: 0,
      })
      return
    }
    windowCloseCoordinator.begin(win, event)
  })
  win.on('closed', () => {
    windowCloseCoordinator.abandon(win)
    // Preventing a window close also cancels the app.quit() attempt that caused
    // it. Resume explicitly once every window has acknowledged its draft flush;
    // this is required on macOS, where window-all-closed intentionally stays up.
    if (appQuitRequested) {
      setImmediate(() => {
        if (!appQuitRequested || BrowserWindow.getAllWindows().length !== 0) return
        appQuitRequested = false
        app.quit()
      })
    }
  })

  loadPage(win, 'index.html')
  return win
}

/** Every renderer failure seen so far, in order. The smoke test asserts on it. */
const windowFailures = []
let onWindowFailure = null

/**
 * Surface a renderer-side failure. A blank window looks to a user exactly like
 * a hang, so it must always say something; the smoke test reads the same list
 * rather than racing to attach its own listeners after the load has started.
 */
function reportWindowFailure(message, { fatal = false } = {}) {
  windowFailures.push(message)
  console.error(message)
  if (onWindowFailure) onWindowFailure(fatal)
  if (isSmokeTest) return
  try {
    dialog.showErrorBox('condition-assesment-report-generator hit a display error', message)
  } catch {
    // Reporting must not itself become the failure.
  }
}

/**
 * Open the database, recovering interactively when the file on disk was written
 * by a different release. The migrate-or-reset conversation lives in
 * src/main/startup.js; this binds it to the real db, dialog, shell, and the
 * non-interactive smoke/reset flags.
 *
 * @returns {boolean} whether startup should continue
 */
function openDatabaseWithRecovery() {
  // A process may have stopped after app.db was moved into the import rollback
  // directory. Recover that durable workspace transaction before SQLite gets a
  // chance to interpret the missing live path as a brand-new empty database.
  appDataIo.recoverInterruptedImport({ getDbPath: db.getDbPath })
  return startup.openDatabaseWithRecovery({
    db,
    dialog,
    shell,
    isSmokeTest,
    autoResetIncompatibleDb,
  })
}

/**
 * Window smoke mode: prove the real window renders. A main-process-only smoke
 * test cannot see load failures, preload errors, renderer crashes, or scripts
 * that throw on startup — all of which leave the user with a dead window.
 */
function runWindowSmokeTest(win) {
  // createWindow already watches for load, preload and renderer failures, and
  // did so before the load started. Read what it collected rather than
  // attaching a second set of listeners after the fact and hoping to be in time.
  const failures = windowFailures
  const settleDelayMs =
    Number(process.env.CONDITION_ASSESSMENT_SMOKE_SETTLE_MS) || 2_000
  let finished = false

  const finish = (extraFailure) => {
    if (extraFailure) failures.push(extraFailure)
    if (finished) return
    finished = true
    clearTimeout(timer)
    for (const failure of failures) {
      console.error(`Window smoke test failure: ${failure}`)
    }
    if (failures.length === 0) {
      console.log('Packaged window loaded cleanly.')
    }
    db.closeDatabase()
    app.exit(failures.length === 0 ? 0 : 1)
  }

  const timer = setTimeout(() => {
    finish('timed out waiting for the window to finish loading')
  }, 60_000)

  // A dead renderer will never report did-finish-load; stop now instead of
  // waiting out the timeout.
  onWindowFailure = (fatal) => {
    if (fatal) finish()
  }

  const contents = win.webContents
  contents.on('console-message', (...args) => {
    const { level, message } = readConsoleMessage(args)
    if (level === 'error') failures.push(`renderer console error: ${message}`)
  })

  contents.once('did-finish-load', () => {
    // Give queued microtasks and DOMContentLoaded handlers a chance to throw
    // before calling the page healthy. The single-instance scenario stretches
    // this so it has a live first instance to launch a second one against.
    setTimeout(() => finish(), settleDelayMs)
  })
}

/**
 * `console-message` changed shape in Electron 36 (positional args -> one event
 * object). Read both so this harness survives an Electron bump.
 */
function readConsoleMessage(args) {
  const [first, second, third] = args
  if (typeof second === 'number') {
    // Electron <= 35: (event, level, message, line, sourceId); level 3 = error.
    return { level: second >= 3 ? 'error' : 'info', message: String(third ?? '') }
  }
  return {
    level: String(first?.level ?? ''),
    message: String(first?.message ?? ''),
  }
}

app.whenReady()
  .then(() => {
    // Squirrel install/update hooks already asked us to quit; do no startup work.
    if (isSquirrelStartupEvent) return

    // A copy that lost the single-instance lock must not touch the database.
    // Interactive: show why, then exit. (Dialog after ready — on Linux, dialogs
    // before ready are stderr-only.) Smoke already exited 1 at module scope; if
    // we still get here, exit 1 again without a dialog.
    if (!hasSingleInstanceLock) {
      if (!isSmokeTest) {
        try {
          dialog.showMessageBoxSync({
            type: 'warning',
            title: 'Already running',
            message: 'Condition Assessment Report Generator is already running',
            detail:
              'Another copy of this app is already open. Close that window before launching a new one.',
            buttons: ['OK'],
            defaultId: 0,
            noLink: true,
          })
        } catch {
          // A dialog we cannot show must not replace the exit we still need to do.
        }
      }
      app.exit(isSmokeTest ? 1 : 0)
      return
    }

    if (!openDatabaseWithRecovery()) {
      app.exit(1)
      return
    }
    ipcHandlers.configureCaptionPersistence({ db, captionService, undoHistory })

    // When .env has OPENROUTER_API_KEY, (re)build the shipped ciphertext so
    // key rotation does not require a manual encrypt step.
    const secretSync = ensureOpenRouterSecretFromEnv()
    if (secretSync.written) {
      console.log('OpenRouter secret package refreshed from .env')
    } else if (secretSync.error) {
      console.warn('OpenRouter secret sync failed:', secretSync.error)
    }

    // AI is on by default: load the wrapped key into session memory (no unlock UI).
    const sessionLoad = captionService.ensureSessionKey()
    if (sessionLoad.ok && sessionLoad.attempted) {
      console.log('AI session key loaded')
    } else if (!sessionLoad.ok && sessionLoad.attempted) {
      console.warn('AI session key load failed:', sessionLoad.error)
    }

    if (isSmokeTest && !isWindowSmokeTest) {
      db.closeDatabase()
      app.quit()
      return
    }

    ensureLinuxDesktopIntegration()
    buildApplicationMenu()
    const win = createWindow()

    if (isWindowSmokeTest) {
      runWindowSmokeTest(win)
      return
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
    startupComplete = true
  })
  .catch(reportFatalStartupError)

app.on('before-quit', (event) => {
  if (busyTaskLabel()) {
    event.preventDefault()
    return
  }
  appQuitRequested = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
