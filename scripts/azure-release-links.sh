#!/usr/bin/env bash
#
# azure-release-links.sh
# ----------------------
# Print an expiring download (SAS) link for every file the Release Desktop
# workflow uploaded to Azure Blob Storage for a given release tag, so you can
# paste them to your users. The blob container is private, so a link without a
# valid SAS token cannot download anything.
#
# SAS signing modes
# -----------------
# Default: USER DELEGATION SAS. Signed with a key derived from the current
#   `az login` user's Entra ID session. No storage account key is ever touched.
#   Azure caps this at 7 days, so --days is clamped to 7 in this mode
#   (the documented hard limit). Terraform grants the deploying user
#   "Storage Blob Data Contributor" on the storage account, which is what lets
#   this script list blobs and request user-delegation keys.
#
# --account-key: SERVICE SAS signed with the storage account key. Supports
#   arbitrary-length --days (useful when you want a longer-lived link). The key
#   is fetched transiently via `az storage account keys list` and kept only in
#   an in-memory env var for the duration of the script; nothing is written to
#   disk. Requires the caller to have `listKeys` permission on the storage
#   account (Subscription Owner and Storage Account Contributor both have it).
#
# Usage:
#   scripts/azure-release-links.sh                          # latest tag, 7-day link
#   scripts/azure-release-links.sh v1.0.2                   # specific tag
#   scripts/azure-release-links.sh v1.0.2 --days 30 --account-key   # >7d needs --account-key
#   scripts/azure-release-links.sh v1.0.2 --exact '*.exe' --open
#
# Configuration (storage account + container) is discovered automatically, in
# this order, and the first hit wins:
#   1. env vars AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_CONTAINER
#   2. `terraform output -raw ...` from ../terraform (where terraform apply ran)
#   3. error out with a message telling you what to set
#
# Requires: Azure CLI (az), core functionality only (no extra extensions).

set -euo pipefail

DEFAULT_DAYS=7
USER_DELEGATION_MAX_DAYS=7
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TERRAFORM_DIR="$REPO_ROOT/terraform"

DAYS="$DEFAULT_DAYS"
ACCOUNT_KEY_MODE=false
OPEN=false
TAG=""
EXACT=""

usage() {
  cat <<EOF
Usage: $0 [tag] [--days N] [--account-key] [--open] [--exact GLOB]

  tag                Release tag (e.g. v1.0.2). Omit to auto-detect the latest
                     tag found in the Blob container.
  --days N           SAS token validity in days (default: ${DEFAULT_DAYS}).
                     With the default user-delegation mode this is clamped to
                     ${USER_DELEGATION_MAX_DAYS} (Azure's hard limit); use
                     --account-key for longer.
  --account-key      Sign links with the storage account key (Service SAS)
                     instead of user delegation, lifting the 7-day cap.
  --open             Open each generated link in the default browser.
  --exact GLOB       Only emit links whose file name matches this glob
                     (e.g. '*.exe' or 'Condition*Setup*.exe'). Default: emit all.

Config (first match wins):
  env: AZURE_STORAGE_ACCOUNT, AZURE_STORAGE_CONTAINER
  or:  terraform outputs in ${TERRAFORM_DIR}
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --days)        DAYS="$2"; shift 2;;
    --account-key) ACCOUNT_KEY_MODE=true; shift;;
    --open)        OPEN=true; shift;;
    --exact)       EXACT="$2"; shift 2;;
    -h|--help)     usage; exit 0;;
    --*)           echo "Unknown option: $1" >&2; usage >&2; exit 2;;
    *)             TAG="$1"; shift;;
  esac
done

if ! [[ "$DAYS" =~ ^[0-9]+$ ]] || [ "$DAYS" -lt 1 ]; then
  echo "Invalid --days value: $DAYS (must be a positive integer)" >&2
  exit 2
fi

