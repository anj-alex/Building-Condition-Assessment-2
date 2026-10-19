/**
 * Intercept require('electron') so main-process modules that call
 * app.getPath('userData') work under ELECTRON_RUN_AS_NODE=1 (where the
 * real electron package is just a binary path string).
 *
 * Require this helper *before* any module that pulls in electron.
 * userDataPath is mutable so each test can point at a fresh temp dir.
 */
const Module = require('node:module')

let userDataPath = null
// Default to the packaged shape so tests exercise release behaviour (no
// dummy-data seeding) unless they opt out.
let isPackaged = true
// Default to no OS keychain so modules that probe the stub do not throw
// because safeStorage is absent. Enable it only in tests that need it.
let safeStorageEncryptionAvailable = false
let nativeImageFactory = () => ({ isEmpty: () => true })
const originalLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      app: {
        get isPackaged() {
          return isPackaged
        },
        getPath(name) {
          if (name !== 'userData') {
            throw new Error(`electron-stub: unsupported getPath(${name})`)
          }
          return userDataPath
        },
      },
      safeStorage: {
        isEncryptionAvailable() {
          return safeStorageEncryptionAvailable
        },
        encryptString() {
          throw new Error('electron-stub: safeStorage.encryptString is not implemented')
        },
        decryptString() {
          throw new Error('electron-stub: safeStorage.decryptString is not implemented')
        },
      },
      // Enough of the window + image surface for main-process modules that
      // broadcast to renderers or decode images (e.g. the caption service).
      // No real windows exist under the test runner, so broadcasts no-op.
      BrowserWindow: {
        getAllWindows: () => [],
      },
      nativeImage: {
        // Tests that need decoded pixels install a local adapter below. The
        // default models Electron failing to decode an unreadable image.
        createFromPath: (filePath) => nativeImageFactory(filePath),
        createFromBuffer: (buffer) =>
          nativeImageFactory({ kind: 'buffer', buffer }),
        createFromBitmap: (buffer, options) =>
          nativeImageFactory({ kind: 'bitmap', buffer, options }),
      },
    }
  }
  return originalLoad.call(this, request, ...rest)
}

module.exports = {
  setUserDataPath(dir) {
    userDataPath = dir
  },
  setIsPackaged(value) {
    isPackaged = Boolean(value)
  },
  setSafeStorageEncryptionAvailable(value) {
    safeStorageEncryptionAvailable = Boolean(value)
  },
  setNativeImageFactory(factory) {
    nativeImageFactory =
      typeof factory === 'function' ? factory : () => ({ isEmpty: () => true })
  },
}
