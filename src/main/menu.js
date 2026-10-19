// The application menu as a pure template builder. Returning the template
// (rather than calling Menu.setApplicationMenu here) lets tests assert its
// structure — roles, the version label, and what the bulk-AI lock disables —
// without an Electron Menu.

/**
 * Build the application-menu template.
 *
 * @param {object} opts
 * @param {string} opts.version         app.getVersion()
 * @param {string} opts.appName         app.getName() (macOS app menu label)
 * @param {boolean} opts.bulkBusy       true while bulk AI generation owns the UI
 * @param {string} opts.platform        process.platform
 * @param {() => void} opts.onOpenSettings  click handler for Settings / About
 * @returns {import('electron').MenuItemConstructorOptions[]}
 */
function buildMenuTemplate({ version, appName, bulkBusy, platform, onOpenSettings }) {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          enabled: !bulkBusy,
          click: () => onOpenSettings(),
        },
        { type: 'separator' },
        platform === 'darwin'
          ? { role: 'close', enabled: !bulkBusy }
          : { role: 'quit', enabled: !bulkBusy },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', enabled: !bulkBusy },
        { role: 'redo', enabled: !bulkBusy },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', enabled: !bulkBusy },
        { role: 'forceReload', enabled: !bulkBusy },
        { role: 'toggleDevTools', enabled: !bulkBusy },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: `Version ${version}`,
          enabled: false,
        },
        {
          label: 'About / debug info…',
          enabled: !bulkBusy,
          click: () => onOpenSettings(),
        },
      ],
    },
  ]

  if (platform === 'darwin') {
    template.unshift({
      label: appName,
      submenu: [
        {
          label: `Version ${version}`,
          enabled: false,
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', enabled: !bulkBusy },
      ],
    })
  }

  return template
}

module.exports = { buildMenuTemplate }
