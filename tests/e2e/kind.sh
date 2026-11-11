#!/usr/bin/env bash
# Runtime tests for charts/browserless on a disposable kind cluster. CI runs this
# script unchanged; run it locally the same way (see the README).
#
# Needs docker, jq, openssl and Node with the `npm ci` dependencies, plus the
# Helm 4 and kind binaries from scripts/install-tools.ts (override with HELM=
# and KIND=). Environment:
#   KIND_CONFIG   kind cluster config (default: the newest tests/kind version)
#   CLUSTER_NAME  kind cluster name (default browserless-e2e-<random>)
#   E2E_OUT       log and redacted diagnostics (default tests/e2e/out/<cluster>)
#   UPGRADE_FROM  optional chart reference to install first, then upgrade from
#   KEEP_CLUSTER  1 keeps the cluster afterwards (it holds the test token)
# kubectl runs inside the kind node, so its version follows the node image. The
# generated token is never printed; diagnostics are redacted, then checked.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
HELM=${HELM:-$root/.bin/helm}
KIND=${KIND:-$root/.bin/kind}
KIND_CONFIG=${KIND_CONFIG:-$root/tests/kind/$(cd "$root/tests/kind" && printf '%s\n' * | sort -t. -k1,1n -k2,2n | tail -1)/cluster.yaml}
CLUSTER_NAME=${CLUSTER_NAME:-browserless-e2e-$(openssl rand -hex 3)}
E2E_OUT=${E2E_OUT:-$root/tests/e2e/out/$CLUSTER_NAME}
CHART=$root/charts/browserless
NS=e2e
node=$CLUSTER_NAME-control-plane
work=$(mktemp -d)
mkdir -p "$E2E_OUT"
log=$E2E_OUT/e2e.log
: > "$log"

