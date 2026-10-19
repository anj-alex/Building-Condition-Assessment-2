# AI photo labels (OpenRouter vision)

Automatically fill `asset_image.caption` / `building_image.caption` after photo import using a vision model via [OpenRouter](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding).

Executive summary AI writing uses the same session key but a **different** model env var — see [executive-summary](executive-summary.md).

This file covers the desktop app's key handling.

## Decision history: no user unlock password

**What changed.** The app used to gate AI behind a session **AI unlock password** (`AI_UNLOCK_PASSWORD` in `.env`, entered in Settings, optional dev auto-unlock). That gate is **removed**. AI is **on by default** whenever the encrypted key package loads at startup.

**Why.** Spend safety is enforced on the **OpenRouter side** by a developer-set **per-key hard spend limit** (US$10/month on the distributed key). A local password did not add meaningful product security: anyone who had the app could eventually recover a key that must run inside the process anyway, and operators did not need a second secret to manage. The password only created friction (Settings unlock, packaging/env coupling, “is AI locked?” UI).

**What stayed.** The API key is still **not stored in plaintext** in the ship artifact. It remains AES-256-GCM ciphertext in `src/ai/openrouter-secret.json`, wrapped with an **app-embedded wrap secret** (`getAppWrapSecret` in `secret-crypto.js`). That is **anti-scanner packaging**, not access control: automated secret scanners that look for `sk-or-v1-…` patterns will not find the raw key on disk or in the package tree. A determined reverse engineer can recover the wrap secret from the binary — that is accepted; the spend cap and key rotation are the real bounds (see Distributed-key policy).

**Do not reintroduce** a user-facing AI unlock password unless the product model changes (e.g. optional offline AI with a user-supplied key).

## Key packaging model

- The OpenRouter API key is **not** stored in plaintext in the app. Ship an AES-256-GCM package at `src/ai/openrouter-secret.json` (ciphertext only).
- Local **`.env`** (gitignored) holds:
  - `OPENROUTER_API_KEY` — plaintext key used only to build/refresh the ciphertext package
- **Automatic secret sync:** when `OPENROUTER_API_KEY` is set, `ensureOpenRouterSecretFromEnv` (re)writes `openrouter-secret.json` if it is missing or does not decrypt to that key under the app wrap secret. This runs on app startup and via `prepackage` / `premake` (`npm run encrypt-openrouter-key`). Changing the key in `.env` is enough — no manual encrypt step.
- **Startup:** main always calls `ensureSessionKey()` after secret sync. Dev and packaged builds behave the same: if the package is present and valid, the key is in session memory and AI features work.
- Without a configured secret/model, photo import still works; captions stay empty (filename fallback in UI).

### Create / rotate the encrypted secret

Put the key in `.env`, then either start the app or run:

```bash
npm run encrypt-openrouter-key
# equivalent: node scripts/encrypt-openrouter-key.js
```

Optional CLI: `--key`, `--strict` (fail if env missing instead of keeping the existing package).

Do not commit the plaintext key. Ciphertext in `openrouter-secret.json` is what ships in the app.

### Models (separate for vision vs summaries)

Photo captions and executive-summary writing use **different** OpenRouter model slugs:

| Use | Env var | Default |
|-----|---------|---------|
| Photo captions (vision) | `OPENROUTER_VISION_MODEL` | `google/gemma-4-26b-a4b-it` |
| Executive summary text | `OPENROUTER_SUMMARY_MODEL` | `deepseek/deepseek-v4-pro` |

Defaults also live in `src/ai/openrouter-config.js` as `VISION_MODEL` / `SUMMARY_MODEL`. Browse models at https://openrouter.ai/models (vision models must support image inputs).

## Distributed-key policy (hard constraints)

The single key that ships inside `openrouter-secret.json` is a deliberate policy, not an accident of packaging:

- **No OpenRouter _management_ key ever ships**, in any artifact. The app carries only the one runtime API key — which is also why account-level `GET /credits` is not used (see Settings: usage & credits).
- **No user ever opens the OpenRouter dashboard** — not the operator, not an external collaborator. Provisioning, the spending cap, and rotation are all developer-side.
- **The distributed key carries a US$10/month hard limit**, set once by the developer in the OpenRouter dashboard at provisioning. The cap is enforced server-side by OpenRouter; the app does not verify it at runtime. **This is the safety bound** — not a local unlock password.
- **Exhaustion means rotation.** If the key gets maxed out (AI calls failing across the board), the client reports it and the developer rotates: provision a fresh capped key, update `.env`, cut a release with a version bump (see [releasing](releasing.md)). Updated installs and newly built packages carry the new key.
- **AI is included by default** in every install. There is no session password for operators to disclose or withhold.

## Runtime flow

