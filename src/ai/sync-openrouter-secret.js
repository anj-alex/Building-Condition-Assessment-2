/**
 * Keep src/ai/openrouter-secret.json in sync with .env:
 *   OPENROUTER_API_KEY → encrypted package (app wrap secret)
 *
 * Called on app startup and before package/make. Re-encrypts only when the
 * on-disk package is missing, cannot be decrypted with the app wrap secret, or
 * decrypts to a different key (so changing the key in .env just works).
 *
 * Plaintext key is never written; only ciphertext lands on disk. The wrap is
 * anti-scanner packaging, not a user unlock gate (see secret-crypto.js).
 */

const fs = require('node:fs')
const path = require('node:path')
const {
  encryptSecret,
  decryptSecret,
  isSecretPackage,
  getAppWrapSecret,
} = require('./secret-crypto')
const { SECRET_PATH } = require('./openrouter-config')

/**
 * @returns {string|null}
 */
function getApiKeyFromEnv() {
  const value = process.env.OPENROUTER_API_KEY
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * @param {string} secretPath
 * @returns {object|null}
 */
function readSecretPackage(secretPath) {
  try {
    if (!fs.existsSync(secretPath)) return null
    const raw = JSON.parse(fs.readFileSync(secretPath, 'utf8'))
    return isSecretPackage(raw) ? raw : null
  } catch {
    return null
  }
}

/**
 * Whether the existing package already encrypts `apiKey` under the app wrap secret.
 * @param {string} secretPath
 * @param {string} apiKey
 */
function packageMatches(secretPath, apiKey) {
  const pkg = readSecretPackage(secretPath)
  if (!pkg) return false
  try {
    return decryptSecret(pkg, getAppWrapSecret()) === apiKey
  } catch {
    return false
  }
}

/**
 * Ensure openrouter-secret.json matches OPENROUTER_API_KEY under the app wrap secret.
 *
 * @param {{ secretPath?: string, quiet?: boolean }} [options]
 * @returns {{
 *   ok: boolean,
 *   written: boolean,
 *   reason: string,
 *   path?: string,
 *   error?: string,
 * }}
 */
function ensureOpenRouterSecretFromEnv(options = {}) {
  const secretPath = options.secretPath
    ? path.resolve(options.secretPath)
    : SECRET_PATH
  const apiKey = getApiKeyFromEnv()

  if (!apiKey) {
    return {
      ok: false,
      written: false,
      reason: 'OPENROUTER_API_KEY not set',
    }
  }

  if (packageMatches(secretPath, apiKey)) {
    return {
      ok: true,
      written: false,
      reason: 'already in sync',
      path: secretPath,
    }
  }

  try {
    const pkg = encryptSecret(apiKey, getAppWrapSecret())
    fs.mkdirSync(path.dirname(secretPath), { recursive: true })
    fs.writeFileSync(secretPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    return {
      ok: true,
      written: true,
      reason: 'encrypted from env',
      path: secretPath,
    }
  } catch (err) {
    return {
      ok: false,
      written: false,
      reason: 'encrypt failed',
      path: secretPath,
      error: String(err?.message ?? err),
    }
  }
}

module.exports = {
  getApiKeyFromEnv,
  ensureOpenRouterSecretFromEnv,
  packageMatches,
  readSecretPackage,
}
