#!/usr/bin/env bash
# Build the release archive without a registry credential or signing identity.
# Usage: scripts/package-chart.sh <chart>-v<version> <output-directory>
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
HELM=${HELM:-$root/.bin/helm}
tag=${1:?usage: package-chart.sh <chart>-v<version> <output-directory>}
out=${2:?usage: package-chart.sh <chart>-v<version> <output-directory>}
[[ $tag =~ ^[a-z0-9][a-z0-9-]*-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "invalid chart tag: $tag" >&2; exit 1; }
chart=${tag%-v*} version=${tag##*-v}
tagged=$(git -C "$root" rev-parse --verify "refs/tags/$tag^{commit}")
[ "$(git -C "$root" rev-parse HEAD)" = "$tagged" ] || { echo "checkout is not tag $tag" >&2; exit 1; }
[ -z "$(git -C "$root" status --porcelain --untracked-files=no)" ] || { echo 'tracked files differ from tag' >&2; exit 1; }
epoch=$(git -C "$root" log -1 --format=%ct "$tagged")
mkdir -p "$out"
SOURCE_DATE_EPOCH=$epoch "$HELM" package "$root/charts/$chart" --destination "$out"
archive=$out/$chart-$version.tgz
[ -f "$archive" ] || { echo "chart does not match tag $tag" >&2; exit 1; }
# Helm push uses archive mtime for the OCI manifest's creation timestamp.
node -e 'const t = Number(process.argv[1]); require("node:fs").utimesSync(process.argv[2], t, t)' "$epoch" "$archive"