say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$log"; }
pass() { say "PASS: $*"; }
fail() { say "FAIL: $*"; exit 1; }
k() { docker exec -i "$node" kubectl "$@"; }
h() { "$HELM" --kubeconfig "$work/kubeconfig" "$@"; }
podjson() { k -n $NS get pod -l "app.kubernetes.io/instance=$1" -o json | jq '.items[0] // empty'; }
pod() { k -n $NS get pod -l "app.kubernetes.io/instance=$1" -o jsonpath='{.items[0].metadata.name}'; }
# Runs a tests/e2e/*.mjs client inside the browserless container; it reads TOKEN from the pod.
in_pod() {
  local release=$1 script=$2
  shift 2
  k -n $NS exec -i "$(pod "$release")" -- env "$@" node --input-type=module - < "$root/tests/e2e/$script"
}
token_hits() { k -n $NS logs "$1" --all-containers "${@:2}" 2>/dev/null | grep -cF -f "$work/token" || true; }
from_node() { docker exec "$node" curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" || true; }
ready_endpoints() {
  k -n $NS get endpointslice -l "kubernetes.io/service-name=$1" -o json |
    jq '[.items[].endpoints[]? | select(.conditions.ready == true)] | length'
}
wait_ready_endpoints() { # service, wanted count, seconds
  local _
  for _ in $(seq 1 "$3"); do
    [ "$(ready_endpoints "$1")" = "$2" ] && return 0
    sleep 1
  done
  return 1
}
# Prints the exit code and log of a container that has stopped at least once.
guard_exit() { # release
  local p name
  p=$(podjson "$1")
  [ -n "$p" ] && jq -e '.status.containerStatuses[0] | (.state.terminated // .lastState.terminated) != null' <<< "$p" > /dev/null || return 1
  jq -r '.status.containerStatuses[0] | (.state.terminated // .lastState.terminated).exitCode' <<< "$p"
  name=$(jq -r .metadata.name <<< "$p")
  k -n $NS logs "$name" --previous 2> /dev/null || k -n $NS logs "$name"
}
waiting_reason() { # release, reason, seconds
  local _
  for _ in $(seq 1 "$3"); do
    [ "$(podjson "$1" | jq -r '.status.containerStatuses[0].state.waiting.reason // empty')" = "$2" ] && return 0
    sleep 1
  done
  return 1
}
wait_single_pod() {
  local _
  for _ in $(seq 1 60); do
    [ "$(k -n $NS get pods -l "app.kubernetes.io/instance=$1" -o name | wc -l | tr -d ' ')" = 1 ] && return 0
    sleep 1
  done
  return 1
}
# The entrypoint guard must stop the container with exit 2 and the given message.
# Polls, because the kubelet can briefly answer a log request for a container
# that just exited with "unable to retrieve container logs".
expect_guard() { # release, message, description
  local out='' _
  for _ in $(seq 1 90); do
    out=$(guard_exit "$1") && [ "$(head -1 <<< "$out")" = 2 ] && grep -q "$2" <<< "$out" && break
    sleep 1
  done
  if [ "$(head -1 <<< "$out")" != 2 ] || ! grep -q "$2" <<< "$out"; then fail "$3: ${out:-container kept running}"; fi
  pass "$3: exit 2, $(grep -m1 "$2" <<< "$out")"
}
secret() { # name, value file; the value travels only through pipes
  printf '{"apiVersion":"v1","kind":"Secret","metadata":{"name":"%s"},"data":{"TOKEN":"%s"}}' \
    "$1" "$(base64 < "$2" | tr -d '\n')" | k -n $NS apply -f - > /dev/null
}

cleanup() {
  local status=$? d=$E2E_OUT/diagnostics p
  set +e
  trap - EXIT
  [ -n "${watcher:-}" ] && kill "$watcher" 2> /dev/null
  if docker inspect "$node" > /dev/null 2>&1; then
    mkdir -p "$d"
    k get nodes -o wide > "$d/nodes.txt" 2>&1
    k get all,endpointslices,pvc,pv -A -o wide > "$d/resources.txt" 2>&1
    k get events -A --sort-by=.lastTimestamp > "$d/events.txt" 2>&1
    k -n $NS describe pods > "$d/pods.txt" 2>&1
    for p in $(k -n $NS get pods -o name 2> /dev/null); do
      k -n $NS logs "$p" --all-containers > "$d/${p#pod/}.log" 2>&1
      k -n $NS logs "$p" --all-containers --previous > "$d/${p#pod/}.previous.log" 2> /dev/null || rm -f "$d/${p#pod/}.previous.log"
    done
    h -n $NS list -a -o json > "$d/helm-releases.json" 2>&1
  fi
  if [ -s "$work/token" ]; then
    node -e '
      const fs = require("node:fs"), path = require("node:path");
      const [token, dir] = [fs.readFileSync(process.argv[1], "latin1"), process.argv[2]];
      for (const name of fs.readdirSync(dir, { recursive: true })) {
        const file = path.join(dir, name);
        if (!fs.statSync(file).isFile()) continue;
        const text = fs.readFileSync(file, "latin1");
        if (text.includes(token)) fs.writeFileSync(file, text.split(token).join("<redacted>"), "latin1");
      }' "$work/token" "$E2E_OUT"
    if grep -rqF -f "$work/token" "$E2E_OUT"; then
      echo "the test token is still present in $E2E_OUT" >&2
      status=1
    fi
  fi
  if [ "${KEEP_CLUSTER:-0}" = 1 ]; then
    echo "kept cluster $CLUSTER_NAME; kubeconfig $work/kubeconfig"
  else
    "$KIND" delete cluster --name "$CLUSTER_NAME" > /dev/null 2>&1
    rm -rf "$work"
  fi
  if [ "$status" = 0 ]; then say "all checks passed"; else say "checks failed (exit $status)"; fi
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] && grep -E 'PASS|FAIL|skipped|^[0-9:]+ (chart|Kubernetes|all checks|checks failed)' "$log" >> "$GITHUB_STEP_SUMMARY"
  exit "$status"
}
trap cleanup EXIT

for cmd in docker jq openssl node; do
  command -v "$cmd" > /dev/null || fail "$cmd is required"
done
[[ -x $HELM && $("$HELM" version --template '{{.Version}}') == v4.* ]] || fail "HELM ($HELM) must be Helm 4"
[ -x "$KIND" ] || fail "KIND ($KIND) is not executable"
yaml() { node "$root/scripts/yaml-get.ts" "$@"; }
repository=$(yaml "$CHART/values.yaml" image.repository)
tag=$(yaml "$CHART/values.yaml" image.tag)
image=$repository:$tag
app_version=$(yaml "$CHART/Chart.yaml" appVersion)
chart_version=$(yaml "$CHART/Chart.yaml" version)
[ "v$app_version" = "${image##*:}" ] || fail "appVersion $app_version does not match default image $image"
say "chart $chart_version (appVersion $app_version, image $image); $("$KIND" version); helm $("$HELM" version --template '{{.Version}}')"

