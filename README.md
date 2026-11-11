# Browserless Helm chart

A minimal, dependency-free chart for one public Browserless Chromium instance.
Creates only a Deployment and ClusterIP Service. Requires Helm 4, a Linux
amd64 or arm64 node, and sufficient CPU/memory. The chart declares
`kubeVersion: >=1.25.0-0`; see [Compatibility](#compatibility) for the versions
actually tested. Default image: `ghcr.io/browserless/chromium:v2.62.0` (the
[v2.62.0 release](https://github.com/browserless/browserless/releases/tag/v2.62.0));
`appVersion` always names the default image release.

## Install

Create a namespace and a Secret containing a strong, nonempty token (use a secret
manager or a protected file; do not put the token in Helm values or source control).
The following assumes `token.txt` contains only the token, without a trailing newline:

```sh
kubectl create namespace browserless
kubectl -n browserless create secret generic browserless-token --from-file=TOKEN=token.txt
helm upgrade --install browserless ./charts/browserless \
  --namespace browserless --set token.existingSecret=browserless-token \
  --wait --timeout 10m
kubectl -n browserless port-forward service/browserless-browserless 3000:3000
```

No Secret is created by the chart. Missing references fail validation; nonexistent
Secrets/keys prevent container startup. The token must be printable ASCII
without whitespace: empty tokens, and tokens containing spaces, control or
non-ASCII characters (such as a trailing newline), exit before startup because
Bearer authentication and the readiness probe's HTTP header cannot carry them.
`token.key` defaults to `TOKEN`. Secret rotation requires a pod restart because
the token is read from the environment. Release names must start with a
lowercase letter and contain only lowercase letters, digits and `-`.

## Configuration and limits

See `charts/browserless/values.yaml` for the complete surface. Unsupported keys
are rejected; Helm's `global` values are accepted so the chart can be used as a
dependency. Set `image.repository`, `image.tag`, or `image.digest`; a nonempty
SHA-256 digest takes precedence over the tag. Custom images must preserve the
upstream Node runtime, working directory and `./scripts/start.sh` entrypoint.

`concurrent`, `queued` and `timeout` set the image's `CONCURRENT`, `QUEUED`
and `TIMEOUT` (milliseconds) and default to the image's own values: 10 running
browsers, 10 queued requests and 30000 ms. They must be at least 1, 0 and 1 ms
respectively: the image's unlimited settings (`-1`, `Infinity`) and its
disabled timeout (`0` or less) are unsupported. Requests beyond `concurrent` +
`queued` get 429. Resources default to requests of 500m CPU/1Gi memory and
limits of 2 CPU/2Gi. These defaults are not sized against each other: ten real
pages can exceed 2Gi, and on cgroup v2 an out-of-memory kill stops the whole
container and every session, while `/pressure` reports memory saturation only
at 99% of the limit. Size `resources.limits.memory` for `concurrent` browsers
of your workload, or lower `concurrent`. The saturation checks below used idle
browsers and prove admission behaviour, not memory capacity. `/dev/shm` is a
memory-backed emptyDir capped at 1Gi; used space consumes the memory budget.
Quantities accept Kubernetes suffixes or plain numbers, so
`--set resources.limits.cpu=2` works.

`persistence.existingClaim` optionally mounts an existing same-namespace PVC at
`persistence.mountPath` (default `/data`). The chart does not provision storage
or configure browser profiles to use it; clients choose a profile directory such
as `--user-data-dir=/data/<profile>`. The default `fsGroup: 999` makes volumes
whose root is owned by root writable by the browser user; keep it unless your
storage handles ownership itself. Some volumes ignore `fsGroup` (CSI drivers
with `fsGroupPolicy: None`, many NFS volumes, hostPath): if UID 999 cannot write
the mount path, the container exits 2 with `persistence volume ... is not
writable`, instead of running with profiles that are silently not saved. Do not
mount over application, home, temporary, or shared-memory paths.

Chromium releases a profile cleanly when its session ends or when the pod stops
normally. If Chromium is killed (out of memory, node loss), its `Singleton*`
lock files remain and a replacement pod, which has a different hostname, cannot
open that profile until they are removed. One profile directory supports one
browser at a time.

Recent cookie changes can be lost when a session ends. With both v2.61.0 and
v2.62.0, a cookie set and then closed within 10 s was missing from the profile
afterwards, even in the same container; a cookie whose session stayed open for
30 s or more was kept, also across pod replacement. This matches Chromium
committing cookies to disk on a timer (about 30 s) rather than at session end.
Keep a session open for at least 30 s after changes that must persist. The
default `timeout` of 30000 ms ends every session 30 s after it starts, so a
change made during a session is likely lost: raise `timeout`, or add
`&timeout=<ms>` to the connection URL, so that it covers the last change plus
30 s.

Placement supports `nodeSelector`, `tolerations`, and `affinity`. Security
defaults satisfy the restricted Pod Security Standard: UID 999 (the image's
`blessuser`), no privilege escalation, all capabilities dropped and the
runtime-default seccomp profile. The root filesystem stays writable for
Chromium/Xvfb temporary files. No Kubernetes service-account token is mounted.

The chart sets `DEBUG` to the image's default minus `debug`-level logs, because
v2.61.0 and v2.62.0 debug logs print browser launch options, including `TOKEN`
(with the image's default `DEBUG`, a v2.62.0 container logged the token three
times; with the chart's, never). Custom images must not rely on overriding
`DEBUG` through the chart.

Exactly one replica, with **Recreate** updates: upgrades interrupt service and
may terminate active sessions. No zero-downtime, session draining, autoscaling,
Ingress/TLS, public exposure, NetworkPolicy, or controller integration is provided.
Use the same install command to upgrade (retain your values explicitly). This
chart does not claim high availability or suitability for untrusted tenants.

A failed upgrade is an outage, not a no-op: Recreate stops the only pod before
the new one starts. With an unpullable image tag, the service has no ready
endpoint until `--wait` reaches its `--timeout` and then until a `helm rollback`
finishes; `--rollback-on-failure` automates the rollback but not the wait (about
67 s without a ready endpoint in the kind test). Before upgrading, check that
the new image reference exists for your nodes' architecture, for example with
`docker manifest inspect` or by pulling it on a node.

## Probes

Readiness runs Node inside the container and calls authenticated `/pressure`
with exactly `Accept: text/plain`: available returns 200, saturation returns 503.
The default JSON response returns 200 even when unavailable and must not be used
as an HTTP-status readiness check. Startup/liveness use TCP only, never pressure:
load must remove the instance from service, not cause restarts. TCP liveness does
not detect every application-level hang. With one replica, saturation can leave
the Service with no ready endpoints; clients must retry appropriately.

Semantics verified against upstream
[`v2.62.0` pressure route](https://github.com/browserless/browserless/blob/v2.62.0/src/routes/management/http/pressure.get.ts),
[authentication helpers](https://github.com/browserless/browserless/blob/v2.62.0/src/utils.ts),
and [image source](https://github.com/browserless/browserless/tree/v2.62.0/docker).

## Verify

Static checks (the CI `static` job) need Go, Ruby's standard library and
ShellCheck. `scripts/build-tools.sh` builds Helm, kind and actionlint into
`.bin/` at exactly the versions locked in `tools/go.mod` and `tools/go.sum`,
and fails unless each binary embeds that locked module and Helm is major
version 4:

```sh
scripts/build-tools.sh
HELM=.bin/helm ruby tests/chart_test.rb
scripts/sync-app-version.sh --check
.bin/actionlint && shellcheck scripts/*.sh tests/e2e/*.sh
```

The chart tests check default and custom values, invalid types and missing
authentication, digest precedence, that `appVersion` names the default image
tag, release isolation, probe wiring, `helm lint --strict`, package contents
and reproducibility, and rendering the packaged chart on its own and as a
dependency of another chart. They do not prove that the container boots or that
a real browser works.

Runtime tests (the CI `kind` job) run `tests/e2e/kind.sh`, which creates a
disposable kind cluster, installs the working-tree chart into a namespace that
enforces the restricted Pod Security Standard, and checks: the pod runs the
default image and the release reports the chart's `appVersion`; real Chromium
HTML rendering and screenshots with the token, 401 without it, through the pod
and the Service; a browser profile on a PVC keeps its cookie across pod
replacement; with `concurrent=1 queued=1`, two held sessions make an extra
request get 429 and `/pressure` 503, remove the only ready endpoint without
restarting the pod, and restore it when the sessions end; `helm rollback`
restores the previous settings and the profile; empty and non-ASCII tokens and
an unwritable volume stop the container with exit 2, and a missing Secret keeps
it from starting; the token never appears in any container log; and uninstall
removes the chart's objects but keeps the PVC. With `UPGRADE_FROM` set to an
earlier chart, it first installs that chart and checks that the upgrade never
runs two browser containers at once. It needs Docker, jq, OpenSSL, Perl and
Ruby:

```sh
scripts/build-tools.sh
tests/e2e/kind.sh                                         # newest tested Kubernetes
KIND_CONFIG=tests/kind/oldest/cluster.yaml tests/e2e/kind.sh
UPGRADE_FROM=oci://ghcr.io/browserless/charts/browserless tests/e2e/kind.sh
```

The script always deletes its cluster (unless `KEEP_CLUSTER=1`), writes its log
and diagnostics to `tests/e2e/out/`, replaces the generated token there with
`<redacted>` and fails if any copy remains. The saturation checks use idle
browsers and prove admission behaviour, not memory capacity.

## Compatibility

`kubeVersion: >=1.25.0-0` in `Chart.yaml` only blocks installation on older
clusters; it is not a statement that every later version was tested. CI runs
the runtime tests on Linux amd64 and arm64 against two kind node images:
`tests/kind/oldest` (Kubernetes 1.34) and `tests/kind/latest` (Kubernetes
1.37). Kubernetes 1.25 to 1.33 are accepted by the chart but untested. The
chart with image v2.62.0 also ran on a managed Kubernetes 1.36 cluster (amd64
nodes, network block storage): install under the namespace's admission policy,
browser smoke test, volume writes, a profile cookie kept after the pod moved to
another node, and saturation removing and restoring the ready endpoint without
a restart. Before production use,
repeat the checks below in the target environment and verify PVC permissions,
admission policies, image architecture and pull availability, and acceptable
upgrade interruption. This is not production capacity, memory sizing or
high-availability qualification.

## Releases

Pull request titles must be Conventional Commits (checked by `pr-title.yml`);
squash merges make them the commit subjects that
[Release Please](https://github.com/googleapis/release-please), configured in
`release-please-config.json`, reads. This needs the repository's squash merge
commit title set to the pull request title (`squash_merge_commit_title=PR_TITLE`)
and its message left blank (`squash_merge_commit_message=BLANK`). GitHub's
default title is the commit message of a single-commit pull request, which the
title check does not see, and its default message copies every commit message
into the body, where a stale `BREAKING CHANGE:` footer would raise the major
version. Mark a breaking change only with `!` in the title, for example
`feat!: remove a setting`; a footer in the pull request body is not carried into
the squash commit. Release Please keeps one draft release pull request per chart
that sets `Chart.yaml` `version`, `charts/<chart>/CHANGELOG.md` and
`.release-please-manifest.json`. `feat` raises the minor version, a breaking
change the major version, and `fix`, `perf`, `revert` and `build` the patch
version; `chore`, `ci`, `docs`, `style`,
`refactor` and `test` do not release. Dependabot's image updates are `build`
commits, so a new Browserless image becomes a patch release whose `appVersion`
names that image.

Merging a release pull request creates the tag `<chart>-v<version>` (for
example `browserless-v0.1.0`) and its GitHub Release. Only then does
`publish.yml` run: from the tag, it repeats the chart tests and runs
`scripts/publish-chart.sh`, which refuses unless the checkout is exactly the
tag, the tag is on `main`, and `Chart.yaml`, the release manifest and
`appVersion` agree. It refuses to overwrite a version the registry already
holds, packages reproducibly, pushes to
`oci://ghcr.io/browserless/charts/browserless` and pulls the chart back to
compare it byte for byte and check that the version resolves to the manifest
digest it pushed. File times and the manifest's creation time come from the
tag's commit, so the package and the manifest digest can be rebuilt from the
tag. The job then records a signed SLSA provenance attestation for that
manifest digest (also pushed to the registry) and verifies it, and its summary
shows the digest. The release notes do not, because editing the release would
need `contents: write` in the publish job. Creating the release pull request
never publishes.

If `publish.yml` fails before its push, rerun it. If it fails during or after
the push, for example in the attestation or verification step, or a rerun is
refused because the version already exists, that version is in the registry
without verified provenance. Treat it as failed: do not use, delete or
overwrite it, and do not describe it as verified; its tag cannot be reused.
Note in its GitHub Release that it must not be used, fix the cause, and release
the next patch version: merge a `fix:` pull request that changes
`charts/browserless` (Release Please releases a chart only for a releasable
commit in its directory, so a workflow-only `ci:` fix releases nothing), then
merge the release pull request it opens.

The registry alone does not prove where a chart came from. `chart-release`
approval gates only `publish.yml`: anyone with write access to this repository
can push a workflow on another branch whose `GITHUB_TOKEN` can write its
packages, including an existing version, and the registry does not prevent
overwrites. Only a digest whose attestation was signed by `publish.yml` for the
version's tag identifies a published chart. Resolve the version's digest once,
verify that digest, and install by the same digest, never by the version tag,
which can change in between:

```sh
CHART=oci://ghcr.io/browserless/charts/browserless VERSION=0.1.0
DIGEST="$(helm pull "$CHART" --version "$VERSION" --destination "$(mktemp -d)" |
  sed -n 's/^Digest: //p')" &&
[ -n "$DIGEST" ] &&
gh attestation verify "$CHART@$DIGEST" --repo browserless/helm-charts \
  --signer-workflow browserless/helm-charts/.github/workflows/publish.yml \
  --source-ref "refs/tags/browserless-v$VERSION" &&
helm upgrade --install browserless "$CHART@$DIGEST" \
  --namespace browserless --set token.existingSecret=browserless-token \
  --wait --timeout 10m
```

The manifest starts empty, so the first release pull request proposes the
initial version 0.1.0. Chart version 0.1.0 has not been published; its contents
changed during review, so packages built locally before its release carry the
same version with different contents and must not be distributed. Once a
version is published, every change needs a new version, which the next release
pull request provides.

Before the first push, the repository needs the following. A workflow that
names a missing environment creates it without any protection, so create both
environments first.

- A `release-please` environment whose deployments are limited to the `main`
  branch, without administrator bypass, holding a GitHub App's client ID in the
  `RELEASE_APP_CLIENT_ID` variable and its private key in the
  `RELEASE_APP_PRIVATE_KEY` secret. The App needs Contents, Pull requests and
  Issues read and write access. `release-please.yml` fails without them rather
  than falling back to `GITHUB_TOKEN`, whose release pull requests and releases
  would not trigger CI or publishing. Any code that runs in that job on `main`,
  such as a merged workflow or action change, can read the key, so the
  environment is only as strong as the `main` ruleset below, which decides who
  can change that code.
- A `chart-release` environment with required reviewers, without administrator
  bypass, whose deployments are limited to tags matching `browserless-v*`. This
  is a single-person gate: the release App, not a person, starts the
  deployment, so preventing self-review does not stop whoever merged the release
  pull request from approving its publication.
- Two tag rulesets for `browserless-v*`: one that lets only the release App
  create these tags, and one without exceptions that blocks updating and
  deleting them.
- A ruleset for `main`, added after the first push, that requires pull requests
  with one approving review and approval of the most recent reviewable push, and
  the checks `static`, `kind (ubuntu-24.04, Kubernetes oldest)`,
  `kind (ubuntu-24.04, Kubernetes latest)`,
  `kind (ubuntu-24.04-arm, Kubernetes oldest)` and
  `kind (ubuntu-24.04-arm, Kubernetes latest)` from GitHub Actions, allows
  squash merging only, and blocks force pushes and deletion.
- Workflow `GITHUB_TOKEN` permissions defaulting to read, and GitHub Actions not
  allowed to approve pull requests.

This repository uses the `browserless-actions-bot` App that
`browserless/browserless` also releases with, not an App of its own. Each token
`release-please.yml` creates is limited to this repository and to the three
permissions above, but the App's keys are not: any of them, including the one
`browserless/browserless` stores, can create tokens for every repository the
App is installed on, with all of the App's permissions. These include writing
Actions, Actions secrets and environment secrets and variables, and creating
`browserless-v*` tags here, so anyone or anything that can read one of those
keys can start a release of this chart. The App has no Administration
permission, so it cannot change rulesets, and the `chart-release` reviewers
still decide whether a release is published.

After the first publish, set the GHCR package's visibility to public.

## Dependency updates

Dependabot (`.github/dependabot.yml`) updates every pinned version CI uses
through ecosystems it supports natively:

| What | File | Ecosystem | Commit type |
| --- | --- | --- | --- |
| Browserless image (`image.tag`) and any chart dependencies | `charts/browserless/values.yaml`, `Chart.yaml` | `helm` | `build` (patch release) |
| Workflow actions, pinned by commit | `.github/workflows/*.yml` | `github-actions` | `ci` |
| Helm CLI, kind CLI, actionlint | `tools/go.mod`, `tools/go.sum` | `gomod` | `ci` |
| Kubernetes node images | `tests/kind/*/cluster.yaml` | `docker` | `ci` |

Dependabot does not update `appVersion`; `dependabot-app-version.yml` commits
the matching `appVersion` to Dependabot's image pull requests and starts CI for
that commit (pushes made with `GITHUB_TOKEN` trigger no workflows). CI on
Dependabot's own commit fails the `appVersion` check until then. The PR title
check does not run again for the new commit, so require only the `static` and
`kind` checks in branch protection, or re-run the title check by editing the
title. Dependabot stops rebasing a pull request that has commits from others;
`@dependabot recreate` drops the sync commit and the workflow adds it again.
The oldest node image only receives patch updates; raise its minor version
deliberately. A new node image that the pinned kind release cannot start fails
CI, so that update waits for the matching kind update. The tools are imported in
`tools/tools.go` rather than listed with Go's `tool` directive, which Dependabot
does not update. Not covered: the Go toolchain (CI uses the latest stable Go),
the runner's Ruby, ShellCheck, Perl and jq, and kubectl, which runs inside the
kind node and follows its image.

## Smoke test after installation

After installation and port-forwarding, run:

```sh
TOKEN="$(cat token.txt)"
# Expect 401 without authentication:
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/pressure
# Expect 200 when idle (503 when capacity or resource thresholds are exceeded):
curl -i -H "Authorization: Bearer $TOKEN" -H 'Accept: text/plain' \
  http://localhost:3000/pressure
# Exercise a real browser without external website access:
curl --fail-with-body -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"html":"<html><body><h1>Browserless works</h1></body></html>"}' \
  http://localhost:3000/screenshot -o /tmp/browserless-smoke.png
file /tmp/browserless-smoke.png
unset TOKEN
```

Port-forward connects directly to a pod; inspect EndpointSlices separately to
verify Service endpoint removal.
