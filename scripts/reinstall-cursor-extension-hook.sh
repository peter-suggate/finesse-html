#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/.agent-hook-logs"
LOG_FILE="$LOG_DIR/reinstall-cursor-extension-$(date +%Y%m%d-%H%M%S).log"
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
  msg="$(printf '%s' "Finesse extension built, packaged, and installed into Cursor.")"
  printf '{"continue":true,"suppressOutput":true,"systemMessage":%s}\n' "$(printf '%s' "$msg" | json_string)"
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
  echo "== Finesse Cursor reinstall hook =="
  date
  echo "root: $ROOT"
  echo
  echo "+ npm run build"
  npm run build
  echo
  echo "+ npm run package"
  npm run package
  echo
  echo "+ cursor --install-extension $VSIX --force"
  cursor --install-extension "$VSIX" --force
  echo
  echo "Installed extensions matching finesse:"
  cursor --list-extensions | grep -iE 'finesse|peter-suggate' || true
} >"$LOG_FILE" 2>&1

status=$?
if [ "$status" -eq 0 ]; then
  json_success
else
  json_failure
fi