"$KIND" create cluster --name "$CLUSTER_NAME" --config "$KIND_CONFIG" --kubeconfig "$work/kubeconfig" --wait 180s >> "$log" 2>&1 ||
  fail "kind create cluster"
say "Kubernetes $(k version -o json | jq -r .serverVersion.gitVersion) on $(k get node "$node" -o jsonpath='{.status.nodeInfo.architecture}'), node image $(yaml "$KIND_CONFIG" nodes.0.image)"

k create namespace $NS > /dev/null
k label namespace $NS pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/warn=restricted > /dev/null
umask 077
openssl rand -hex 24 | tr -d '\n' > "$work/token"
printf '' > "$work/empty"
printf 'tok\303\251n' > "$work/non-ascii"
umask 022
[ -n "${GITHUB_ACTIONS:-}" ] && echo "::add-mask::$(cat "$work/token")"
secret token "$work/token"
secret empty-token "$work/empty"
secret non-ascii-token "$work/non-ascii"
k -n $NS apply -f - > /dev/null << 'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: data}
spec: {accessModes: [ReadWriteOnce], resources: {requests: {storage: 1Gi}}}
EOF
values=(--set token.existingSecret=token --set persistence.existingClaim=data)
svc=main-browserless

# 1. Install (or upgrade from UPGRADE_FROM) under enforced restricted Pod Security.
if [ -n "${UPGRADE_FROM:-}" ]; then
  say "install $UPGRADE_FROM"
  h -n $NS install main "$UPGRADE_FROM" "${values[@]}" --wait --timeout 10m >> "$log" 2>&1 || fail "install $UPGRADE_FROM"
  in_pod main smoke.mjs > "$work/smoke-before.json" || fail "smoke before upgrade: $(cat "$work/smoke-before.json")"
  before=$(podjson main | jq -r .metadata.uid)
  pass "previous chart serves requests: $(cat "$work/smoke-before.json")"
  # Count pods with a running container. A stopped pod can still exist (terminal
  # phase, volumes unmounting) while Recreate creates its replacement.
  (while :; do
    k -n $NS get pods -l app.kubernetes.io/instance=main -o json | jq -c '[.items[] | {pod: .metadata.name,
      phase: .status.phase, deleting: (.metadata.deletionTimestamp != null),
      running: any(.status.containerStatuses[]?; .state.running != null)}]' >> "$E2E_OUT/upgrade-pods.jsonl"
    sleep 1
  done) &
  watcher=$!
  h -n $NS upgrade main "$CHART" "${values[@]}" --wait --timeout 10m >> "$log" 2>&1 || fail "upgrade to the working tree"
  kill "$watcher"
  watcher=
  most=$(jq -s 'map(map(select(.running)) | length) | max' "$E2E_OUT/upgrade-pods.jsonl")
  [ "$most" -le 1 ] || fail "Recreate upgrade ran two browserless containers at once (see upgrade-pods.jsonl)"
  [ "$(podjson main | jq -r .metadata.uid)" != "$before" ] || fail "upgrade did not replace the pod"
  pass "upgrade replaced the pod; at most $most running container in $(wc -l < "$E2E_OUT/upgrade-pods.jsonl" | tr -d ' ') samples (upgrade-pods.jsonl)"
else
  say "UPGRADE_FROM is unset: the upgrade-from-release check is skipped"
  h -n $NS install main "$CHART" "${values[@]}" --wait --timeout 10m >> "$log" 2>&1 || fail "install"
fi
p=$(podjson main)
[ "$(jq -r '.spec.containers[0].image' <<< "$p")" = "$image" ] || fail "pod image $(jq -r '.spec.containers[0].image' <<< "$p") is not $image"
jq -e '.status.containerStatuses[0] | .ready and .restartCount == 0' <<< "$p" > /dev/null || fail "pod not ready"
installed=$(h -n $NS list -o json | jq -r '.[] | select(.name == "main") | .app_version')
[ "$installed" = "$app_version" ] || fail "installed release reports appVersion '$installed', expected $app_version"
pass "installed under restricted Pod Security: $image, imageID $(jq -r '.status.containerStatuses[0].imageID' <<< "$p"), appVersion $installed"

