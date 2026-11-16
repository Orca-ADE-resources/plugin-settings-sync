#!/usr/bin/env sh
# Load the current source into the running Orca (no plugin reinstall, no Orca restart).
#   scripts/run-local.sh            -> reload (replace the running engine)
#   scripts/run-local.sh status     -> any command of scripts/sync.mjs
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
CMD="${1:-reload}"
[ $# -gt 0 ] && shift
exec node "$DIR/sync.mjs" "$CMD" "$@"
