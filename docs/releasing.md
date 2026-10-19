# Releasing

Releases are built and published by `.github/workflows/release-windows.yml` (**Release Desktop**). It is `workflow_dispatch` only — as is every workflow in this repo, none of which run themselves (see AGENTS.md; `test/workflows-manual-only.test.js` enforces it). Nothing releases on push. Run it from **Actions → Release Desktop → Run workflow**, or:

```bash
gh workflow run "Release Desktop" --ref main
```

Inputs, all optional: `tag` (defaults to `v{package.json version}`), `draft`, `prerelease`.

## Pre-release gate: Verify Desktop must be green first

**Dispatch `.github/workflows/verify-desktop.yml` (Verify Desktop) on the release commit and wait for both legs to come back green before running Release Desktop.** Neither workflow starts the other — both are `workflow_dispatch` only. Release Desktop's first, cheap job queries Actions and refuses to proceed unless a successful manual Verify Desktop run has the exact same `head_sha`; policy alone is not the gate.

Verify Desktop is the non-publishing proof that the product builds, packages, installs, and drives a real window on Windows and Linux. Release Desktop runs the same real Windows checks (`test:packaged`, `test:installed`), but only inside the run that *publishes* a GitHub Release and uploads to Azure — so without Verify Desktop the first place a Windows regression surfaces is a shipped build. It uploads only logs and screenshots (`out/verify-desktop/**`, 3-day retention); it never creates a release or uploads an installer.

```bash
gh workflow run verify-desktop.yml --ref main
gh run watch
```

Not done until **both** the Windows and Linux legs are green. Only then run Release Desktop.

## Job graph

```
verify-gate ──> test ──> build (matrix: Windows, Linux) ──┬──> release
                                                          └──> azure-upload
```

| Job | Runner | Does |
|---|---|---|
| `verify-gate` | ubuntu-24.04 | Requires a successful manual Verify Desktop run whose `head_sha` exactly equals the release commit |
| `test` | ubuntu-24.04 | `npm ci` + `npm test` |
| `build` | windows-2022 / ubuntu-24.04 | package → smoke test → `make` → smoke test installer (Windows) → upload artifact |
| `release` | ubuntu-24.04 | Downloads both artifacts, resolves the tag, publishes a GitHub Release via `softprops/action-gh-release@v2` |
| `azure-upload` | ubuntu-24.04 | Mirrors the same files to a private Azure Blob container under `<tag>/<basename>` |

`fail-fast: false` on the build matrix, so a Windows failure still yields a Linux result to look at. Windows is pinned to `windows-2022` because `@electron/node-gyp` 10.2 does not support VS 2026.

Build commands and the packaged/installed smoke suites are documented in [dev-environment](dev-environment.md) — CI runs the same scripts, with `xvfb-run` on Linux for the window scenarios.

Artifacts per release: `*.Setup.exe`, `*-full.nupkg`, and `RELEASES` (Squirrel, from `@electron-forge/maker-squirrel`), plus `*-linux-x64-*.zip` (`@electron-forge/maker-zip`). Basenames are unique across makers, which is what lets `azure-upload` flatten both artifact directories into one blob prefix.

The only released application is the Report Generator. Temporary Shares and the Share Viewer are retired; Release Desktop does not build, embed, or publish them. See [temporary-shares-retired](temporary-shares-retired.md).

`prepackage` / `premake` still wrap `OPENROUTER_API_KEY` into `src/ai/openrouter-secret.json` under the app wrap secret (see [ai-photo-labels](ai-photo-labels.md)). A missing key is a packaging failure in `--strict` mode, not a silent downgrade of AI.

## Bump the version with the change, not with the release

**Squirrel only updates clients on a version *increase*.** Shipping a fix without bumping `version` in `package.json` leaves existing installs on the old build no matter how many times the workflow runs. The default tag is derived from that same field, so bumping it also names the release.

Because of that, the bump belongs in the commit that makes the user-visible change — a behaviour fix, a schema migration, an export or report change — not in a separate step at release time. A bump is cheap, publishes nothing, and starts no workflow; it just keeps every commit shippable. Leaving it until later is how a fix ends up finished, merged, and still unreachable by the person who reported it.

**Releasing is the opposite: only on an explicit request.** Do not dispatch Release Desktop — or Verify Desktop — on your own initiative. Both bill runner minutes on a private repo, the Windows leg at 2×, and a release is a decision about what reaches a client, not a build step.

## Repository setting: workflow permissions

**Settings → Actions → General → Workflow permissions must be "Read and write".**

This is a hard ceiling on `GITHUB_TOKEN` that overrides the workflow file. The workflow declares `permissions: contents: write`, and that is necessary but not sufficient — with the repository set to read-only, the `release` job fails on both create and update:

```
⚠️ GitHub release failed with status: 403
{"message":"Resource not accessible by integration", ...}
```

Two things make this hard to diagnose, and both are why it is written down here:

