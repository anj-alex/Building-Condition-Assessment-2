// The desktop app's named renderer IPC surface, built in page scope over the
// generic preload bridge (`window.appBridge` from src/preload.js).
//
// Renderer code talks to `window.electronAPI`, a named method per channel.
// src/renderer-api.js builds that object here via createIpcSurface.
// This file is loaded as a plain script because a sandboxed preload cannot
// require siblings.
//
// `transport.on` implementations strip Electron's event object before the
// listener runs, so subscriptions here read exactly like the invokes.

function createIpcSurface(transport) {
  if (
    !transport ||
    typeof transport.invoke !== 'function' ||
    typeof transport.on !== 'function'
  ) {
    throw new TypeError(
      'createIpcSurface needs a transport with invoke(channel, ...args) and on(channel, listener).',
    )
  }
  const { invoke, on } = transport

  return {
    getAppVersion: () => invoke('app:getVersion'),
    getAppInfo: () => invoke('app:getInfo'),
    completeCloseRequest: (requestId, result) =>
      invoke('app:close-response', requestId, result),
    onCloseRequested: (callback) => on('app:close-requested', callback),
    getAiStatus: () => invoke('ai:getStatus'),
    getAiUsage: () => invoke('ai:getUsage'),
    previewBlankFields: () => invoke('ai:previewBlankFields'),
    generateBlankFields: () => invoke('ai:generateBlankFields'),
    setAiBulkBusy: (busy) => invoke('ai:setBulkBusy', busy),
    updateImageCaption: (kind, imageId, caption) =>
      invoke('db:updateImageCaption', kind, imageId, caption),
    updateImageBoundingBoxes: (kind, imageId, boxes) =>
      invoke('db:updateImageBoundingBoxes', kind, imageId, boxes),
    updateAssetImageIncludeInReport: (imageId, includeInReport) =>
      invoke('db:updateAssetImageIncludeInReport', imageId, includeInReport),
    regenerateImageCaption: (kind, imageId) =>
      invoke('ai:regenerateCaption', kind, imageId),
    generateExecutiveSummarySection: (buildingId, field) =>
      invoke('ai:generateExecutiveSummarySection', buildingId, field),
    onCaptionUpdated: (callback) => on('ai:caption-updated', callback),
    onSummaryUpdated: (callback) => on('ai:summary-updated', callback),
    // Reading a workbook and committing its rows both block the main process, so
    // it announces each phase and the home page owns the screen while it runs.
    onImportPhase: (callback) => on('bca:import-phase', callback),
    // Building the Word-backed preview can block for minutes on a large report;
    // the report page names each phase rather than showing one frozen label.
    onExportPhase: (callback) => on('report:export-phase', callback),
    openProjectSetup: (projectId) =>
      projectId == null
        ? invoke('project-setup:open')
        : invoke('project-setup:edit', projectId),
    openFirmSetup: () => invoke('firm-setup:open'),
    openSettings: () => invoke('settings:open'),
    getUniformatPricingCsvPath: () => invoke('uniformat-pricing:getCsvPath'),
    reloadUniformatPricingFromDisk: () => invoke('uniformat-pricing:reloadFromDisk'),
    chooseUniformatPricingCsv: () => invoke('uniformat-pricing:chooseCsv'),
    showUniformatPricingCsvInFolder: () => invoke('uniformat-pricing:showInFolder'),
    exportAppData: () => invoke('app-data:export'),
    importAppData: () => invoke('app-data:import'),
    openBuildingInfo: (projectId) => invoke('building-info:open', projectId),
    editBuildingInfo: (projectId, buildingId) =>
      invoke('building-info:edit', projectId, buildingId),
    editExecutiveSummary: (projectId, buildingId) =>
      invoke('executive-summary:edit', projectId, buildingId),
    openPropertyReport: (projectId, buildingIds) =>
      invoke('property-report:open', projectId, buildingIds),
    preparePropertyReport: (projectId, buildingIds) =>
      invoke('property-report:prepare', projectId, buildingIds),
    chooseReportExportPath: (suggestedName) =>
      invoke('property-report:chooseExportPath', suggestedName),
    exportPropertyReport: (previewId, exportId, options) =>
      invoke('property-report:export', previewId, exportId, options ?? {}),
    setReportExportBusy: (busy) => invoke('report:setExportBusy', busy),
    importBcaWorkbook: (projectId) => invoke('bca:import', projectId),
    goHome: (opts) => invoke('navigate:home', opts ?? {}),
    ensureDatabaseCurrent: () => invoke('db:ensureCurrent'),
    listProjects: () => invoke('db:listProjects'),
    listDeletedProjects: () => invoke('db:listDeletedProjects'),
    restoreDeletedProject: (projectId) => invoke('db:restoreDeletedProject', projectId),
    getProject: (projectId) => invoke('db:getProject', projectId),
    getFirm: () => invoke('db:getFirm'),
    updateFirm: (payload) => invoke('db:updateFirm', payload),
    importFirmLogo: () => invoke('firm-logo:import'),
    listBuildings: (projectId) => invoke('db:listBuildings', projectId),
    listUniformatLevel1Groups: () => invoke('db:listUniformatLevel1Groups'),
    listUniformatLevel2Groups: (level1GroupName) =>
      invoke('db:listUniformatLevel2Groups', level1GroupName),
    listUniformatLevel3Groups: (level1GroupName, level2Code) =>
      invoke('db:listUniformatLevel3Groups', level1GroupName, level2Code),
    listUniformatLevel4Groups: (level1GroupName, level2Code, level3Code) =>
      invoke('db:listUniformatLevel4Groups', level1GroupName, level2Code, level3Code),
    listUniformatPricingItems: (level1GroupName, level2Code, level3Code, level4Code) =>
      invoke(
        'db:listUniformatPricingItems',
        level1GroupName,
        level2Code,
        level3Code,
        level4Code,
      ),
    getBuilding: (buildingId) => invoke('db:getBuilding', buildingId),
    createBuilding: (payload) => invoke('db:createBuilding', payload),
    updateBuilding: (buildingId, payload) =>
      invoke('db:updateBuilding', buildingId, payload),
    listLocationFactors: () => invoke('db:listLocationFactors'),
    previewAssetPlan: (assetId, formValues) =>
      invoke('db:previewAssetPlan', assetId, formValues),
    getExecutiveSummary: (buildingId) => invoke('db:getExecutiveSummary', buildingId),
    updateExecutiveSummary: (buildingId, payload) =>
      invoke('db:updateExecutiveSummary', buildingId, payload),
    getPropertyReportData: (projectId, buildingId) =>
      invoke('db:getPropertyReportData', projectId, buildingId),
    listBuildingImages: (buildingId) => invoke('db:listBuildingImages', buildingId),
    importPropertyImages: (buildingId) => invoke('property-images:import', buildingId),
    listAssets: (buildingId, level1GroupName) =>
      invoke('db:listAssets', buildingId, level1GroupName),
    createAsset: (buildingId, level1GroupName) =>
      invoke('db:createAsset', buildingId, level1GroupName),
    updateAsset: (assetId, payload) => invoke('db:updateAsset', assetId, payload),
    listAssetImages: (assetId) => invoke('db:listAssetImages', assetId),
    importAssetImages: (assetId) => invoke('asset-images:import', assetId),
    createProject: (payload) => invoke('db:createProject', payload),
    updateProject: (projectId, payload) => invoke('db:updateProject', projectId, payload),
    deleteProject: (projectId) => invoke('db:deleteProject', projectId),
    deleteBuilding: (buildingId) => invoke('db:deleteBuilding', buildingId),
    deleteAsset: (assetId) => invoke('db:deleteAsset', assetId),
    deleteBuildingImage: (imageId) => invoke('db:deleteBuildingImage', imageId),
    deleteAssetImage: (imageId) => invoke('db:deleteAssetImage', imageId),
    deleteExecutiveSummary: (buildingId) =>
      invoke('db:deleteExecutiveSummary', buildingId),
    removeFirmLogo: () => invoke('firm-logo:remove'),
    undoLastAction: () => invoke('history:undo'),
    redoLastAction: () => invoke('history:redo'),
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createIpcSurface }
}
