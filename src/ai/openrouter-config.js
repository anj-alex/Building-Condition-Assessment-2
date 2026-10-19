/**
 * OpenRouter AI settings.
 *
 * Vision (photo captions): OPENROUTER_VISION_MODEL env / .env
 * Executive summaries: OPENROUTER_SUMMARY_MODEL env / .env
 *
 * Local .env (gitignored):
 *   OPENROUTER_API_KEY — plaintext key; used only to build ciphertext
 *
 * Ciphertext ships as src/ai/openrouter-secret.json (see sync-openrouter-secret.js).
 * It is refreshed automatically on app start and before package/make when
 * OPENROUTER_API_KEY is set. The package is wrapped with an app-embedded secret
 * (not a user password) so scanners cannot grep the raw key; AI loads on startup.
 * Spend safety is the OpenRouter per-key cap, not a session unlock gate.
 */

const path = require('node:path')

/**
 * Resolve a model slug from env, or the default when unset/empty.
 * @param {string|undefined|null} envValue
 * @param {string} fallback
 */
function resolveModel(envValue, fallback) {
  if (typeof envValue === 'string' && envValue.trim()) return envValue.trim()
  return fallback
}

/** @type {string} Vision model for photo captions (must support image inputs). */
const VISION_MODEL = resolveModel(
  process.env.OPENROUTER_VISION_MODEL,
  'google/gemma-4-26b-a4b-it',
)

/**
 * @type {string} Text model for executive summary writing.
 * DeepSeek V4 Pro on OpenRouter (`deepseek/deepseek-v4-pro`).
 */
const SUMMARY_MODEL = resolveModel(
  process.env.OPENROUTER_SUMMARY_MODEL,
  'deepseek/deepseek-v4-pro',
)

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions'
/** Key metadata + usage / remaining credits for the current API key. */
const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key'
/** Account credits purchase page (opened in the system browser). */
const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/settings/credits'

const SECRET_PATH = path.join(__dirname, 'openrouter-secret.json')

/** Optional app attribution headers (OpenRouter leaderboards). */
const APP_HTTP_REFERER = 'https://github.com/KianBahasadri/condition-assesment-report-generator'
const APP_TITLE = 'Condition Assessment Report Generator'

/** Max long edge when resizing with Electron nativeImage before upload. */
const IMAGE_MAX_EDGE = 1280
const IMAGE_JPEG_QUALITY = 80

/** Caption generation limits. */
const CAPTION_MAX_TOKENS = 80
const CAPTION_TEMPERATURE = 0.2

/**
 * OpenRouter free-model variants (`:free`) are capped at 20 RPM.
 * Paid models have no platform RPM; allow a larger concurrent pool and
 * rely on Retry-After handling for provider throttling.
 * @see https://openrouter.ai/docs/api-reference/limits
 */
const isFreeVisionModel = String(VISION_MODEL || '').endsWith(':free')
/** Max in-flight caption HTTP requests. */
const CAPTION_MAX_CONCURRENT = isFreeVisionModel ? 1 : 20
/** Min spacing between free-model caption starts (20 RPM → ≥3s). */
const CAPTION_FREE_MIN_INTERVAL_MS = isFreeVisionModel ? 3100 : 0

/**
 * Executive summary generation limits.
 *
 * `SUMMARY_MAX_TOKENS` is a safety bound, not a target. OpenRouter counts a
 * reasoning model's thinking tokens against `max_tokens`, and the summary model
 * reasons before it writes: measured traces run 212–2,161 tokens against ~300
 * tokens of actual prose. The old budget of 700 was smaller than the trace, so
 * the model spent the whole allowance thinking and returned no content at all —
 * `finish_reason: "length"` with an empty message.
 *
 * 16,384 is the largest value every provider serving the summary model can
 * honour (the smallest advertised `max_completion_tokens` is DeepInfra's 16,384),
 * so it buys ~7x headroom over the worst observed trace without shrinking the
 * provider pool we rely on for failover. Larger values trade providers away, and
 * near the context ceiling OpenRouter rejects the request outright because the
 * prompt and the output budget share the context window.
 */
const SUMMARY_MAX_TOKENS = 16384
const SUMMARY_TEMPERATURE = 0.3

/**
 * Per-request wall-clock cap. `max_tokens` bounds how much a runaway generation
 * can cost, but nothing bounded how long a stalled connection could hold the UI:
 * the summary field stays read-only and bulk fill blocks navigation until every
 * job settles. Summaries observed at 11–16s, captions well under that.
 */
const OPENROUTER_REQUEST_TIMEOUT_MS = 120_000

const isFreeSummaryModel = String(SUMMARY_MODEL || '').endsWith(':free')
/** Max in-flight executive-summary HTTP requests. */
const SUMMARY_MAX_CONCURRENT = isFreeSummaryModel ? 1 : 20
/** Min spacing between free-model summary starts (20 RPM → ≥3s). */
const SUMMARY_FREE_MIN_INTERVAL_MS = isFreeSummaryModel ? 3100 : 0

module.exports = {
  VISION_MODEL,
  SUMMARY_MODEL,
  OPENROUTER_API_URL,
  OPENROUTER_KEY_URL,
  OPENROUTER_CREDITS_URL,
  SECRET_PATH,
  APP_HTTP_REFERER,
  APP_TITLE,
  IMAGE_MAX_EDGE,
  IMAGE_JPEG_QUALITY,
  OPENROUTER_REQUEST_TIMEOUT_MS,
  CAPTION_MAX_TOKENS,
  CAPTION_TEMPERATURE,
  isFreeVisionModel,
  CAPTION_MAX_CONCURRENT,
  CAPTION_FREE_MIN_INTERVAL_MS,
  SUMMARY_MAX_TOKENS,
  SUMMARY_TEMPERATURE,
  isFreeSummaryModel,
  SUMMARY_MAX_CONCURRENT,
  SUMMARY_FREE_MIN_INTERVAL_MS,
}
