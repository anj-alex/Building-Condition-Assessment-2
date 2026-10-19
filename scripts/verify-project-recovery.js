/**
 * Verify the Settings deleted-project recovery card in a real Electron window.
 *
 * The native delete-confirmation dialog is outside renderer CDP, so setup
 * soft-deletes a seeded project through the same main-process DB wrapper the
 * delete handler uses. The recovery action itself is driven through Settings.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { repoRoot, runScenario } = require('./ui-driver')

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cara-project-recovery-ui-'))
const dbModulePath = path.join(repoRoot, 'src', 'db.js')

async function sendHistoryShortcut(page, { redo = false } = {}) {
  const modifiers = redo ? 10 : 2 // Ctrl+Shift or Ctrl
  await page.key('z', 90, { code: 'KeyZ', modifiers })
}

runScenario(
  'project-recovery',
  { userDataDir },
  async (session, checks) => {
    const home = await session.page('index.html')
    const project = await home.until(
      `(async () => (await window.electronAPI.listProjects())[0] || null)()`,
      'seeded project',
    )
    if (!project?.id) throw new Error('isolated dev database did not seed a project')

    await session.evalInMain(
      `req(${JSON.stringify(dbModulePath)}).deleteProject(${Number(project.id)})`,
    )
    await home.eval('void window.electronAPI.openSettings()')

    const settings = await session.page('settings.html')
    await settings.until(
      `document.querySelector('#deleted-projects-list button')?.textContent === 'Recover'`,
      'deleted-project recovery row',
    )
    checks.check(
      'Settings lists the deleted project profile',
      await settings.eval(`document.querySelector('.settings-deleted-projects-title')?.textContent`),
      String(project.client ?? `Project #${project.id}`),
    )

    await settings.click('#deleted-projects-list button')
    await settings.until(
      `document.getElementById('deleted-projects-status').textContent.startsWith('Recovered')`,
      'recovery completion',
    )
    checks.check(
      'recovered project leaves the Settings list',
      await settings.eval(`document.getElementById('deleted-projects-list').textContent.trim()`),
      'No deleted projects to recover.',
    )

    await sendHistoryShortcut(settings)
    await settings.until(
      `document.querySelector('#deleted-projects-list button')?.textContent === 'Recover'`,
      'undo recovery',
    )
    checks.check(
      'undo puts the project back in recovery',
      await settings.eval(`document.querySelector('.settings-deleted-projects-title')?.textContent`),
      String(project.client ?? `Project #${project.id}`),
    )

    await sendHistoryShortcut(settings, { redo: true })
    await settings.until(
      `document.getElementById('deleted-projects-list').textContent.trim() === 'No deleted projects to recover.'`,
      'redo recovery',
    )
    checks.check(
      'redo returns the recovered project to the workspace',
      await settings.eval(`document.getElementById('deleted-projects-list').textContent.trim()`),
      'No deleted projects to recover.',
    )

    await settings.eval('void window.electronAPI.goHome()')
    const recoveredHome = await session.page('index.html')
    checks.check(
      'recovered project returns to the home list',
      await recoveredHome.until(
        `(async () => (await window.electronAPI.listProjects()).some((entry) => entry.id === ${Number(project.id)}) )()`,
        'recovered project on home',
      ),
      true,
    )
  },
)
