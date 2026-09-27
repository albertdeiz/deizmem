#!/usr/bin/env bash
# Sync to the Pi and drive compose there. CLAUDE.md §12.
set -euo pipefail
PI="${DM_PI:-albertdeiz@192.168.100.17}"
DIR="${DM_PI_DIR:-Dev/deizmem}"
cd "$(dirname "$0")/.."

sync() {
  ssh "$PI" "mkdir -p $DIR/data/blobs $DIR/data/pg"
  rsync -az --delete --exclude node_modules --exclude dist --exclude data --exclude .git \
    --exclude '.env' --exclude '.env.*' ./ "$PI:$DIR/"
}
remote() { ssh "$PI" "cd $DIR && $*"; }
quote() { printf '%q ' "$@"; }

cmd="${1:-up}"; shift || true
case "$cmd" in
  sync) sync ;;
  up)   sync; remote "docker compose up -d --build $(quote "$@")" ;;
  down) remote "docker compose down" ;;
  ps)   remote "docker compose ps" ;;
  logs) remote "docker compose logs --tail=${TAIL:-80} $(quote "$@")" ;;
  dm)   remote "docker compose exec -T worker node /app/dm.js $(quote "$@")" ;;
  push) # dm push <local file> [dm capture flags]: copies a file to the Pi and captures it
        f="$1"; shift; b="$(basename "$f")"
        cat "$f" | remote "docker compose exec -T worker node /app/dm.js capture - --filename $(quote "$b") $(quote "$@")" ;;
  sh)   ssh -t "$PI" "cd $DIR && ${*:-bash}" ;;
  *)    echo "usage: scripts/pi.sh sync|up|down|ps|logs|dm|push|sh"; exit 1 ;;
esac
