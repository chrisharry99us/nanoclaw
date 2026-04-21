#!/usr/bin/env bash
#
# NanoClaw — scripted end-to-end install.
#
# Phase 1: bootstrap (Node + pnpm + native module verify). Runs bash-side
# since tsx isn't available until pnpm install completes.
# Phase 2: setup:auto (all remaining steps under clack).
#
# Both phases obey the same three-level output contract (see
# docs/setup-flow.md):
#   1. User-facing       — concise status line with elapsed time
#   2. Progression log   — logs/setup.log (header + one entry per phase/step)
#   3. Raw per-step log  — logs/setup-steps/NN-name.log (full verbatim output)
#
# Config via env — passed through unchanged:
#   NANOCLAW_SKIP  comma-separated setup:auto step names to skip
#   SECRET_NAME    OneCLI secret name (default: Anthropic)
#   HOST_PATTERN   OneCLI host pattern (default: api.anthropic.com)

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

LOGS_DIR="$PROJECT_ROOT/logs"
STEPS_DIR="$LOGS_DIR/setup-steps"
PROGRESS_LOG="$LOGS_DIR/setup.log"

# ─── log helpers ────────────────────────────────────────────────────────

ts_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

write_header() {
  local ts
  ts=$(ts_utc)
  local branch commit
  branch=$(git branch --show-current 2>/dev/null || echo unknown)
  commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
  {
    echo "## ${ts} · setup:auto started"
    echo "  invocation: nanoclaw.sh"
    echo "  user: $(whoami)"
    echo "  cwd: ${PROJECT_ROOT}"
    echo "  branch: ${branch}"
    echo "  commit: ${commit}"
    echo ""
  } > "$PROGRESS_LOG"
}

# grep_field FIELD FILE — first value of FIELD: from a status block.
grep_field() {
  grep "^$1:" "$2" 2>/dev/null | head -1 | sed "s/^$1: *//" || true
}

write_bootstrap_entry() {
  local status=$1 dur=$2 raw=$3
  local ts
  ts=$(ts_utc)
  local platform is_wsl node_version deps_ok native_ok has_build_tools
  platform=$(grep_field PLATFORM "$raw")
  is_wsl=$(grep_field IS_WSL "$raw")
  node_version=$(grep_field NODE_VERSION "$raw" | head -1)
  deps_ok=$(grep_field DEPS_OK "$raw")
  native_ok=$(grep_field NATIVE_OK "$raw")
  has_build_tools=$(grep_field HAS_BUILD_TOOLS "$raw")
  {
    echo "=== [${ts}] bootstrap [${dur}s] → ${status} ==="
    [ -n "$platform" ]        && echo "  platform: ${platform}"
    [ -n "$is_wsl" ]          && echo "  is_wsl: ${is_wsl}"
    [ -n "$node_version" ]    && echo "  node_version: ${node_version}"
    [ -n "$deps_ok" ]         && echo "  deps_ok: ${deps_ok}"
    [ -n "$native_ok" ]       && echo "  native_ok: ${native_ok}"
    [ -n "$has_build_tools" ] && echo "  has_build_tools: ${has_build_tools}"
    # Emit the raw path relative to PROJECT_ROOT so the progression log
     # is portable and matches the TS-side format (logs/setup-steps/NN-…).
    echo "  raw: ${raw#${PROJECT_ROOT}/}"
    echo ""
  } >> "$PROGRESS_LOG"
}

write_abort_entry() {
  local step=$1 error=$2
  local ts
  ts=$(ts_utc)
  echo "## ${ts} · aborted at ${step} (${error})" >> "$PROGRESS_LOG"
}

# ─── bash-side "clack-alike" status line ────────────────────────────────

