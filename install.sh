#!/usr/bin/env bash
set -euo pipefail

# Aboocode Installer
# Clones, builds, and installs aboocode from source.

REPO_URL="https://github.com/cytsaiap-xyz/aboocode.git"
INSTALL_DIR="${ABOOCODE_INSTALL_DIR:-$HOME/.aboocode}"
BIN_DIR="${ABOOCODE_BIN_DIR:-/usr/local/bin}"
MIN_BUN_VERSION="1.3.9"

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
check_git() {
  if ! command -v git &>/dev/null; then
    error "git is required but not installed. Please install git first."
  fi
  ok "git found"
}

check_bun() {
  if ! command -v bun &>/dev/null; then
    warn "Bun is not installed."
    info "Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"

    if ! command -v bun &>/dev/null; then
      error "Failed to install Bun. Please install it manually: https://bun.sh"
    fi
  fi

  local bun_version
  bun_version="$(bun --version)"
  ok "Bun $bun_version found"
}

# --- Clone or update repo ---
clone_repo() {
  if [ -d "$INSTALL_DIR" ]; then
    info "Aboocode directory exists at $INSTALL_DIR"
    info "Pulling latest changes..."
    cd "$INSTALL_DIR"
    git pull --ff-only || warn "Could not fast-forward. Using existing code."
  else
    info "Cloning aboocode to $INSTALL_DIR..."
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi
  ok "Source ready at $INSTALL_DIR"
}

# --- Install dependencies ---
install_deps() {
  info "Installing dependencies..."
  cd "$INSTALL_DIR"
  bun install
  ok "Dependencies installed"
}

# --- Build binary ---
build_binary() {
  info "Building aboocode for $PLATFORM..."
  cd "$INSTALL_DIR"
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
  local dist_dir="$INSTALL_DIR/packages/aboocode/dist/aboocode-${PLATFORM}"
  local binary="$dist_dir/bin/aboo"
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

  detect_platform
  check_git
  check_bun
  clone_repo
  install_deps
  build_binary
  install_binary

  echo ""
  echo -e "${GREEN}=== Installation complete! ===${NC}"
  echo ""
  echo "  Run aboocode:    aboo"
  echo "  Run in a dir:    aboo /path/to/project"
  echo "  Update later:    cd $INSTALL_DIR && git pull && bun install && bun run --bun packages/aboocode/script/build.ts --single"
  echo ""
}

main "$@"
