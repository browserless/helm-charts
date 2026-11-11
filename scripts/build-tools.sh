#!/usr/bin/env bash
# Builds the Helm, kind and actionlint versions locked in tools/go.mod (sources
# verified by tools/go.sum) into .bin/ and proves each binary embeds exactly the
# locked module version. Dependabot (gomod) updates tools/go.mod.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
bin=${TOOLS_BIN:-$root/.bin}
locked() { go -C "$root/tools" list -m -f '{{.Version}}' "$1"; }

helm_version=$(locked helm.sh/helm/v4)
mkdir -p "$bin"
# Helm reports a version only when it is injected at link time, as its release builds do.
GOFLAGS=-mod=readonly go -C "$root/tools" build -trimpath \
  -ldflags "-X helm.sh/helm/v4/internal/version.version=$helm_version" \
  -o "$bin/" helm.sh/helm/v4/cmd/helm sigs.k8s.io/kind github.com/rhysd/actionlint/cmd/actionlint

for tool in helm:helm.sh/helm/v4 kind:sigs.k8s.io/kind actionlint:github.com/rhysd/actionlint; do
  name=${tool%%:*} module=${tool#*:}
  want="$module $(locked "$module") $(awk -v m="$module" -v v="$(locked "$module")" '$1 == m && $2 == v { print $3 }' "$root/tools/go.sum")"
  # The binary's build info names the module of its main package (mod) and its source hash.
  got=$(go version -m "$bin/$name" | awk -v m="$module" '$1 == "mod" && $2 == m { print $2, $3, $4 }')
  if [ "$got" != "$want" ]; then
    echo "$name embeds '${got:-no $module}', but tools/go.mod and go.sum lock '$want'" >&2
    exit 1
  fi
  echo "$name: $got"
done
case $("$bin/helm" version --template '{{.Version}}') in
  "$helm_version") ;;
  *) echo "helm reports $("$bin/helm" version --template '{{.Version}}'), expected $helm_version" >&2; exit 1 ;;
esac
case $helm_version in
  v4.*) ;;
  *) echo "the charts and CI require Helm 4; tools/go.mod locks $helm_version" >&2; exit 1 ;;
esac