use_ansi() { [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; }
dim()     { use_ansi && printf '\033[2m%s\033[0m' "$1" || printf '%s' "$1"; }
gray()    { use_ansi && printf '\033[90m%s\033[0m' "$1" || printf '%s' "$1"; }
red()     { use_ansi && printf '\033[31m%s\033[0m' "$1" || printf '%s' "$1"; }
clear_line() { use_ansi && printf '\r\033[2K' || printf '\n'; }

spinner_start()   { printf '%s  %s…' "$(gray '◒')" "$1"; }
spinner_update()  { clear_line; printf '%s  %s… %s' "$(gray '◒')" "$1" "$(dim "(${2}s)")"; }
spinner_success() { clear_line; printf '%s  %s %s\n' "$(gray '◇')" "$1" "$(dim "(${2}s)")"; }
spinner_failure() { clear_line; printf '%s  %s %s\n' "$(red '✗')"  "$1" "$(dim "(${2}s)")"; }

# ─── fresh-run setup ────────────────────────────────────────────────────

rm -rf "$STEPS_DIR"
rm -f  "$PROGRESS_LOG"
mkdir -p "$STEPS_DIR" "$LOGS_DIR"
write_header

cat <<'EOF'
═══════════════════════════════════════════════════════════════
 NanoClaw scripted setup
═══════════════════════════════════════════════════════════════

Phase 1 · bootstrap

EOF

# ─── phase 1: bootstrap ─────────────────────────────────────────────────

BOOTSTRAP_RAW="${STEPS_DIR}/01-bootstrap.log"
BOOTSTRAP_LABEL="Bootstrapping Node, pnpm, native modules"
BOOTSTRAP_START=$(date +%s)

spinner_start "$BOOTSTRAP_LABEL"

# Run in the background so we can tick elapsed time. Capture exit code via
# a tmpfile (subshell $? is lost after the while loop finishes).
BOOTSTRAP_EXIT_FILE=$(mktemp -t nanoclaw-bootstrap-exit.XXXXXX)
(
  # setup.sh's legacy `log()` writes to a file; point it at the raw log
  # so its verbose entries land alongside the stdout we're capturing.
  export NANOCLAW_BOOTSTRAP_LOG="$BOOTSTRAP_RAW"
  if bash setup.sh > "$BOOTSTRAP_RAW" 2>&1; then
    echo 0 > "$BOOTSTRAP_EXIT_FILE"
  else
    echo $? > "$BOOTSTRAP_EXIT_FILE"
  fi
) &
BOOTSTRAP_PID=$!

while kill -0 "$BOOTSTRAP_PID" 2>/dev/null; do
  sleep 1
  if kill -0 "$BOOTSTRAP_PID" 2>/dev/null; then
    spinner_update "$BOOTSTRAP_LABEL" "$(( $(date +%s) - BOOTSTRAP_START ))"
  fi
done
# `wait` surfaces the child's exit code; we've already captured it.
wait "$BOOTSTRAP_PID" 2>/dev/null || true

BOOTSTRAP_RC=$(cat "$BOOTSTRAP_EXIT_FILE")
rm -f "$BOOTSTRAP_EXIT_FILE"
BOOTSTRAP_DUR=$(( $(date +%s) - BOOTSTRAP_START ))

if [ "$BOOTSTRAP_RC" -eq 0 ]; then
  spinner_success "Bootstrap complete" "$BOOTSTRAP_DUR"
  write_bootstrap_entry success "$BOOTSTRAP_DUR" "$BOOTSTRAP_RAW"
else
  spinner_failure "Bootstrap failed" "$BOOTSTRAP_DUR"
  write_bootstrap_entry failed "$BOOTSTRAP_DUR" "$BOOTSTRAP_RAW"
  write_abort_entry bootstrap "exit-${BOOTSTRAP_RC}"

  echo
  echo "$(dim '── last 40 lines of ')$(dim "$BOOTSTRAP_RAW")$(dim ' ──')"
  tail -40 "$BOOTSTRAP_RAW"
  echo
  echo "Full raw log: $BOOTSTRAP_RAW"
  echo "Progression:  $PROGRESS_LOG"
  exit 1
fi

echo
cat <<'EOF'
Phase 2 · setup:auto

EOF

# ─── phase 2: clack driver ──────────────────────────────────────────────

# NANOCLAW_BOOTSTRAPPED=1 tells setup/auto.ts that the progression log has
# already been initialized (header + bootstrap entry), so it should append
# rather than wipe.
export NANOCLAW_BOOTSTRAPPED=1

# exec so signals (Ctrl-C) propagate directly to the child.
exec pnpm run setup:auto