# 2. Real browser requests, authentication and the Service path.
in_pod main smoke.mjs > "$work/smoke.json" || fail "smoke: $(cat "$work/smoke.json")"
pass "unauthorized 401, pressure 200, HTML with JavaScript, PNG screenshot: $(cat "$work/smoke.json")"
svc_ip=$(k -n $NS get service $svc -o jsonpath='{.spec.clusterIP}')
code=$(from_node "http://$svc_ip:3000/pressure")
[ "$code" = 401 ] || fail "Service without a token returned $code, expected 401"
pass "Service routes to the pod and requires the token (401 without it)"

# 3. A browser profile on the PVC survives pod replacement.
cookie=$(openssl rand -hex 8)
in_pod main cookie.mjs MODE=set PROFILE=/data/profile "COOKIE=$cookie" HOLD_MS=40000 > "$work/cookie-set.json" || fail "cookie set: $(cat "$work/cookie-set.json")"
jq -e --arg c "$cookie" '.cookie == $c' "$work/cookie-set.json" > /dev/null || fail "cookie not set: $(cat "$work/cookie-set.json")"
owner=$(k -n $NS exec "$(pod main)" -- stat -c '%u' /data/profile)
[ "$owner" = 999 ] || fail "profile directory owned by UID $owner, expected 999"
before=$(podjson main | jq -r .metadata.uid)
k -n $NS rollout restart deployment/$svc > /dev/null
k -n $NS rollout status deployment/$svc --timeout 5m >> "$log" 2>&1 || fail "rollout after restart"
wait_single_pod main || fail "more than one pod after the rollout"
[ "$(podjson main | jq -r .metadata.uid)" != "$before" ] || fail "rollout restart did not replace the pod"
in_pod main cookie.mjs MODE=get PROFILE=/data/profile > "$work/cookie-get.json" || fail "cookie get: $(cat "$work/cookie-get.json")"
jq -e --arg c "$cookie" '.cookie == $c' "$work/cookie-get.json" > /dev/null || fail "cookie lost after replacement: $(cat "$work/cookie-get.json")"
pass "profile written as UID 999 on the PVC kept its cookie in a replacement pod ($(jq -r .product "$work/cookie-get.json"))"

# 4. Saturation withdraws readiness without restarting the pod; capacity returns it.
h -n $NS upgrade main "$CHART" "${values[@]}" --set concurrent=1 --set queued=1 --wait --timeout 10m >> "$log" 2>&1 || fail "upgrade to concurrent=1 queued=1"
saturated_revision=$(h -n $NS history main -o json | jq '.[-1].revision')
p=$(podjson main)
uid=$(jq -r .metadata.uid <<< "$p")
[ "$(jq -r '.spec.containers[0].env[] | select(.name == "CONCURRENT") | .value' <<< "$p")" = 1 ] || fail "CONCURRENT not applied"
wait_ready_endpoints $svc 1 60 || fail "no ready endpoint before saturation"
in_pod main saturate.mjs N=2 HOLD_MS=45000 > "$work/saturate.jsonl" 2>&1 &
saturator=$!
for _ in $(seq 1 30); do grep -q '"phase":"saturated"' "$work/saturate.jsonl" && break; sleep 1; done
jq -e 'select(.phase == "saturated") | .opened == 1 and .extra == 429 and .pressure == 503' "$work/saturate.jsonl" > /dev/null ||
  fail "expected 1 running + 1 queued, extra request 429 and pressure 503: $(cat "$work/saturate.jsonl")"
wait_ready_endpoints $svc 0 25 || fail "saturated pod stayed a ready endpoint"
code=$(from_node "http://$svc_ip:3000/pressure")
[ "$code" = 000 ] || fail "Service accepted a connection while its only pod was unready ($code)"
p=$(podjson main)
jq -e --arg u "$uid" '.metadata.uid == $u and .status.containerStatuses[0].restartCount == 0 and .status.containerStatuses[0].state.running != null' <<< "$p" > /dev/null ||
  fail "saturation restarted or replaced the pod"
pass "saturated (1 running, 1 queued): extra request 429, /pressure 503, zero ready endpoints, Service refuses, no restart"
wait "$saturator" || fail "saturation client failed: $(cat "$work/saturate.jsonl")"
wait_ready_endpoints $svc 1 60 || fail "pod did not become ready after the sessions ended"
p=$(podjson main)
jq -e --arg u "$uid" '.metadata.uid == $u and .status.containerStatuses[0].restartCount == 0' <<< "$p" > /dev/null || fail "pod restarted during saturation"
jq -e 'select(.phase == "released") | .pressure == 200' "$work/saturate.jsonl" > /dev/null || fail "pressure did not recover: $(cat "$work/saturate.jsonl")"
pass "capacity freed: /pressure 200, ready endpoint restored, same pod, 0 restarts"

