// Builds the renderer's named `window.electronAPI` over the allowlisted
// `window.appBridge` preload transport (src/preload.js + src/ipc-surface.js).
//
// Every page loads this shim after ipc-surface.js and before shared.js.
// Renderer code talks to `window.electronAPI`, never to the bridge.
//
// A no-op where there is no bridge (the page-scripts harness loads pages
// bare) or a surface already exists; loud where the markup forgot
// ipc-surface.js, because that page has no IPC at all and silence would look
// like empty data.
if (typeof window !== 'undefined' && !window.electronAPI && window.appBridge) {
  if (typeof createIpcSurface !== 'function') {
    throw new Error('renderer-api.js must load after src/ipc-surface.js.')
  }
  window.electronAPI = createIpcSurface(window.appBridge)
}
