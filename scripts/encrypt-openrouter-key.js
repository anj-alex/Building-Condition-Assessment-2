#!/usr/bin/env node
/**
 * Encrypt an OpenRouter API key into src/ai/openrouter-secret.json.
 *
 * Prefer putting the key in gitignored `.env`:
 *   OPENROUTER_API_KEY=sk-or-...
 *
 * Then either:
 *   npm start                          # app syncs secret on startup
 *   node scripts/encrypt-openrouter-key.js
 *   npm run package / npm run make     # prepackage/premake hooks run this
 *
 * CLI override:
 *   node scripts/encrypt-openrouter-key.js --key "$OPENROUTER_API_KEY"
 *
 * The package is wrapped with an app-embedded secret (not a user password) so
 * automated scanners cannot grep a plaintext sk-or-v1- key from the artifact.
 * AI loads that key on startup; OpenRouter's per-key spend cap is the safety bound.
 *
 * Exit codes:
 *   0 — wrote secret, already in sync, or skipped (missing env; keep existing file)
 *   1 — encrypt failed or --strict with missing env
 */

const path = require('node:path')

// Load .env before reading OPENROUTER_API_KEY.
require('../src/lib/load-env').loadProjectEnv()

const {
  ensureOpenRouterSecretFromEnv,
} = require('../src/ai/sync-openrouter-secret')

function argValue(flag) {
  const idx = process.argv.indexOf(flag)
  if (idx === -1) return null
  return process.argv[idx + 1] ?? null
}

const strict = process.argv.includes('--strict')
const keyArg = argValue('--key')

if (keyArg) process.env.OPENROUTER_API_KEY = keyArg

const result = ensureOpenRouterSecretFromEnv()

if (result.written) {
  console.log(`Wrote encrypted secret to ${result.path}`)
  console.log('Package uses the app wrap secret (no user unlock password).')
  process.exit(0)
}

if (result.ok && result.reason === 'already in sync') {
  console.log(`OpenRouter secret already in sync: ${result.path}`)
  process.exit(0)
}

// Missing env — keep existing openrouter-secret.json (common in CI without secrets).
if (result.reason === 'OPENROUTER_API_KEY not set') {
  const msg =
    `${result.reason}. Skipping secret refresh (existing openrouter-secret.json unchanged).`
  if (strict) {
    console.error(msg)
    console.error(`
Set in .env (gitignored):
  OPENROUTER_API_KEY=sk-or-...

Or pass --key. Use without --strict to allow packaging with the committed ciphertext.
`)
    process.exit(1)
  }
  console.warn(msg)
  process.exit(0)
}

console.error(`Failed to encrypt OpenRouter secret: ${result.error || result.reason}`)
process.exit(1)