1. Import property/asset photos (existing dialogs).
2. Rows insert immediately with `caption = null`.
3. If the session key is loaded and a vision model is set, main process queues caption jobs and broadcasts their generating state; duplicate jobs for the same image are ignored while one is active.
4. Each job: resize via Electron `nativeImage` → JPEG data URL → `POST https://openrouter.ai/api/v1/chat/completions` with multipart text + `image_url`. At most `CAPTION_MAX_CONCURRENT` jobs call OpenRouter at once (1 + RPM pacing for `:free` models; 20 for paid).
5. On success, `UPDATE … SET caption = ?` and broadcast a finished `ai:caption-updated` event to renderers. Failures and canceled/skipped jobs also emit a terminal event so disabled caption controls are always released.

Every queued job carries the current workspace epoch. The persistence adapter
checks the live `app.db` identity before its starting read, final comparison,
and write. If an out-of-band database replacement is detected, it clears app
history, advances the epoch, and cancels old jobs. Workers recheck the epoch
after each adapter call, so a response generated for an old photo/summary cannot
write to a reused numeric id in the replacement workspace.

## Modules

| Path | Role |
|------|------|
| `src/ai/secret-crypto.js` | scrypt + AES-256-GCM encrypt/decrypt; `getAppWrapSecret` |
| `src/ai/sync-openrouter-secret.js` | rebuild ciphertext from `OPENROUTER_API_KEY` |
| `src/ai/openrouter-config.js` | vision + summary models, endpoints, resize limits |
| `src/ai/openrouter-client.js` | OpenRouter caption + text completion, key usage, prompts |
| `src/ai/caption-service.js` | session key load, usage IPC, caption queue, summary generation |
| `scripts/encrypt-openrouter-key.js` | CLI + npm `prepackage`/`premake` entry for secret sync |

## Settings: usage & credits

When the session key is loaded, **Settings → AI photo labels** shows OpenRouter credit usage:

- Used (all time) and used this month (from `usage` / `usage_monthly` on `GET /api/v1/key`)
- **Monthly limit left** — remaining budget on the key (`limit` / `limit_remaining`); shows “No key limit” when uncapped
- **Refresh usage** re-fetches `GET https://openrouter.ai/api/v1/key`
- **Generate AI for all blank fields** opens a confirm dialog (counts empty captions + summary sections), then a blocking progress modal until every queued job finishes. Captions and summaries use separate concurrency pools (`CAPTION_MAX_CONCURRENT` / `SUMMARY_MAX_CONCURRENT`: 1 + ≥3.1s spacing for `:free` models to stay under the 20 RPM free-model limit; 20 for paid models). Caption and summary HTTP calls also retry once on `429`/`503`; delta-second and HTTP-date `Retry-After` values are honored within the request's one absolute wall-clock deadline. Summary text is written straight to the database. While the progress modal is open, navigation, reload, and quit are disabled.

Usage is only available while the session key is loaded (the key never leaves main-process memory). Account-level `GET /credits` is not used — it requires a management key. Top up at https://openrouter.ai/settings/credits.

## IPC

- `ai:getStatus` — status includes `configured`, `unlocked` (session key loaded), `captionJobs`, `summaryJobs`, `visionModel` / `summaryModel` (and `model` = vision for caption IPC), so a newly rendered gallery can restore its disabled controls
- `ai:getUsage` — live key usage via OpenRouter `GET /api/v1/key` (requires session key); returns `{ ok, usage, limitRemaining, … }` or `{ ok: false, error }`
- `ai:previewBlankFields` — count blank captions (with on-disk files) and blank executive-summary sections; returns `{ ok, captions, summaries, total, missingFiles, … }`
- `ai:generateBlankFields` — enqueue blank photo captions and blank executive-summary sections; returns `{ ok, captionJobs, summaryJobs, captionsQueued, summariesQueued, … }` or `{ ok: false, error }`
- `ai:setBulkBusy` — lock/unlock navigation and quit while the Settings progress modal is active
- `ai:regenerateCaption` — force-regenerate one image (`force: true` enqueue); requires session key + vision model + on-disk file; returns `{ ok, queued }` or `{ ok: false, error }`
- `ai:generateExecutiveSummarySection` — write one executive-summary field from building/asset context; requires session key + summary model; returns `{ ok, text, field, model }` or `{ ok: false, error }` (renderer autosaves the field after fill)
- `db:updateImageCaption`
- `db:updateImageBoundingBoxes` — replace an image's colored box/arrow annotations (`asset_image`/`building_image.bounding_boxes`, stored as image-relative JSON); unrelated to AI
- event `ai:caption-updated` (main → renderer; generating and terminal success/failure states)
- event `ai:summary-updated` (main → renderer; bulk blank-summary jobs)

Removed (do not re-add without revisiting the decision above): `ai:unlock`, `ai:lock`, Settings unlock form, `AI_UNLOCK_PASSWORD`, `AI_AUTO_UNLOCK`.

## Privacy

Photos leave the machine only when the session key is loaded and a caption job runs (OpenRouter + upstream model provider). Executive summary generation sends property/asset text context (not photos) when AI is available.
