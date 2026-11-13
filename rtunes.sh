#!/usr/bin/env zsh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$SCRIPT_DIR/.toolchain/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

CMD="${1:-start}"

case "$CMD" in
  dev)
    echo "Starting RetroTunes (rTunes) in Live Development Mode..."
    npm run dev
    ;;
  start)
    echo "Building & Launching RetroTunes (rTunes)..."
    npm run start
    ;;
  build)
    npm run build
    ;;
  typecheck)
    npm run typecheck
    ;;
  *)
    echo "Usage: ./rtunes.sh [start|dev|build|typecheck]"
    exit 1
    ;;
esac
