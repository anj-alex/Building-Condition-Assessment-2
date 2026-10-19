const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

// Linux desktop integration: install a user-level `.desktop` entry + hicolor
// icon so Wayland (app_id) / X11 (WM_CLASS) shells show our icon instead of the
// generic Electron one. Kept dependency-injected so the file-writing path can be
// exercised against a temp $HOME without booting Electron.

/**
 * Quote one `Exec=` argument for a freedesktop `.desktop` file.
 * @param {string} arg
 */
function quoteDesktopExecArg(arg) {
  if (!/[\s"$`\\]/.test(arg)) return arg
  return `"${String(arg).replace(/(["`\\$])/g, '\\$1')}"`
}

/**
 * The full `.desktop` file contents for the given app id and Exec line.
 * @param {{ appDesktopId: string, execLine: string }} opts
 */
function buildDesktopEntry({ appDesktopId, execLine }) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Condition Assessment Report Generator',
    'Comment=Building condition assessment reports',
    `Exec=${execLine}`,
    `Icon=${appDesktopId}`,
    'Terminal=false',
    'Categories=Office;Utility;',
    // Must match app.setDesktopName / Wayland app_id (no .desktop suffix).
    `StartupWMClass=${appDesktopId}`,
    '',
  ].join('\n')
}

/**
 * Install the `.desktop` entry and icon. No-op outside Linux, in smoke tests, or
 * when the source icon is missing. Best-effort: filesystem or cache-refresh
 * failures are logged, never thrown.
 *
 * @returns {{ installed: boolean, reason?: string, desktopPath?: string, iconPath?: string }}
 */
function ensureLinuxDesktopIntegration({
  platform = process.platform,
  isSmokeTest = false,
  homeDir = os.homedir(),
  iconSrc,
  appDesktopId,
  isPackaged,
  execPath = process.execPath,
  appPath,
  spawnFn = spawn,
  log = console,
} = {}) {
  if (platform !== 'linux' || isSmokeTest) return { installed: false, reason: 'skipped' }
  if (!iconSrc || !fs.existsSync(iconSrc)) return { installed: false, reason: 'no-icon' }

  const iconDir = path.join(homeDir, '.local', 'share', 'icons', 'hicolor', '512x512', 'apps')
  const appsDir = path.join(homeDir, '.local', 'share', 'applications')
  const iconDest = path.join(iconDir, `${appDesktopId}.png`)
  const desktopDest = path.join(appsDir, `${appDesktopId}.desktop`)

  try {
    fs.mkdirSync(iconDir, { recursive: true })
    fs.mkdirSync(appsDir, { recursive: true })
    fs.copyFileSync(iconSrc, iconDest)
  } catch (err) {
    log.warn('Linux desktop icon install failed:', err?.message ?? err)
    return { installed: false, reason: 'icon-copy-failed' }
  }

  // Packaged: run the binary. Dev (forge / electron .): electron + app path.
  const execArgs = isPackaged ? [execPath] : [execPath, appPath]
  const execLine = execArgs.map(quoteDesktopExecArg).join(' ')

  try {
    fs.writeFileSync(desktopDest, buildDesktopEntry({ appDesktopId, execLine }), 'utf8')
  } catch (err) {
    log.warn('Linux .desktop install failed:', err?.message ?? err)
    return { installed: false, reason: 'desktop-write-failed' }
  }

  // Best-effort cache refresh so the new icon is picked up without a restart.
  // A missing helper (common on headless CI, where update-desktop-database is
  // not installed) surfaces asynchronously as an 'error' event on the child, not
  // as a synchronous throw — so a surrounding try/catch cannot see it, and an
  // 'error' event with no listener is rethrown by Node as an uncaught exception
  // that would crash the whole app. Attach a no-op 'error' listener to every
  // child, and keep the try/catch only for the rare synchronous spawn failure.
  const refreshCache = (command, commandArgs) => {
    try {
      const child = spawnFn(command, commandArgs, { stdio: 'ignore', detached: true })
      child.on?.('error', () => {}) // Optional helper; ENOENT is expected and fine.
      child.unref?.()
    } catch (err) {
      log.warn(`Linux desktop cache refresh (${command}) failed:`, err?.message ?? err)
    }
  }
  refreshCache('update-desktop-database', [appsDir])
  refreshCache('gtk-update-icon-cache', [
    '-f',
    '-t',
    path.join(homeDir, '.local', 'share', 'icons', 'hicolor'),
  ])

  return { installed: true, desktopPath: desktopDest, iconPath: iconDest }
}

module.exports = {
  quoteDesktopExecArg,
  buildDesktopEntry,
  ensureLinuxDesktopIntegration,
}
