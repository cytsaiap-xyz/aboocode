#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Installing dependencies..."
bun install

echo "==> Building extension..."
node esbuild.js --production

echo "==> Packaging VSIX..."
npx @vscode/vsce package --no-dependencies

echo "==> Done! VSIX file:"
ls -la *.vsix