# Clamp user-delegation SAS to Azure's 7-day max. In account-key mode, allow any.
if [ "$ACCOUNT_KEY_MODE" = false ] && [ "$DAYS" -gt "$USER_DELEGATION_MAX_DAYS" ]; then
  echo "Note: user-delegation SAS is capped at ${USER_DELEGATION_MAX_DAYS} days by Azure." >&2
  echo "      Clamping --days ${DAYS} -> ${USER_DELEGATION_MAX_DAYS}. Pass --account-key for longer links." >&2
  DAYS="$USER_DELEGATION_MAX_DAYS"
fi

command -v az >/dev/null 2>&1 || {
  echo "azure-cli not found. Install: https://aka.ms/installazurecliLinux" >&2
  exit 1
}

# User delegation SAS requires an interactive Entra ID user (the signing key is
# derived from that session). Account-key mode just needs management-plane
# access to listKeys, which any ARM-authenticated principal has.
if ! az account show >/dev/null 2>&1; then
  echo "Not logged in. Run: az login" >&2
  exit 1
fi
if [ "$ACCOUNT_KEY_MODE" = false ]; then
  user_type="$(az account show --query user.type -o tsv 2>/dev/null || echo user)"
  if [ "$user_type" != "user" ]; then
    echo "User delegation SAS requires an interactive 'az login' with your Entra ID user." >&2
    echo "Current login is a service principal. Re-run after 'az login', or use --account-key." >&2
    exit 1
  fi
fi

# ---- Resolve storage account + container ------------------------------------

ACCOUNT="${AZURE_STORAGE_ACCOUNT:-}"
CONTAINER="${AZURE_STORAGE_CONTAINER:-}"

# Fill any gap from terraform outputs (no subshell — uses terraform -chdir).
if [ -z "$ACCOUNT" ] || [ -z "$CONTAINER" ]; then
  if [ -d "$TERRAFORM_DIR" ] && command -v terraform >/dev/null 2>&1; then
    if [ -z "$ACCOUNT" ]; then
      ACCOUNT="$(terraform -chdir="$TERRAFORM_DIR" output -raw storage_account_name 2>/dev/null || true)"
    fi
    if [ -z "$CONTAINER" ]; then
      CONTAINER="$(terraform -chdir="$TERRAFORM_DIR" output -raw storage_container_name 2>/dev/null || true)"
    fi
  fi
fi

if [ -z "$ACCOUNT" ] || [ -z "$CONTAINER" ]; then
  {
    echo "Could not determine storage account/container."
    echo "Either run terraform apply in ${TERRAFORM_DIR}, or export:"
    echo "  export AZURE_STORAGE_ACCOUNT=..."
    echo "  export AZURE_STORAGE_CONTAINER=..."
  } >&2
  exit 1
fi

# ---- Resolve tag ------------------------------------------------------------

# List blobs using the caller's identity (user-delegation mode: --auth-mode
# login; account-key mode: AZURE_STORAGE_KEY env populated below).
list_blobs() {
  local args=(--account-name "$ACCOUNT" --container-name "$CONTAINER")
  if [ "$ACCOUNT_KEY_MODE" = false ]; then
    args+=(--auth-mode login)
  fi
  az storage blob list "${args[@]}" --query "[].name" -o tsv
}

if [ -z "$TAG" ]; then
  echo "No tag given; auto-detecting latest tag in container '${CONTAINER}'..." >&2
  # Blobs are stored as "<tag>/<file>". Take unique tag prefixes (the part before
  # the first '/'), sort by version, keep the greatest.
  TAG="$(list_blobs | awk -F/ 'NF>1{print $1}' | sort -uV | tail -n1 || true)"
  if [ -z "$TAG" ]; then
    echo "No blobs found in container '${CONTAINER}'. Did the release workflow run?" >&2
    exit 1
  fi
  echo "Latest tag detected: ${TAG}" >&2
fi

# ---- (account-key mode only) fetch the storage account key into env ----------

