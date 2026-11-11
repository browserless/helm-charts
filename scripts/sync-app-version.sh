#!/usr/bin/env bash
# Keeps each chart's appVersion equal to its default image tag without the
# leading "v". With --check, only reports a mismatch (CI); otherwise rewrites the
# appVersion line in place (used for Dependabot image updates).
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
check=false
[ "${1:-}" = --check ] && check=true
status=0
for chart in "$root"/charts/*/; do
  name=$(basename "$chart")
  tag=$(ruby -ryaml -e 'print YAML.load_file(ARGV[0]).dig("image", "tag").to_s' "$chart/values.yaml")
  have=$(ruby -ryaml -e 'print YAML.load_file(ARGV[0])["appVersion"].to_s' "$chart/Chart.yaml")
  want=${tag#v}
  if ! [[ $want =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
    echo "$name: image.tag '$tag' is not a release version" >&2
    status=1
    continue
  fi
  [ "$have" = "$want" ] && continue
  if $check; then
    echo "$name: appVersion '$have' does not match image.tag '$tag'; run scripts/sync-app-version.sh" >&2
    status=1
    continue
  fi
  [ "$(grep -c '^appVersion:' "$chart/Chart.yaml")" = 1 ] || { echo "$name: expected one appVersion line" >&2; exit 1; }
  awk -v v="$want" '/^appVersion:/ { print "appVersion: \"" v "\""; next } { print }' "$chart/Chart.yaml" > "$chart/Chart.yaml.tmp"
  mv "$chart/Chart.yaml.tmp" "$chart/Chart.yaml"
  echo "$name: appVersion $have -> $want"
done
exit $status
