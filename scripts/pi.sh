#!/usr/bin/env bash
# Sync to the Pi and drive compose there. CLAUDE.md §12.
set -euo pipefail
PI="${DM_PI:-albertdeiz@192.168.100.17}"
DIR="${DM_PI_DIR:-/opt/deizmem}"
cd "$(dirname "$0")/.."

# Refuses to touch a directory that is not the live install. Without .env, compose
# falls back to ./data and the default password, and a checkout elsewhere with the
# same project name recreates the running containers on top of an empty database.
guard() {
  ssh "$PI" "test -f $DIR/.env" || { echo "pi.sh: no .env in $PI:$DIR, refusing" >&2; exit 1; }
  local live
  live="$(ssh "$PI" "docker inspect deizmem-postgres-1 --format '{{index .Config.Labels \"com.docker.compose.project.working_dir\"}}' 2>/dev/null" || true)"
  if [ -n "$live" ] && [ "$live" != "$DIR" ]; then
    echo "pi.sh: the stack runs from $live, not $DIR, refusing" >&2; exit 1
  fi
}

sync() {
  guard
  rsync -az --delete --exclude node_modules --exclude dist --exclude data --exclude .git \
    --exclude '.env' --exclude '.env.*' ./ "$PI:$DIR/"
}
remote() { ssh "$PI" "cd $DIR && $*"; }
quote() { [ $# -eq 0 ] || printf '%q ' "$@"; }

cmd="${1:-up}"; shift || true
case "$cmd" in
  sync) sync ;;
  up)   sync; remote "docker compose up -d --build $(quote "$@")" ;;
  down) guard; remote "docker compose down" ;;
  ps)   remote "docker compose ps" ;;
  logs) remote "docker compose logs --tail=${TAIL:-80} $(quote "$@")" ;;
  dm)   remote "docker compose exec -T worker node /app/dm.js $(quote "$@")" ;;
  push) # dm push <local file> [dm capture flags]: copies a file to the Pi and captures it
        f="$1"; shift; b="$(basename "$f")"
        cat "$f" | remote "docker compose exec -T worker node /app/dm.js capture - --filename $(quote "$b") $(quote "$@")" ;;
  sh)   ssh -t "$PI" "cd $DIR && ${*:-bash}" ;;
  *)    echo "usage: scripts/pi.sh sync|up|down|ps|logs|dm|push|sh"; exit 1 ;;
esac