# 5. Rollback restores the previous revision, again with the profile intact.
h -n $NS rollback main $((saturated_revision - 1)) --wait --timeout 10m >> "$log" 2>&1 || fail "helm rollback"
wait_single_pod main || fail "more than one pod after the rollout"
p=$(podjson main)
[ "$(jq -r '.spec.containers[0].env[] | select(.name == "CONCURRENT") | .value' <<< "$p")" = 10 ] || fail "rollback did not restore CONCURRENT=10"
in_pod main cookie.mjs MODE=get PROFILE=/data/profile > "$work/cookie-rollback.json" || fail "cookie after rollback: $(cat "$work/cookie-rollback.json")"
jq -e --arg c "$cookie" '.cookie == $c' "$work/cookie-rollback.json" > /dev/null || fail "cookie lost after rollback"
pass "rollback to revision $((saturated_revision - 1)) restored CONCURRENT=10; profile cookie intact"

# 6. The token never reaches the logs of any pod the release ran.
hits=$(token_hits "$(pod main)")
[ "$hits" = 0 ] || fail "token appears $hits times in the pod log"
pass "token occurrences in the pod log: 0"

# 7. Guards: unusable credentials and unwritable volumes stop the container.
h -n $NS install empty "$CHART" --set token.existingSecret=empty-token >> "$log" 2>&1
expect_guard empty 'TOKEN must be nonempty' "empty token"
h -n $NS install non-ascii "$CHART" --set token.existingSecret=non-ascii-token >> "$log" 2>&1
expect_guard non-ascii 'printable ASCII' "non-ASCII token"
h -n $NS install missing "$CHART" --set token.existingSecret=does-not-exist >> "$log" 2>&1
waiting_reason missing CreateContainerConfigError 90 || fail "missing Secret: $(podjson missing | jq -c .status.containerStatuses)"
pass "missing Secret: CreateContainerConfigError, never started"
docker exec "$node" sh -c 'mkdir -p /var/local/unwritable && chown 0:0 /var/local/unwritable && chmod 0755 /var/local/unwritable'
k apply -f - > /dev/null << EOF
apiVersion: v1
kind: PersistentVolume
metadata: {name: e2e-unwritable}
spec:
  capacity: {storage: 1Gi}
  accessModes: [ReadWriteOnce]
  storageClassName: ""
  persistentVolumeReclaimPolicy: Retain
  hostPath: {path: /var/local/unwritable, type: Directory}
  claimRef: {namespace: $NS, name: unwritable}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: unwritable, namespace: $NS}
spec: {accessModes: [ReadWriteOnce], storageClassName: "", volumeName: e2e-unwritable, resources: {requests: {storage: 1Gi}}}
EOF
h -n $NS install readonly "$CHART" --set token.existingSecret=token --set persistence.existingClaim=unwritable >> "$log" 2>&1
expect_guard readonly 'is not writable by UID 999' "root-owned 0755 volume (fsGroup does not apply to hostPath)"
for p in $(k -n $NS get pods -o name); do
  hits=$(token_hits "${p#pod/}")
  prev=$(token_hits "${p#pod/}" --previous)
  [[ $hits = 0 && $prev = 0 ]] || fail "token in logs of $p"
done
pass "token occurrences in all current and previous container logs: 0"

# 8. Uninstall removes the release's objects and leaves the user-owned PVC.
for release in empty non-ascii missing readonly main; do
  h -n $NS uninstall "$release" --wait --timeout 5m >> "$log" 2>&1 || fail "uninstall $release"
done
left=$(k -n $NS get deployments,services -l app.kubernetes.io/name=browserless -o name | wc -l | tr -d ' ')
[ "$left" = 0 ] || fail "$left Deployments or Services left after uninstall"
# The garbage collector removes the Deployments' ReplicaSets and pods afterwards.
for _ in $(seq 1 120); do
  left=$(k -n $NS get replicasets,pods -l app.kubernetes.io/name=browserless -o name | wc -l | tr -d ' ')
  [ "$left" = 0 ] && break
  sleep 1
done
[ "$left" = 0 ] || fail "$left ReplicaSets or pods still present 120 s after uninstall"
k -n $NS get pvc data > /dev/null || fail "uninstall deleted the user-owned PVC"
pass "uninstall removed every chart object and, after garbage collection, their pods; PVC data retained"
