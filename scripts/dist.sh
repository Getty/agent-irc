#!/bin/sh
# dist/server.js is committed: user machines run it and never `bun install`.
#
#   sh scripts/dist.sh build   bundle src/server.ts into dist/server.js
#   sh scripts/dist.sh check   bundle into a temp directory and cmp with the
#                              committed dist/server.js; exit 1 on any byte
#
# --target=bun puts the `// @bun` pragma on the first line, so Bun runs the
# bundle without transpiling it again and writes no transpiler cache into the
# user's HOME. The `// <path>` comments in the bundle are relative to the
# working directory, hence the cd to the repository root: built from anywhere
# else, the same sources give different bytes. The bundle is only reproducible with the pinned Bun, so both
# commands refuse any other version (package.json gettyBun.bunVersion).
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

pin=$(sed -n 's/^ *"bunVersion": *"\([^"]*\)".*/\1/p' package.json)
have=$(bun --version)
if [ "$have" != "$pin" ]; then
    echo "dist.sh: bun $have, but package.json pins $pin" >&2
    exit 1
fi

bundle() {
    bun build --target=bun --outfile="$1" src/server.ts >&2
}

case "${1:-}" in
build)
    bundle dist/server.js
    ;;
check)
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    bundle "$tmp/server.js"
    cmp "$tmp/server.js" dist/server.js
    echo "dist.sh: dist/server.js matches a fresh build with bun $have" >&2
    ;;
*)
    echo "usage: sh scripts/dist.sh build|check" >&2
    exit 2
    ;;
esac
