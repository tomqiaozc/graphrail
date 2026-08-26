#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$ROOT"
PACK_OUTPUT="$(npm pack --json)"
TARBALL="$(node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(v[0].filename)' <<< "$PACK_OUTPUT")"
cd "$TMP"
npm init -y >/dev/null
npm install "$ROOT/$TARBALL" >/dev/null
./node_modules/.bin/graphrail --help | grep -q "deterministic graph harness"
rm -f "$ROOT/$TARBALL"
