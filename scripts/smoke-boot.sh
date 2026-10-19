#!/usr/bin/env bash
# Headless main-process boot check for the DEV app (no window).
#
# The non-window smoke path (CONDITION_ASSESSMENT_SMOKE_TEST=1 without
# CONDITION_ASSESSMENT_SMOKE_WINDOW) loads every main-process module, registers
# the IPC handlers, opens the database, configures caption persistence, syncs
# the OpenRouter secret, loads the session key, then quits. That exercises the
# whole module-load + startup path — enough to catch a broken require, a throw
# in a module body, or a startup wiring regression — without needing a display.
#
# It does NOT create a window or build the menu (headless ozone segfaults on
# window creation), so it is a boot check, not a UI check. Use verify:ui for UI.
#
#   scripts/smoke-boot.sh        # exit 0 = booted cleanly
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
electron_bin="$(node -e "console.log(require('electron'))")"
tmp_ud="$(mktemp -d)"
trap 'rm -rf "$tmp_ud"' EXIT

cd "$repo_root"
CONDITION_ASSESSMENT_SMOKE_TEST=1 \
CONDITION_ASSESSMENT_USER_DATA="$tmp_ud" \
  "$electron_bin" . --ozone-platform=headless --no-sandbox --disable-gpu
