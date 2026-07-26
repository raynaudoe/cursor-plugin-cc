#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/plugins/cursor"
NODE_BIN="${NODE:-node}"
PACK_DIR="${PACK_DIR:-${RUNNER_TEMP:-/tmp}/cursor-plugin-pack}"

rm -rf "$PACK_DIR"
mkdir -p "$PACK_DIR/unpacked"

TARBALL_NAME="$(
  cd "$PLUGIN_DIR"
  npm pack --pack-destination "$PACK_DIR" --silent
)"
TARBALL="$PACK_DIR/$TARBALL_NAME"

tar -xzf "$TARBALL" -C "$PACK_DIR/unpacked"

PACKAGE_DIR="$PACK_DIR/unpacked/package"
for path in \
  "$PACKAGE_DIR/package.json" \
  "$PACKAGE_DIR/.claude-plugin/plugin.json" \
  "$PACKAGE_DIR/scripts/cursor-companion.mjs" \
  "$PACKAGE_DIR/scripts/session-lifecycle-hook.mjs" \
  "$PACKAGE_DIR/scripts/lib/run.mjs" \
  "$PACKAGE_DIR/commands/review.md" \
  "$PACKAGE_DIR/commands/debate.md" \
  "$PACKAGE_DIR/agents/cursor-rescue.md" \
  "$PACKAGE_DIR/hooks/hooks.json" \
  "$PACKAGE_DIR/skills/cursor-result-handling/SKILL.md" \
  "$PACKAGE_DIR/skills/cursor-prompting/SKILL.md"
do
  test -f "$path"
done

test ! -e "$PACKAGE_DIR/plugin.json"

for path in \
  "$PACKAGE_DIR/tests" \
  "$PACKAGE_DIR/node_modules" \
  "$PACKAGE_DIR/coverage" \
  "$PACKAGE_DIR/package-lock.json" \
  "$PACKAGE_DIR/eslint.config.js" \
  "$PACKAGE_DIR/vitest.config.mjs"
do
  test ! -e "$path"
done

"$NODE_BIN" "$PACKAGE_DIR/scripts/cursor-companion.mjs" help

echo "Package smoke passed."
