#!/usr/bin/env bash
# Publishes one chart release to an OCI registry: scripts/publish-chart.sh <chart>-v<version>
# publish.yml runs it for a published GitHub Release, from that release's tag.
# It refuses to publish unless the checkout is exactly the tag, the tag is on
# main, and Chart.yaml and the release manifest agree; it refuses to overwrite a
# version the registry already holds, and pulls the pushed chart back to compare
# it byte for byte. It prints the pushed manifest digest and, under GitHub
# Actions, adds it to the job summary and writes `name` and `digest` step
# outputs for the provenance attestation. publish.yml's verify job has already
# run the chart tests and checked appVersion.
#
# Runs in the job that can publish and sign, so it uses no npm packages: only
# Node built-ins, Helm, jq and curl. Environment: HELM
# (default .bin/helm from scripts/install-tools.ts, logged in to the registry),
# OCI_REGISTRY (default ghcr.io), OCI_NAMESPACE (default browserless/charts),
# REGISTRY_USER and REGISTRY_PASSWORD (for the existence check), MAIN_REF
# (default origin/main), PLAIN_HTTP=1 for a local test registry.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
HELM=${HELM:-$root/.bin/helm}
registry=${OCI_REGISTRY:-ghcr.io}
namespace=${OCI_NAMESPACE:-browserless/charts}
fail() { echo "publish-chart: $*" >&2; exit 1; }

tag=${1:?usage: publish-chart.sh <chart>-v<version>}
chart=${tag%-v*}
version=${tag##*-v}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "tag $tag is not <chart>-v<major>.<minor>.<patch>"
dir=$root/charts/$chart
[ -f "$dir/Chart.yaml" ] || fail "no chart named $chart"

head=$(git -C "$root" rev-parse HEAD)
tagged=$(git -C "$root" rev-parse --verify --quiet "refs/tags/$tag^{commit}") || fail "tag $tag does not exist"
[ "$head" = "$tagged" ] || fail "checkout $head is not tag $tag ($tagged)"
[ -z "$(git -C "$root" status --porcelain --untracked-files=no)" ] || fail "tracked files differ from tag $tag"
git -C "$root" merge-base --is-ancestor "$tagged" "${MAIN_REF:-origin/main}" || fail "tag $tag is not on ${MAIN_REF:-origin/main}"
chart_version=$("$HELM" show chart "$dir" | sed -n 's/^version: //p')
[ "$chart_version" = "$version" ] || fail "Chart.yaml version $chart_version does not match tag $tag"
manifest_version=$(jq -r --arg p "charts/$chart" '.[$p] // empty' "$root/.release-please-manifest.json")
[ "$manifest_version" = "$version" ] || fail "release manifest has '$manifest_version' for charts/$chart, tag is $tag"

scheme=https plain=()
if [ "${PLAIN_HTTP:-0}" = 1 ]; then scheme=http plain=(--plain-http); fi
# Prints the HTTP status of the version's manifest, following a Bearer challenge.
manifest_status() {
  local url="$scheme://$registry/v2/$namespace/$chart/manifests/$version" accept challenge realm service token
  accept='Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json'
  challenge=$(curl -sS -o /dev/null -D - -H "$accept" "$url" | tr -d '\r' |
    awk 'tolower($1) == "www-authenticate:" { $1 = ""; print }')
  case $challenge in
    *Bearer*)
      realm=$(sed -E 's/.*realm="([^"]+)".*/\1/' <<< "$challenge")
      service=$(sed -nE 's/.*service="([^"]+)".*/\1/p' <<< "$challenge")
      if [ -n "${REGISTRY_USER:-}" ]; then
        token=$(printf 'user = "%s:%s"\n' "$REGISTRY_USER" "${REGISTRY_PASSWORD:-}" |
          curl -sS -K - -G "$realm" --data-urlencode "service=$service" --data-urlencode "scope=repository:$namespace/$chart:pull" |
          jq -r '.token // .access_token // empty')
      else
        token=$(curl -sS -G "$realm" --data-urlencode "service=$service" --data-urlencode "scope=repository:$namespace/$chart:pull" |
          jq -r '.token // .access_token // empty')
      fi
      [ -n "$token" ] || { echo 000; return; }
      printf 'header = "Authorization: Bearer %s"\n' "$token" |
        curl -sS -K - -o /dev/null -w '%{http_code}' -H "$accept" "$url"
      ;;
    *) curl -sS -o /dev/null -w '%{http_code}' -H "$accept" "$url" ;;
  esac
}
status=$(manifest_status) || true
case $status in
  404) ;;
  200) fail "$registry/$namespace/$chart:$version already exists; refusing to overwrite it" ;;
  *) fail "cannot tell whether $registry/$namespace/$chart:$version exists (HTTP $status); not publishing" ;;
esac

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
# Times come from the tag's commit, so anyone can rebuild the same package and
# OCI manifest from the tag: helm package takes file times from
# SOURCE_DATE_EPOCH, and helm push takes the manifest's
# org.opencontainers.image.created from the package file's modification time,
# formatted in the local time zone.
epoch=$(git -C "$root" log -1 --format=%ct "$tagged")
SOURCE_DATE_EPOCH=$epoch "$HELM" package "$dir" --destination "$out" > /dev/null
package=$out/$chart-$version.tgz
[ -f "$package" ] || fail "helm package did not produce $chart-$version.tgz"
node -e 'const t = Number(process.argv[1]); require("node:fs").utimesSync(process.argv[2], t, t)' "$epoch" "$package"
pushed=$(TZ=UTC "$HELM" push "$package" "oci://$registry/$namespace" ${plain[@]+"${plain[@]}"}) ||
  fail "helm push failed"
echo "$pushed"
digest=$(sed -n 's/^Digest: //p' <<< "$pushed")
[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || fail "helm push did not report a manifest digest"
mkdir "$out/pulled"
pulled=$("$HELM" pull "oci://$registry/$namespace/$chart" --version "$version" --destination "$out/pulled" ${plain[@]+"${plain[@]}"})
[ "$(sed -n 's/^Digest: //p' <<< "$pulled")" = "$digest" ] || fail "$chart:$version resolves to another digest than the one pushed"
cmp -s "$package" "$out/pulled/$chart-$version.tgz" || fail "the chart pulled back differs from the package pushed"
echo "published oci://$registry/$namespace/$chart:$version@$digest (package sha256 $(shasum -a 256 "$package" | cut -d' ' -f1)) from $tagged"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'name=%s\ndigest=%s\n' "$registry/$namespace/$chart" "$digest" >> "$GITHUB_OUTPUT"
  printf 'Published oci://%s/%s/%s:%s@%s from %s\n' \
    "$registry" "$namespace" "$chart" "$version" "$digest" "$tagged" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
fi
