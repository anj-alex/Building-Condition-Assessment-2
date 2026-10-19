const assert = require('node:assert/strict')
const test = require('node:test')

const {
  encryptSecret,
  decryptSecret,
  isSecretPackage,
  getAppWrapSecret,
} = require('../src/ai/secret-crypto')
const {
  sanitizeCaption,
  formatOpenRouterCredits,
  formatOpenRouterKeyLimitRemaining,
} = require('../src/ai/openrouter-client')
const { parseEnvLine } = require('../src/lib/load-env')
const {
  OPENROUTER_KEY_URL,
  OPENROUTER_CREDITS_URL,
} = require('../src/ai/openrouter-config')

test('encrypt/decrypt round-trip with password', () => {
  const plaintext = 'sk-or-v1-test-key-example'
  const password = 'correct horse battery staple'
  const pkg = encryptSecret(plaintext, password)
  assert.equal(isSecretPackage(pkg), true)
  assert.equal(decryptSecret(pkg, password), plaintext)
})

test('app wrap secret round-trip (shipped packaging path)', () => {
  const plaintext = 'sk-or-v1-test-key-example'
  const wrap = getAppWrapSecret()
  assert.ok(wrap.length > 8)
  assert.doesNotMatch(wrap, /sk-or-v1/)
  const pkg = encryptSecret(plaintext, wrap)
  assert.equal(decryptSecret(pkg, wrap), plaintext)
})

test('wrong password fails closed', () => {
  const pkg = encryptSecret('secret-value', 'right-password')
  assert.throws(() => decryptSecret(pkg, 'wrong-password'), /Incorrect password/)
})

test('sanitizeCaption strips quotes and excess whitespace', () => {
  assert.equal(sanitizeCaption('  "Spalled concrete wall"  '), 'Spalled concrete wall')
  assert.equal(sanitizeCaption("line1\nline2"), 'line1 line2')
})

test('formatOpenRouterCredits formats amounts; null is empty not unlimited', () => {
  assert.equal(formatOpenRouterCredits(null), '—')
  assert.equal(formatOpenRouterCredits(undefined), '—')
  assert.match(formatOpenRouterCredits(12.5), /\$12\.50/)
  assert.match(formatOpenRouterCredits(0.12345), /\$0\.1235|\$0\.1234/)
})

test('formatOpenRouterKeyLimitRemaining distinguishes no cap from remaining', () => {
  assert.equal(formatOpenRouterKeyLimitRemaining(null, null), 'No key limit')
  assert.equal(formatOpenRouterKeyLimitRemaining(undefined, 10), 'No key limit')
  assert.match(formatOpenRouterKeyLimitRemaining(100, 45.5), /\$45\.50/)
})

test('OpenRouter key and credits URLs are absolute https', () => {
  assert.match(OPENROUTER_KEY_URL, /^https:\/\/openrouter\.ai\/api\/v1\/key$/)
  assert.match(OPENROUTER_CREDITS_URL, /^https:\/\/openrouter\.ai\/settings\/credits$/)
})

test('parseEnvLine handles comments, quotes, and plain values', () => {
  assert.equal(parseEnvLine('# comment'), null)
  assert.deepEqual(parseEnvLine('OPENROUTER_API_KEY=sk-or-v1-example'), {
    key: 'OPENROUTER_API_KEY',
    value: 'sk-or-v1-example',
  })
  assert.deepEqual(parseEnvLine("OPENROUTER_VISION_MODEL='google/gemma-4-26b-a4b-it'"), {
    key: 'OPENROUTER_VISION_MODEL',
    value: 'google/gemma-4-26b-a4b-it',
  })
  assert.deepEqual(parseEnvLine('OPENROUTER_SUMMARY_MODEL=deepseek/deepseek-v4-pro'), {
    key: 'OPENROUTER_SUMMARY_MODEL',
    value: 'deepseek/deepseek-v4-pro',
  })
})

test('ensureOpenRouterSecretFromEnv writes and stays in sync', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const {
    ensureOpenRouterSecretFromEnv,
  } = require('../src/ai/sync-openrouter-secret')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'or-secret-'))
  const secretPath = path.join(dir, 'openrouter-secret.json')
  const prevKey = process.env.OPENROUTER_API_KEY
  try {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test-sync-key'

    const first = ensureOpenRouterSecretFromEnv({ secretPath })
    assert.equal(first.ok, true)
    assert.equal(first.written, true)
    assert.equal(fs.existsSync(secretPath), true)
    assert.equal(
      decryptSecret(JSON.parse(fs.readFileSync(secretPath, 'utf8')), getAppWrapSecret()),
      'sk-or-v1-test-sync-key',
    )

    const second = ensureOpenRouterSecretFromEnv({ secretPath })
    assert.equal(second.ok, true)
    assert.equal(second.written, false)
    assert.equal(second.reason, 'already in sync')

    process.env.OPENROUTER_API_KEY = 'sk-or-v1-rotated-key'
    const third = ensureOpenRouterSecretFromEnv({ secretPath })
    assert.equal(third.ok, true)
    assert.equal(third.written, true)
    assert.equal(
      decryptSecret(JSON.parse(fs.readFileSync(secretPath, 'utf8')), getAppWrapSecret()),
      'sk-or-v1-rotated-key',
    )
  } finally {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = prevKey
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureOpenRouterSecretFromEnv reports missing env without writing', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const {
    ensureOpenRouterSecretFromEnv,
  } = require('../src/ai/sync-openrouter-secret')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'or-secret-'))
  const secretPath = path.join(dir, 'openrouter-secret.json')
  const prevKey = process.env.OPENROUTER_API_KEY
  try {
    delete process.env.OPENROUTER_API_KEY
    const result = ensureOpenRouterSecretFromEnv({ secretPath })
    assert.equal(result.ok, false)
    assert.equal(result.written, false)
    assert.equal(result.reason, 'OPENROUTER_API_KEY not set')
    assert.equal(fs.existsSync(secretPath), false)
  } finally {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = prevKey
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
