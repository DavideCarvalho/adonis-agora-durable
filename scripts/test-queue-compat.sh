#!/usr/bin/env bash
# Run the @adonis-agora/durable test suite against another @adonisjs/queue release than the pinned
# dev dependency — the peer range accepts more than one minor (0.6 and 0.7), and the queue transport
# drives the adapter contract directly, which changed between them.
#
#   scripts/test-queue-compat.sh 0.6.2                 # whole durable suite on @adonisjs/queue 0.6.2
#   scripts/test-queue-compat.sh 0.6.2 test/engine/transports
#   REDIS_URL=redis://127.0.0.1:6379/9 scripts/test-queue-compat.sh 0.6.2 test/engine/transports
#
# The manifests are restored (and node_modules reinstalled) on exit, so the working tree ends as it
# started. Extra arguments are passed to vitest.
set -euo pipefail

version="${1:?usage: scripts/test-queue-compat.sh <@adonisjs/queue version> [vitest args...]}"
shift

root="$(cd "$(dirname "$0")/.." && pwd)"
pkg="$root/packages/adonis"
backup="$(mktemp -d)"
cp "$root/pnpm-lock.yaml" "$root/pnpm-workspace.yaml" "$pkg/package.json" "$backup/"

restore() {
  cp "$backup/pnpm-lock.yaml" "$backup/pnpm-workspace.yaml" "$root/"
  cp "$backup/package.json" "$pkg/"
  rm -rf "$backup"
  (cd "$root" && pnpm install --frozen-lockfile --silent) || true
}
trap restore EXIT

(cd "$pkg" && pnpm add --save-dev --save-exact "@adonisjs/queue@$version" --silent)
installed="$(cd "$pkg" && node -p "require('@adonisjs/queue/package.json').version" 2>/dev/null ||
  node -p "JSON.parse(require('fs').readFileSync(require.resolve('@adonisjs/queue').split('/build/')[0] + '/package.json','utf8')).version")"
echo "== @adonis-agora/durable tests on @adonisjs/queue $installed"
(cd "$pkg" && pnpm exec vitest run "$@")
