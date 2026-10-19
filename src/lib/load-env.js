/**
 * Minimal .env loader (no dotenv dependency).
 * Only sets keys that are not already present in process.env.
 * Does not override empty-string intentional unsets once set.
 */

const fs = require('node:fs')
const path = require('node:path')

function parseEnvLine(line) {
  const trimmed = String(line ?? '').trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  const eq = trimmed.indexOf('=')
  if (eq <= 0) return null
  const key = trimmed.slice(0, eq).trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null
  let value = trimmed.slice(eq + 1).trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  }
  return { key, value }
}

/**
 * @param {string} [envPath] absolute path; default project-root .env
 * @returns {number} number of keys applied
 */
function loadProjectEnv(envPath = path.join(__dirname, '..', '..', '.env')) {
  if (!fs.existsSync(envPath)) return 0
  let applied = 0
  const text = fs.readFileSync(envPath, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(line)
    if (!parsed) continue
    if (Object.prototype.hasOwnProperty.call(process.env, parsed.key)) continue
    process.env[parsed.key] = parsed.value
    applied += 1
  }
  return applied
}

module.exports = {
  loadProjectEnv,
  parseEnvLine,
}
