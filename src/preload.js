const { contextBridge, ipcRenderer } = require('electron')

// A sandboxed preload cannot require sibling files, so the channel names are
// duplicated from src/ipc-surface.js and locked together by ipc-surface.test.
// The renderer still sees only invoke/subscribe; arbitrary Electron channels
// cannot be reached through that generic-looking transport.
const INVOKE_CHANNELS = new Set([
  'app:getVersion',
  'app:getInfo',
  'app:close-response',
  'ai:getStatus',
  'ai:getUsage',
  'ai:previewBlankFields',
  'ai:generateBlankFields',
  'ai:setBulkBusy',
  'db:updateImageCaption',
  'db:updateImageBoundingBoxes',
  'db:updateAssetImageIncludeInReport',
  'ai:regenerateCaption',
  'ai:generateExecutiveSummarySection',
  'project-setup:open',
  'project-setup:edit',
  'firm-setup:open',
  'settings:open',
  'uniformat-pricing:getCsvPath',
  'uniformat-pricing:reloadFromDisk',
  'uniformat-pricing:chooseCsv',
  'uniformat-pricing:showInFolder',
  'app-data:export',
  'app-data:import',
  'building-info:open',
  'building-info:edit',
  'executive-summary:edit',
  'property-report:open',
  'property-report:prepare',
  'property-report:chooseExportPath',
  'property-report:export',
  'report:setExportBusy',
  'bca:import',
  'navigate:home',
  'db:ensureCurrent',
  'db:listProjects',
  'db:listDeletedProjects',
  'db:restoreDeletedProject',
  'db:getProject',
  'db:getFirm',
  'db:updateFirm',
  'firm-logo:import',
  'db:listBuildings',
  'db:listUniformatLevel1Groups',
  'db:listUniformatLevel2Groups',
  'db:listUniformatLevel3Groups',
  'db:listUniformatLevel4Groups',
  'db:listUniformatPricingItems',
  'db:getBuilding',
  'db:createBuilding',
  'db:updateBuilding',
  'db:listLocationFactors',
  'db:previewAssetPlan',
  'db:getExecutiveSummary',
  'db:updateExecutiveSummary',
  'db:getPropertyReportData',
  'db:listBuildingImages',
  'property-images:import',
  'db:listAssets',
  'db:createAsset',
  'db:updateAsset',
  'db:listAssetImages',
  'asset-images:import',
  'db:createProject',
  'db:updateProject',
  'db:deleteProject',
  'db:deleteBuilding',
  'db:deleteAsset',
  'db:deleteBuildingImage',
  'db:deleteAssetImage',
  'db:deleteExecutiveSummary',
  'firm-logo:remove',
  'history:undo',
  'history:redo',
])

const SUBSCRIBE_CHANNELS = new Set([
  'app:close-requested',
  'ai:caption-updated',
  'ai:summary-updated',
  'bca:import-phase',
  'report:export-phase',
])

function assertAllowedChannel(channel, allowlist, operation) {
  if (typeof channel !== 'string' || channel.length === 0) {
    throw new TypeError('channel must be a non-empty string.')
  }
  if (!allowlist.has(channel)) {
    throw new Error(`Blocked renderer ${operation} channel: ${channel}`)
  }
}

/**
 * Wrap a listener so the renderer never sees Electron's event object — it
 * carries `sender` and `ports`, and handing a page a reference to the IPC
 * sender would undo the point of contextIsolation.
 */
function subscribe(channel, listener) {
  assertAllowedChannel(channel, SUBSCRIBE_CHANNELS, 'subscription')
  if (typeof listener !== 'function') return () => {}
  const handler = (_event, ...args) => listener(...args)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('appBridge', {
  invoke: (channel, ...args) => {
    try {
      assertAllowedChannel(channel, INVOKE_CHANNELS, 'invoke')
    } catch (error) {
      return Promise.reject(error)
    }
    return ipcRenderer.invoke(channel, ...args)
  },
  on: subscribe,
})
