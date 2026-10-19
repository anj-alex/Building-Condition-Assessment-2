const assert = require('node:assert/strict')
const test = require('node:test')

const { buildMenuTemplate } = require('../src/main/menu')

const base = {
  version: '1.4.0',
  appName: 'Condition Assessment Report Generator',
  bulkBusy: false,
  platform: 'linux',
  onOpenSettings: () => {},
}

/** All role strings anywhere in the template. */
function roles(template) {
  const found = []
  for (const menu of template) {
    for (const item of menu.submenu ?? []) {
      if (item.role) found.push(item.role)
    }
  }
  return found
}

function labelled(template, label) {
  for (const menu of template) {
    for (const item of menu.submenu ?? []) {
      if (item.label === label) return item
    }
  }
  return null
}

test('the template carries the standard edit and view roles', () => {
  const template = buildMenuTemplate(base)
  const present = new Set(roles(template))
  for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'reload', 'toggleDevTools']) {
    assert.ok(present.has(role), `missing role ${role}`)
  }
  assert.deepEqual(
    template.map((m) => m.label),
    ['File', 'Edit', 'View', 'Help'],
  )
})

test('the Help menu shows the version from app.getVersion()', () => {
  const template = buildMenuTemplate({ ...base, version: '9.9.9' })
  assert.ok(labelled(template, 'Version 9.9.9'))
})

test('bulk-AI busy disables navigation, reload, and quit but never copy/paste', () => {
  const template = buildMenuTemplate({ ...base, bulkBusy: true })
  const settings = labelled(template, 'Settings…')
  assert.equal(settings.enabled, false)

  const disabledRoles = new Set()
  const alwaysOn = new Set()
  for (const menu of template) {
    for (const item of menu.submenu ?? []) {
      if (!item.role) continue
      if (item.enabled === false) disabledRoles.add(item.role)
      if (item.enabled === undefined) alwaysOn.add(item.role)
    }
  }
  assert.ok(disabledRoles.has('reload'))
  assert.ok(disabledRoles.has('undo'))
  assert.ok(disabledRoles.has('quit'))
  // Clipboard actions stay available so the user is not trapped.
  assert.ok(alwaysOn.has('copy'))
  assert.ok(alwaysOn.has('paste'))
})

test('not busy leaves reload and quit enabled', () => {
  const template = buildMenuTemplate({ ...base, bulkBusy: false })
  for (const menu of template) {
    for (const item of menu.submenu ?? []) {
      if (['reload', 'quit', 'undo'].includes(item.role)) {
        assert.notEqual(item.enabled, false)
      }
    }
  }
})

test('the click handlers open Settings', () => {
  let opened = 0
  const template = buildMenuTemplate({ ...base, onOpenSettings: () => { opened += 1 } })
  labelled(template, 'Settings…').click()
  labelled(template, 'About / debug info…').click()
  assert.equal(opened, 2)
})

test('macOS gains an application menu titled by app.getName()', () => {
  const template = buildMenuTemplate({ ...base, platform: 'darwin' })
  assert.equal(template[0].label, 'Condition Assessment Report Generator')
  assert.equal(template.length, 5)
  // File closes rather than quits on darwin.
  const file = template.find((m) => m.label === 'File')
  assert.ok(file.submenu.some((i) => i.role === 'close'))
})
