#!/usr/bin/env bash
set -euo pipefail

# Aboocode Installer
# Run from inside the cloned repo to build and install aboocode.

BIN_DIR="${ABOOCODE_BIN_DIR:-/usr/local/bin}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[info]${NC} $1"; }
ok()    { echo -e "${GREEN}[ok]${NC} $1"; }
warn()  { echo -e "${YELLOW}[warn]${NC} $1"; }
error() { echo -e "${RED}[error]${NC} $1"; exit 1; }

# --- Find repo root ---
find_repo_root() {
  # Script could be run as ./install.sh from repo root, or from a subdirectory
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  if [ -f "$SCRIPT_DIR/packages/aboocode/package.json" ]; then
    REPO_DIR="$SCRIPT_DIR"
  else
    error "Cannot find aboocode source. Please run this script from the repo root."
  fi

  ok "Source directory: $REPO_DIR"
}

# --- Detect platform ---
detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) PLATFORM_OS="darwin" ;;
    Linux)  PLATFORM_OS="linux" ;;
    *)      error "Unsupported OS: $os" ;;
  esac

  case "$arch" in
    x86_64|amd64) PLATFORM_ARCH="x64" ;;
    arm64|aarch64) PLATFORM_ARCH="arm64" ;;
    *)             error "Unsupported architecture: $arch" ;;
  esac

  PLATFORM="${PLATFORM_OS}-${PLATFORM_ARCH}"
  ok "Detected platform: $PLATFORM"
}

# --- Check prerequisites ---
check_bun() {
  if ! command -v bun &>/dev/null; then
    error "Bun is required but not installed. Please install it first: https://bun.sh"
  fi

  local bun_version
  bun_version="$(bun --version)"
  ok "Bun $bun_version found"
}

# --- Install dependencies ---
install_deps() {
  info "Installing dependencies..."
  cd "$REPO_DIR"
  bun install
  ok "Dependencies installed"
}

# --- Build binary ---
build_binary() {
  info "Building aboocode for $PLATFORM..."
  cd "$REPO_DIR"
  bun run --bun packages/aboocode/script/build.ts --single

  local dist_dir="packages/aboocode/dist/aboocode-${PLATFORM}"
  local binary="$dist_dir/bin/aboo"

  if [ ! -f "$binary" ]; then
    error "Build failed: binary not found at $binary"
  fi

  chmod +x "$binary"
  ok "Built successfully: $binary"
}

# --- Install to PATH ---
install_binary() {
  local binary="$REPO_DIR/packages/aboocode/dist/aboocode-${PLATFORM}/bin/aboo"
  local target="$BIN_DIR/aboo"

  info "Installing aboo to $BIN_DIR..."

  # Create bin dir if needed
  if [ ! -d "$BIN_DIR" ]; then
    mkdir -p "$BIN_DIR" 2>/dev/null || sudo mkdir -p "$BIN_DIR"
  fi

  # Remove old symlink/file if exists
  if [ -L "$target" ] || [ -f "$target" ]; then
    rm "$target" 2>/dev/null || sudo rm "$target"
  fi

  # Symlink
  if ln -s "$binary" "$target" 2>/dev/null; then
    ok "Linked aboo -> $target"
  elif sudo ln -s "$binary" "$target" 2>/dev/null; then
    ok "Linked aboo -> $target (with sudo)"
  else
    error "Failed to create symlink. Try: sudo ln -s $binary $target"
  fi

  # Verify
  if command -v aboo &>/dev/null; then
    ok "aboo is now available in your PATH"
  else
    warn "aboo was installed to $BIN_DIR but it may not be in your PATH."
    warn "Add this to your shell config:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
  fi
}

# --- Main ---
main() {
  echo ""
  echo -e "${CYAN}=== Aboocode Installer ===${NC}"
  echo ""

  find_repo_root
  detect_platform
  check_bun
  install_deps
  build_binary
  install_binary

  echo ""
  echo -e "${GREEN}=== Installation complete! ===${NC}"
  echo ""
  echo "  Run aboocode:    aboo"
  echo "  Run in a dir:    aboo /path/to/project"
  echo "  Update later:    cd $REPO_DIR && git pull && ./install.sh"
  echo ""
}

main "$@"
