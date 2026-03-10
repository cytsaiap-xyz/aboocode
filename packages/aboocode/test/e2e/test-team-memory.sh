#!/usr/bin/env bash
set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────
ABOO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
REPO_ROOT="$(cd "$ABOO_DIR/../.." && pwd)"
USAGE_LOG="${XDG_DATA_HOME:-$HOME/.local/share}/aboocode/usage.log"
MEMORY_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/aboocode/memory"

PASS_COUNT=0
FAIL_COUNT=0

# ─── Helpers ─────────────────────────────────────────────────────────────────
info()  { echo -e "\033[1;34m[INFO]\033[0m  $*"; }
ok()    { echo -e "\033[1;32m[PASS]\033[0m  $*"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail()  { echo -e "\033[1;31m[FAIL]\033[0m  $*"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
header(){ echo ""; echo "═══════════════════════════════════════════════════════════════"; echo "  $*"; echo "═══════════════════════════════════════════════════════════════"; }

check_log() {
  local label="$1"
  local pattern="$2"
  if grep -q "$pattern" "$USAGE_LOG" 2>/dev/null; then
    ok "$label"
  else
    fail "$label — pattern not found: $pattern"
  fi
}

check_log_count() {
  local label="$1"
  local pattern="$2"
  local min_count="$3"
  local actual
  actual=$(grep -c "$pattern" "$USAGE_LOG" 2>/dev/null || echo "0")
  if [ "$actual" -ge "$min_count" ]; then
    ok "$label (found $actual, need >=$min_count)"
  else
    fail "$label (found $actual, need >=$min_count)"
  fi
}

check_file() {
  local label="$1"
  local filepath="$2"
  if [ -f "$filepath" ]; then
    ok "$label"
  else
    fail "$label — file not found: $filepath"
  fi
}

check_no_files() {
  local label="$1"
  local dir="$2"
  local pattern="$3"
  if [ -d "$dir" ]; then
    local count
    count=$(find "$dir" -name "$pattern" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$count" -eq 0 ]; then
      ok "$label"
    else
      fail "$label — found $count matching files in $dir"
    fi
  else
    ok "$label (directory does not exist)"
  fi
}

# ─── Setup ───────────────────────────────────────────────────────────────────
header "Setup"

WORK_DIR=$(mktemp -d)
info "Work directory: $WORK_DIR"
info "Aboocode dir:   $ABOO_DIR"
info "Usage log:      $USAGE_LOG"

# Initialize a git repo in the work dir (aboocode requires it)
git -C "$WORK_DIR" init -q
git -C "$WORK_DIR" config user.email "test@test.com"
git -C "$WORK_DIR" config user.name "Test"
echo "# Test Project" > "$WORK_DIR/README.md"
git -C "$WORK_DIR" add -A
git -C "$WORK_DIR" commit -q -m "init"

# Clear usage log
> "$USAGE_LOG" 2>/dev/null || true
info "Usage log cleared"

# ─── Test 1: Team Workflow ───────────────────────────────────────────────────
header "Test 1: Team Workflow (orchestrator agent)"

TEAM_PROMPT='Create a team of exactly 2 agents:
1. Agent ID "greeter-agent" — its only job is to write a file called greeting.txt containing exactly "Hello World"
2. Agent ID "farewell-agent" — its only job is to write a file called farewell.txt containing exactly "Goodbye World"

Use delegate_tasks to run both in parallel (no dependencies between them).
After both complete, call disband_team to clean up.
Do NOT create any other files. Keep it minimal.'

info "Running orchestrator prompt..."
if npm run --prefix "$ABOO_DIR" dev -- run \
  --agent orchestrator \
  --dir "$WORK_DIR" \
  "$TEAM_PROMPT" 2>&1 | tee /tmp/aboo-test1.log; then
  info "Test 1 command completed"
else
  info "Test 1 command exited with code $? (may still have produced results)"
fi

echo ""
info "Checking team workflow log entries..."

# Tool-level calls
check_log "tool.team.plan_team called"        "tool.team.*plan_team"
check_log_count "tool.team.add_agent called 2+" "tool.team.*add_agent" 2
check_log "tool.team.finalize_team called"    "tool.team.*finalize_team"
check_log "tool.team.delegate_tasks called"   "tool.team.*delegate_tasks"
check_log "tool.team.disband_team called"     "tool.team.*disband_team"

# Manager-level calls
check_log "team.manager.startTeam called"     "team.manager.*startTeam"
check_log_count "team.manager.addAgent called 2+" "team.manager.*addAgent" 2
check_log "team.manager.finalizeTeam called"  "team.manager.*finalizeTeam"
check_log "team.manager.disbandTeam called"   "team.manager.*disbandTeam"

# Knowledge bridge
check_log "knowledge-bridge.loadKnowledgeContext called" "team.knowledge-bridge.*loadKnowledgeContext"

# File outputs
check_file "greeting.txt created" "$WORK_DIR/greeting.txt"
check_file "farewell.txt created" "$WORK_DIR/farewell.txt"

# Cleanup verification
check_no_files "No leftover agent .md files" "$WORK_DIR/.aboocode/agents" "*.md"

# ─── Test 2: Memory System ──────────────────────────────────────────────────
header "Test 2: Memory System"

MEMORY_PROMPT='Create a file called config.ts that exports:
export const Config = { port: 3000, host: "localhost", debug: false } as const;

Important project conventions to remember:
- Always use const over let
- Always add explicit type annotations
- Never use the any type
- Prefer readonly arrays'

info "Running memory prompt..."
if npm run --prefix "$ABOO_DIR" dev -- run \
  --dir "$WORK_DIR" \
  "$MEMORY_PROMPT" 2>&1 | tee /tmp/aboo-test2.log; then
  info "Test 2 command completed"
else
  info "Test 2 command exited with code $? (may still have produced results)"
fi

echo ""
info "Checking memory system log entries..."

check_log "memory.buildContext called"           "memory.*buildContext"
# Note: memory.init only runs in TUI mode (not CLI run), so we skip that check
check_log "markdown-store.readMemory called"     "memory.markdown-store.*readMemory"

# File output
check_file "config.ts created" "$WORK_DIR/config.ts"

# ─── Usage Log Review ────────────────────────────────────────────────────────
header "Usage Log Review"

if [ -f "$USAGE_LOG" ]; then
  LINE_COUNT=$(wc -l < "$USAGE_LOG" | tr -d ' ')
  info "Usage log has $LINE_COUNT entries"
  echo ""
  echo "─── Full usage.log content ───"
  cat "$USAGE_LOG"
  echo "─── End of usage.log ───"
else
  fail "Usage log file not found at $USAGE_LOG"
fi

# ─── Memory Review ──────────────────────────────────────────────────────────
header "Memory Review"

# Find MEMORY.md files
info "Searching for MEMORY.md files in $MEMORY_DIR ..."
if [ -d "$MEMORY_DIR" ]; then
  MEMORY_FILES=$(find "$MEMORY_DIR" -name "MEMORY.md" 2>/dev/null || true)
  if [ -n "$MEMORY_FILES" ]; then
    for mf in $MEMORY_FILES; do
      echo ""
      echo "─── $mf ───"
      cat "$mf"
      echo "─── End ───"
    done
  else
    info "No MEMORY.md files found (memory extraction may not have triggered — requires session idle)"
  fi
else
  info "Memory directory does not exist yet"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
header "Test Summary"

TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo ""
echo "  Passed: $PASS_COUNT / $TOTAL"
echo "  Failed: $FAIL_COUNT / $TOTAL"
echo ""

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo -e "\033[1;31m  SOME TESTS FAILED\033[0m"
else
  echo -e "\033[1;32m  ALL TESTS PASSED\033[0m"
fi

# ─── Cleanup ─────────────────────────────────────────────────────────────────
header "Cleanup"
info "Work directory preserved at: $WORK_DIR"
info "To clean up: rm -rf $WORK_DIR"

exit "$FAIL_COUNT"