if [ "$ACCOUNT_KEY_MODE" = true ]; then
  rg="$(az storage account show --name "$ACCOUNT" --query resourceGroup -o tsv 2>/dev/null || true)"
  if [ -z "$rg" ]; then
    echo "Could not resolve the resource group for storage account '${ACCOUNT}'." >&2
    echo "Check that the account name is correct and that you are logged in." >&2
    exit 1
  fi
  # az storage commands honor AZURE_STORAGE_KEY. Keeping it in an env var avoids
  # passing the key as a visible CLI argument in the process table.
  # shellcheck disable=SC2155
  export AZURE_STORAGE_KEY="$(az storage account keys list \
    --resource-group "$rg" \
    --account-name "$ACCOUNT" \
    --query "keys[0].value" -o tsv)"
fi

# ---- List blobs for this tag ------------------------------------------------

results="$(list_blobs | awk -v prefix="${TAG}/" 'index($0, prefix)==1 {print substr($0, length(prefix)+1)}')"
if [ -z "$results" ]; then
  echo "No blobs found under prefix '${TAG}/' in container '${CONTAINER}'." >&2
  echo "(Account-key mode can suppress permission errors silently — if you expected blobs here, try without --account-key, or check RBAC.)" >&2
  exit 1
fi

mapfile -t BLOBS <<< "$results"

# Filter by --exact glob if requested.
if [ -n "$EXACT" ]; then
  FILTERED=()
  for b in "${BLOBS[@]}"; do
    # shellcheck disable=SC2254
    case "$b" in
      $EXACT) FILTERED+=("$b");;
    esac
  done
  if [ "${#FILTERED[@]}" -eq 0 ]; then
    echo "No blobs matched glob '${EXACT}' under '${TAG}/'." >&2
    exit 1
  fi
  BLOBS=("${FILTERED[@]}")
fi

# ---- Mint SAS links ---------------------------------------------------------

START=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EXPIRY=$(date -u -d "+${DAYS} days" +"%Y-%m-%dT%H:%M:%SZ")

signing_mode_desc="user-delegation"
if [ "$ACCOUNT_KEY_MODE" = true ]; then signing_mode_desc="account-key service SAS"; fi

echo "Account      : ${ACCOUNT}" >&2
echo "Container    : ${CONTAINER}" >&2
echo "Tag          : ${TAG}" >&2
echo "Links        : ${#BLOBS[@]} file(s)" >&2
echo "Valid from   : ${START}" >&2
echo "Valid until  : ${EXPIRY}" >&2
echo "Signing mode : ${signing_mode_desc}" >&2
echo >&2

LINKS=()
for blob in "${BLOBS[@]}"; do
  # URL-encode reserved chars in the file path (slashes stay literal — valid in a
  # blob path). Spaces are common in Electron installer names, e.g.
  # "Condition Assessment Report Generator_1.0.2.zip".
  encoded="$(printf '%s' "$blob" \
    | sed 's/ /%20/g; s/"/%22/g; s/#/%23/g; s/?/%3F/g; s/+/%2B/g')"

  gen_args=(--account-name "$ACCOUNT" --container-name "$CONTAINER"
            --name "${TAG}/${blob}" --permissions r --expiry "$EXPIRY" --https-only -o tsv)
  if [ "$ACCOUNT_KEY_MODE" = false ]; then
    gen_args+=(--auth-mode login --as-user)
  fi
  sas="$(az storage blob generate-sas "${gen_args[@]}")"

  link="https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/${TAG}/${encoded}?${sas}"
  LINKS+=("$link")
  echo "$blob"
  echo "  $link"
  echo
done

# Scrub any transient secret from the environment before exiting.
unset AZURE_STORAGE_KEY || true

if [ "$OPEN" = true ]; then
  for link in "${LINKS[@]}"; do
    if command -v xdg-open >/dev/null 2>&1; then xdg-open "$link" >/dev/null 2>&1 || true
    elif command -v open >/dev/null 2>&1;       then open      "$link" >/dev/null 2>&1 || true
    fi
  done
fi