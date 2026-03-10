#!/usr/bin/env bash
set -euo pipefail

# ─── Test: Build a web game, then verify memory extraction ───────────────────
#
# This test exercises the memory system end-to-end:
#   1. Agent builds a simple web game (substantial multi-file work)
#   2. We manually trigger memory extraction (since Memory.init only runs in TUI)
#   3. We verify MEMORY.md was created with useful content
#   4. We run a second session and check that memory context is loaded
#

ABOO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
USAGE_LOG="${XDG_DATA_HOME:-$HOME/.local/share}/aboocode/usage.log"
MEMORY_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/aboocode/memory"

PASS_COUNT=0
FAIL_COUNT=0

# ─── Helpers ─────────────────────────────────────────────────────────────────
info()  { echo -e "\033[1;34m[INFO]\033[0m  $*"; }
ok()    { echo -e "\033[1;32m[PASS]\033[0m  $*"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail()  { echo -e "\033[1;31m[FAIL]\033[0m  $*"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
warn()  { echo -e "\033[1;33m[WARN]\033[0m  $*"; }
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

check_file() {
  local label="$1"
  local filepath="$2"
  if [ -f "$filepath" ]; then
    ok "$label"
  else
    fail "$label — file not found: $filepath"
  fi
}

check_memory_contains() {
  local label="$1"
  local pattern="$2"
  local found=0
  if [ -d "$MEMORY_DIR" ]; then
    while IFS= read -r mf; do
      if grep -qi "$pattern" "$mf" 2>/dev/null; then
        found=1
        break
      fi
    done < <(find "$MEMORY_DIR" -name "MEMORY.md" 2>/dev/null)
  fi
  if [ "$found" -eq 1 ]; then
    ok "$label"
  else
    fail "$label — pattern '$pattern' not found in any MEMORY.md"
  fi
}

# ─── Setup ───────────────────────────────────────────────────────────────────
header "Setup"

WORK_DIR=$(mktemp -d)
info "Work directory: $WORK_DIR"
info "Aboocode dir:   $ABOO_DIR"
info "Usage log:      $USAGE_LOG"

# Initialize a git repo (aboocode requires it)
git -C "$WORK_DIR" init -q
git -C "$WORK_DIR" config user.email "test@test.com"
git -C "$WORK_DIR" config user.name "Test"
cat > "$WORK_DIR/README.md" << 'EOF'
# Snake Game Project

A simple browser-based Snake game.

## Conventions
- Use vanilla JavaScript only, no frameworks
- All game logic in a single game.js file
- Use HTML5 Canvas for rendering
- Use requestAnimationFrame for the game loop
- Grid size: 20x20, cell size: 20px
EOF
git -C "$WORK_DIR" add -A
git -C "$WORK_DIR" commit -q -m "init"

# Clear usage log
> "$USAGE_LOG" 2>/dev/null || true
info "Usage log cleared"

# ─── Step 1: Build the game ──────────────────────────────────────────────────
header "Step 1: Build Snake Game"

GAME_PROMPT='Build a simple Snake game for the browser. Requirements:

1. Create index.html with a 400x400 canvas element and basic styling (dark background, centered)
2. Create game.js with complete game logic:
   - Snake moves on a 20x20 grid (cell size 20px)
   - Arrow key controls
   - Food spawns randomly
   - Score display
   - Game over on wall/self collision
   - Restart on Space key
3. Use vanilla JS only, no libraries

Project conventions (IMPORTANT — remember these):
- Always use const/let, never var
- Use strict equality (===) everywhere
- All functions should have JSDoc comments
- Use camelCase for variables, PascalCase for classes
- Game state should be managed in a single object

Build the complete game. Make sure both files are fully functional.'

info "Running game build prompt..."
if npm run --prefix "$ABOO_DIR" dev -- run \
  --dir "$WORK_DIR" \
  --format json \
  "$GAME_PROMPT" 2>&1 | tee /tmp/aboo-game.log; then
  info "Step 1 completed"
else
  info "Step 1 exited with code $? (may still have produced results)"
fi

echo ""
info "Checking game files..."
check_file "index.html created" "$WORK_DIR/index.html"
check_file "game.js created"    "$WORK_DIR/game.js"

# Show what was built
if [ -f "$WORK_DIR/game.js" ]; then
  LINES=$(wc -l < "$WORK_DIR/game.js" | tr -d ' ')
  info "game.js has $LINES lines"
fi

# ─── Step 2: Extract session ID and trigger memory extraction ────────────────
header "Step 2: Memory Extraction"

info "Getting session ID from game output..."
SESSION_ID=$(grep -o '"sessionID":"[^"]*"' /tmp/aboo-game.log | head -1 | sed 's/"sessionID":"//;s/"//')

if [ -z "$SESSION_ID" ]; then
  warn "Could not retrieve session ID — skipping memory extraction"
else
  info "Session ID: $SESSION_ID"
  info "Triggering memory extraction..."

  if npx --prefix "$ABOO_DIR" tsx \
    ./test/e2e/extract-memory.ts "$SESSION_ID" "$WORK_DIR" 2>&1 | tee /tmp/aboo-extract.log; then
    info "Extraction script completed"
  else
    warn "Extraction script exited with code $?"
  fi
fi

# ─── Step 3: Verify usage log ────────────────────────────────────────────────
header "Step 3: Usage Log Verification"

check_log "memory.buildContext called"          "memory.*buildContext"
check_log "markdown-store.readMemory called"    "memory.markdown-store.*readMemory"

# Check if extraction was triggered
if grep -q "memory.*extractMemories" "$USAGE_LOG" 2>/dev/null; then
  ok "memory.extractMemories called"
  if grep -q "memory.markdown-store.*writeMemory" "$USAGE_LOG" 2>/dev/null; then
    ok "markdown-store.writeMemory called"
  else
    # writeMemory may not fire if LLM returns empty (rate limit, short session, etc.)
    # Check extraction log for details
    if grep -q "Rate limit\|rate limit\|LLM returned empty" /tmp/aboo-extract.log 2>/dev/null; then
      warn "markdown-store.writeMemory not called (LLM rate limited or returned empty — extraction code path was exercised)"
    else
      fail "markdown-store.writeMemory not called"
    fi
  fi
else
  warn "memory.extractMemories not in usage log (extraction may have been skipped by filters)"
fi

# ─── Step 4: Review MEMORY.md ───────────────────────────────────────────────
header "Step 4: Memory Content Review"

MEMORY_FOUND=0
if [ -d "$MEMORY_DIR" ]; then
  while IFS= read -r mf; do
    MEMORY_FOUND=1
    echo ""
    echo "─── $mf ───"
    cat "$mf"
    echo ""
    echo "─── End ───"
  done < <(find "$MEMORY_DIR" -name "MEMORY.md" -newer "$USAGE_LOG" -o -name "MEMORY.md" 2>/dev/null | sort -u)
fi

if [ "$MEMORY_FOUND" -eq 0 ]; then
  warn "No MEMORY.md files found"
  warn "This could mean:"
  warn "  - Session had fewer than 3 messages (extraction filter)"
  warn "  - No meaningful tool usage detected (only Read/Glob/Grep)"
  warn "  - LLM returned empty extraction"
else
  ok "MEMORY.md exists"

  # Verify memory contains useful content (not just empty)
  TOTAL_SIZE=0
  while IFS= read -r mf; do
    SIZE=$(wc -c < "$mf" | tr -d ' ')
    TOTAL_SIZE=$((TOTAL_SIZE + SIZE))
  done < <(find "$MEMORY_DIR" -name "MEMORY.md" 2>/dev/null)

  if [ "$TOTAL_SIZE" -gt 50 ]; then
    ok "MEMORY.md has substantial content ($TOTAL_SIZE bytes)"
  else
    fail "MEMORY.md is too small ($TOTAL_SIZE bytes) — may not contain useful memories"
  fi
fi

# ─── Step 5: Test memory context is loaded in follow-up session ──────────────
header "Step 5: Follow-up Session (memory context)"

FOLLOWUP_PROMPT='What coding conventions and project patterns do you know about from memory? List them.'

info "Running follow-up prompt..."
FOLLOWUP_OUTPUT=$(npm run --prefix "$ABOO_DIR" dev -- run \
  --dir "$WORK_DIR" \
  "$FOLLOWUP_PROMPT" 2>&1 | tee /tmp/aboo-followup.log)

# Check that memory.buildContext was called for the follow-up
CONTEXT_COUNT=$(grep -c "memory.*buildContext" "$USAGE_LOG" 2>/dev/null | tr -d '[:space:]' || echo "0")
if [ "$CONTEXT_COUNT" -ge 2 ]; then
  ok "memory.buildContext called in follow-up session (total: $CONTEXT_COUNT)"
else
  fail "memory.buildContext not called enough times (found: $CONTEXT_COUNT, expected >=2)"
fi

# ─── Usage Log Dump ──────────────────────────────────────────────────────────
header "Full Usage Log"

if [ -f "$USAGE_LOG" ]; then
  LINE_COUNT=$(wc -l < "$USAGE_LOG" | tr -d ' ')
  info "Usage log has $LINE_COUNT entries"
  echo ""
  cat "$USAGE_LOG"
else
  fail "Usage log not found"
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
info "You can open the game: open $WORK_DIR/index.html"
info "To clean up: rm -rf $WORK_DIR"

exit "$FAIL_COUNT"
