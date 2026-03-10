#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# Test script for agent team and memory system
# Uses the locally-built `aboo` binary to exercise both features
# Debug output: ~/.local/share/aboocode/log/debug-team-memory.log
# ─────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

# Detect platform binary from dist/
ARCH=$(uname -m)
case "$ARCH" in
  arm64|aarch64) PLATFORM="darwin-arm64" ;;
  *)             PLATFORM="darwin-x64" ;;
esac
LOCAL_BIN="$PKG_DIR/dist/aboocode-${PLATFORM}/bin/aboo"

# Use the bin shim with ABOOCODE_BIN_PATH pointing to local build
export ABOOCODE_BIN_PATH="$LOCAL_BIN"
ABOO="$LOCAL_BIN"

# Resolve log path (XDG_DATA_HOME or default)
LOG_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/aboocode/log"
LOG_FILE="$LOG_DIR/debug-team-memory.log"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Aboocode Team & Memory System Test                     ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Debug log: $LOG_FILE"
echo "║  Binary:    $ABOO"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# Ensure aboo is built
echo "[1/5] Building aboocode..."
cd "$PKG_DIR"
if ! npm run build 2>&1 | tail -3; then
  echo "ERROR: Build failed. Please fix build errors first."
  exit 1
fi
echo ""

# Verify the binary exists
if [ ! -x "$ABOO" ]; then
  echo "ERROR: Built binary not found at $ABOO"
  echo "Available binaries:"
  find "$PKG_DIR/dist" -name "aboo" -type f 2>/dev/null
  exit 1
fi
echo "[2/5] Binary verified: $ABOO"
echo ""

# Clear previous debug log
mkdir -p "$LOG_DIR"
echo "Debug log started at $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOG_FILE"
echo "[3/5] Debug log cleared: $LOG_FILE"
echo ""

# ── Test 1: Memory System ──
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  TEST 1: Memory System — build context & append"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

cd "$ROOT_DIR"
echo "Running: aboo run (memory test prompt)..."
"$ABOO" run "Please read the file packages/aboocode/src/memory/index.ts then write a brief one-line summary of what the memory system does. Do not create any files or make any changes." \
  --title "test-memory-$(date +%s)" \
  2>&1 || echo "(aboo run exited with non-zero)"

echo ""
echo "Memory test prompt completed."
echo ""

# ── Test 2: Agent Team System ──
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  TEST 2: Agent Team System — plan, add, finalize, delegate"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "Running: aboo run (team test prompt with orchestrator)..."
"$ABOO" run "You are testing the agent team system. Do the following steps in order:
1. Use plan_team with task_summary 'Test: create two agents to analyze a simple file'
2. Use add_agent to create agent 'test-reader' (name: 'File Reader', description: 'Reads and summarizes files', system_prompt: 'You read files and provide brief summaries. Be concise.')
3. Use add_agent to create agent 'test-writer' (name: 'File Writer', description: 'Creates test output files', system_prompt: 'You create small test files as requested. Be concise.')
4. Use finalize_team
5. Use list_team to show the team
6. Use delegate_task to ask 'test-reader' to: 'Read packages/aboocode/src/team/manager.ts and summarize it in 2 sentences'
7. Use disband_team
Report what happened at each step." \
  --agent orchestrator \
  --title "test-team-$(date +%s)" \
  2>&1 || echo "(aboo run exited with non-zero)"

echo ""
echo "Team test prompt completed."
echo ""

# ── Review Results ──
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  RESULTS: Debug Log Contents"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ -f "$LOG_FILE" ]; then
  LOG_SIZE=$(wc -c < "$LOG_FILE" | tr -d ' ')
  echo "Log file size: ${LOG_SIZE} bytes"
  echo ""
  cat "$LOG_FILE"
else
  echo "WARNING: Debug log file not found at $LOG_FILE"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  VERIFICATION CHECKLIST"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check memory log entries (grep -c returns non-zero if no matches)
MEMORY_ENTRIES=$(grep -c "\[MEMORY\]" "$LOG_FILE" 2>/dev/null || true)
TEAM_ENTRIES=$(grep -c "\[TEAM\]" "$LOG_FILE" 2>/dev/null || true)

echo "  [Memory System]"
echo "    Log entries: $MEMORY_ENTRIES"
if [ "$MEMORY_ENTRIES" -gt 0 ] 2>/dev/null; then
  echo "    Status: PASS — memory operations were logged"
else
  echo "    Status: WARN — no memory log entries found (may need longer session for auto-extract)"
fi

echo ""
echo "  [Team System]"
echo "    Log entries: $TEAM_ENTRIES"
if [ "$TEAM_ENTRIES" -gt 0 ] 2>/dev/null; then
  echo "    Status: PASS — team operations were logged"
else
  echo "    Status: FAIL — no team log entries found"
fi

echo ""
echo "  Full debug log: $LOG_FILE"
echo "  Usage log:      ${XDG_DATA_HOME:-$HOME/.local/share}/aboocode/usage.log"
echo ""
echo "Done."