- **The runner log looks correct.** Its `GITHUB_TOKEN Permissions` group prints `Contents: write` — that group reports what the workflow *requested*, not what was granted. There is no log line anywhere showing the ceiling being applied.
- **Re-running the failed job does not pick up the fix.** The token is minted when the run is first created, so a corrected setting only reaches a brand-new run. Fixing the setting and hitting "Re-run failed jobs" reproduces the same 403 and makes the correct fix look wrong.

Confirm the repo side independently of any workflow run:

```bash
gh api repos/{owner}/{repo}/actions/permissions/workflow
# want: {"default_workflow_permissions":"write", ...}
```

Job-level `permissions:` blocks still narrow *below* the ceiling — `azure-upload` pins itself to `contents: read`.

## Artifact retention and the Actions storage quota

The build jobs upload `out/make/**/*` purely so `release` and `azure-upload` can download it again. That is ~460 MB per run (Windows ~311 MB, Linux ~131 MB), and GitHub's default artifact retention is **90 days**, so nine runs consumed the account's entire 2 GB included Actions storage.

The upload step therefore sets `retention-days: 1` — GitHub's minimum, and still far longer than a job-to-job handoff needs. Nothing durable is lost: once `release` and `azure-upload` finish, the same bytes live on the GitHub Release and in Azure.

If storage fills anyway:

```bash
# What is actually consuming it
gh api repos/{owner}/{repo}/actions/artifacts --paginate \
  --jq '.artifacts[] | [.id, .name, .size_in_bytes, .expires_at, .workflow_run.id] | @tsv'

# Delete one
gh api -X DELETE repos/{owner}/{repo}/actions/artifacts/<id>
```

**Deleting GitHub Releases does not free Actions storage.** They are separate buckets — the Actions storage meter counts workflow artifacts and logs only. Release assets can stay forever without affecting it.

## Actions minutes and job timeouts

The other metered resource, and the easier one to waste. This repo is private,
so minutes bill; **Windows runners bill at 2x wall clock**, Linux at 1x. A
Verify Desktop dispatch costs about 19 billed minutes (Windows 7 x 2, Linux 5).

Every job carries an explicit `timeout-minutes`, and the steps that can hang on
the network or on a wedged app carry their own. This matters because GitHub's
default when none is set is **360 minutes** — on Windows that is 720 billed
minutes, over a third of a 2,000-minute month, spent by one stuck job with no
failure to show for it. The caps are ~3x measured runtimes, not round numbers:

```bash
# What a job actually spent, per step
gh api repos/{owner}/{repo}/actions/runs/<run-id>/jobs \
  --jq '.jobs[] | {job: .name} + {steps: [.steps[]
        | {n: .name, s: (((.completed_at|fromdate) - (.started_at|fromdate)))}]}'
```

`test/workflows-time-bounded.test.js` fails if a job has no cap, if one is left
above 30 minutes, or if a hang-prone step has none — so re-introducing the
360-minute default is a failing unit test rather than a surprise on a bill.

Inside `verify:ui` the scenarios carry their own budget so a hang is named
before any of these fire; see [ui-driver.md](ui-driver.md#time-bounds).

## Distribution channels

**GitHub Release** — public-facing artifacts on the tag, with `generate_release_notes: true`. `target_commitish` is the commit the workflow ran on.

**Azure Blob Storage** — the same files mirrored to a *private* container, for handing out expiring download links. Infrastructure (storage account, container, role assignments, Actions secrets `AZURE_STORAGE_ACCOUNT` / `AZURE_STORAGE_CONTAINER` / `AZURE_STORAGE_KEY`) is provisioned by Terraform in `terraform/`. The workflow authenticates with the account key rather than Entra ID / OIDC because the deploying account is on a school tenant that blocks member app registrations.

Generate links for a release:

```bash
scripts/azure-release-links.sh              # latest tag, 7-day link
scripts/azure-release-links.sh v1.0.3       # specific tag
```

It defaults to a **user delegation SAS** signed from the current `az login` session, which Azure caps at 7 days. `--account-key` switches to a service SAS signed with the storage account key for longer-lived links; the key is fetched transiently and never written to disk. See the script header for the full flag list.

## Recovering a partly-failed run

The build artifacts outlive a failed `release` job (for `retention-days`, so act the same day). Options, cheapest first:

1. **Fix the cause and start a new run.** Required whenever the fix is a permission or settings change, per the re-run caveat above.
2. **Re-run failed jobs** — valid only for genuinely transient failures, since it reuses the original artifacts *and* the original token grant.
3. **Publish by hand** with `gh run download <run-id>` and `gh release create`, when CI cannot be made to work and the build itself is good.

A release created by hand and a later workflow run can disagree about `target_commitish`: a tag ref cannot move once pushed, but `softprops/action-gh-release` updates the release's target. Check `git ls-remote --tags origin` for the authoritative commit.
