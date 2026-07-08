#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/.agent-hook-logs"
LOG_FILE="$LOG_DIR/reinstall-extension-$(date +%Y%m%d-%H%M%S).log"
VSIX="$ROOT/finesse-html.vsix"

mkdir -p "$LOG_DIR"

HOOK_INPUT="$(cat || true)"
STOP_HOOK_ACTIVE=0
if printf '%s' "$HOOK_INPUT" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  STOP_HOOK_ACTIVE=1
fi

json_string() {
  node -e 'const fs = require("fs"); process.stdout.write(JSON.stringify(fs.readFileSync(0, "utf8")));'
}

json_success() {
  local msg
  msg="$(printf '%s' "Finesse extension built, packaged, and installed into available VS Code-family hosts. Reload the Cursor/VS Code window to use the newly installed extension host.")"
  printf '{"continue":true,"suppressOutput":false,"systemMessage":%s}\n' "$(printf '%s' "$msg" | json_string)"
}

json_failure() {
  local msg
  msg="Auto reinstall failed. Inspect $LOG_FILE and fix the issue before finishing."
  if [ "$STOP_HOOK_ACTIVE" -eq 1 ]; then
    printf '{"continue":true,"suppressOutput":true,"systemMessage":%s}\n' "$(printf '%s' "$msg" | json_string)"
  else
    printf '{"decision":"block","reason":%s}\n' "$(printf '%s' "$msg" | json_string)"
  fi
}

{
  echo "== Finesse extension reinstall hook =="
  date
  echo "root: $ROOT"
  echo
  echo "+ npm run build"
  npm run build
  echo
  echo "+ npm run package"
  npm run package
  echo
  installed=0
  for cli in code cursor; do
    if ! command -v "$cli" >/dev/null 2>&1; then
      echo "- $cli not found; skipping"
      continue
    fi
    echo "+ $cli --install-extension $VSIX --force"
    "$cli" --install-extension "$VSIX" --force
    installed=$((installed + 1))
    echo
    echo "Installed extensions matching finesse in $cli:"
    "$cli" --list-extensions | grep -iE 'finesse|peter-suggate' || true
    echo
  done
  if [ "$installed" -eq 0 ]; then
    echo "No supported VS Code-family CLI found. Expected one of: code, cursor."
    exit 1
  fi
} >"$LOG_FILE" 2>&1

status=$?
if [ "$status" -eq 0 ]; then
  json_success
else
  json_failure
fi
