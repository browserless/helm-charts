# Browserless Helm chart

A minimal, dependency-free chart for one Browserless Chromium instance: a
Deployment and a ClusterIP Service. It needs Helm 4, Linux amd64 or arm64 nodes
and a maintained Kubernetes version (see [Compatibility](#compatibility)). The
default image is the `ghcr.io/browserless/chromium` release that `image.tag`
names in [`values.yaml`](charts/browserless/values.yaml); the chart's
`appVersion` always names the same release.

## Quick start

Needs Helm 4, kubectl with access to a cluster, git, OpenSSL and curl. Until a
chart version is published, install from a clone of this repository as below;
for a published version, install its verified digest instead (see
[Releases](#releases)).

```sh
git clone https://github.com/browserless/helm-charts.git && cd helm-charts
rm -f token.txt port-forward.log
(umask 077 && openssl rand -hex 24 | tr -d '\n' > token.txt)
kubectl create namespace browserless
kubectl -n browserless create secret generic browserless-token --from-file=TOKEN=token.txt
helm install browserless ./charts/browserless --namespace browserless \
  --set token.existingSecret=browserless-token --wait --timeout 10m
kubectl -n browserless port-forward --address 127.0.0.1 \
  service/browserless-browserless 3000:3000 > port-forward.log & PF=$!
until grep -qs Forwarding port-forward.log || ! kill -0 "$PF" 2>/dev/null; do sleep 1; done
grep -q Forwarding port-forward.log &&
printf 'Authorization: Bearer %s\n' "$(cat token.txt)" |
  curl -sS -H @- -H 'Content-Type: application/json' \
  -d '{"html":"<p id=answer></p><script>answer.textContent = 6 * 7</script>"}' \
  http://127.0.0.1:3000/chromium/content
```

The request returns the page as Chromium rendered it, with `<p id="answer">42</p>`.
`rm` clears files left by an earlier run, so `token.txt` is new and holds a
random token that only you can read, and the log shows only this port-forward.
The port-forward runs in the background of this shell and listens only on
127.0.0.1; the request is sent only once kubectl reports that it is forwarding,
so if port 3000 is already in use, kubectl prints an error and nothing is sent.
curl reads the token header from standard input, so the token is not in its
command line, which other users of the machine can list. To remove everything,
from the same shell:

```sh
kill "$PF"
helm uninstall browserless --namespace browserless
kubectl delete namespace browserless && rm token.txt port-forward.log
```

Keep real tokens in a secret manager or a protected file, never in Helm values
or source control; the chart only reads the Secret and creates none. The token
must be nonempty printable ASCII without whitespace; otherwise the container
exits 2 before starting, because Bearer authentication and the readiness probe
cannot carry it. A missing Secret or key keeps the container from starting.
`token.key` defaults to `TOKEN`. Rotating the token needs a pod restart. Release
names must start with a lowercase letter and contain only lowercase letters,
digits and `-`.

## Configuration and limits

[`values.yaml`](charts/browserless/values.yaml) is the complete surface; other
keys are rejected, except Helm's `global`, so the chart also works as a
dependency.

- **Image:** a nonempty `image.digest` replaces the tag. Custom images must keep
  the upstream Node runtime, working directory and `./scripts/start.sh`.
- **Admission:** `concurrent`, `queued` and `timeout` (milliseconds) set the
  image's `CONCURRENT`, `QUEUED` and `TIMEOUT` and default to its own values.
  They must be at least 1, 0 and 1; unlimited or disabled settings are not
  supported. Requests beyond `concurrent` + `queued` get 429.
- **Memory:** the default resources are not sized for `concurrent` real pages.
  An out-of-memory kill stops the container and every session, and `/pressure`
  reports memory saturation only at 99% of the limit, so size
  `resources.limits.memory` for your workload or lower `concurrent`. `/dev/shm`
  is a memory-backed emptyDir (`shmSizeLimit`) that counts toward that budget.
- **Persistence:** `persistence.existingClaim` mounts an existing PVC at
  `persistence.mountPath`; clients choose profile directories such as
  `--user-data-dir=/data/<profile>`. The default `fsGroup: 999` makes most block
  volumes writable by the browser user. Volumes that ignore `fsGroup` (hostPath,
  many NFS and some CSI drivers) must already be writable by UID 999, or the
  container exits 2 instead of silently losing profiles. Do not mount it over
  the application, home, temporary or shared-memory paths (`/usr/src/app`,
  `/home/blessuser`, `/tmp`, `/dev/shm`). One profile supports one browser at a
  time, and a browser killed abruptly leaves `Singleton*` lock files that a
  replacement pod cannot get past until they are removed.
- **Cookies:** in tests, cookies changed less than about 30 s before a session
  ended were missing from the profile afterwards (Chromium writes them on a
  timer), so keep a session open at least 30 s after changes that must
  persist. The default `timeout` ends sessions after 30 s; raise it or pass
  `&timeout=<ms>` when connecting.
- **Security:** the defaults meet the restricted Pod Security Standard (UID 999,
  no privilege escalation, no capabilities, runtime-default seccomp) and mount no
  service-account token. The root filesystem stays writable for Chromium. The
  chart sets `DEBUG` without debug-level logs, which print launch options
  including `TOKEN`.
- **Updates:** exactly one replica with Recreate updates, so every upgrade
  interrupts service and can end active sessions, and a failed upgrade (for
  example an unpullable image) leaves no ready pod until a rollback. Check that a
  new image exists for your nodes' architecture first. Upgrade with all your
  values every time, for example the same values file (`-f`): an upgrade that
  passes any `--set` or `-f` resets every value it omits to the chart default,
  so one that sets only the token Secret drops `persistence.existingClaim`. A
  values file that sets `image.digest` or `image.tag` keeps that image across
  chart upgrades. There is no draining, autoscaling, Ingress, TLS or
  NetworkPolicy, and no claim of high availability or tenant isolation.

## Probes

Readiness runs Node in the container against authenticated `/pressure` with
`Accept: text/plain`, which returns 503 when saturated (its JSON form returns 200
either way). Startup and liveness only check TCP, so load takes the pod out of
the Service instead of restarting it; with one replica, clients must retry while
it has no ready endpoint.

## Compatibility

The chart supports the Kubernetes minor versions that the Kubernetes project
currently [maintains](https://kubernetes.io/releases/). Kubernetes has no
long-term-support releases: it maintains the three newest minor versions, each
for about a year. `kubeVersion` in [`Chart.yaml`](charts/browserless/Chart.yaml)
admits exactly those minor versions, and CI runs the runtime tests on each of
them on amd64 and arm64, with the kind node images published for the kind
release in [`tools/go.mod`](tools/go.mod) (see
[kind releases](https://github.com/kubernetes-sigs/kind/releases)). The tested
versions are the directories in [`tests/kind`](tests/kind) and the `e2e` matrix
in [`ci.yml`](.github/workflows/ci.yml); the chart tests fail unless these and
`kubeVersion` agree. The `-0` suffixes in `kubeVersion` admit vendor builds such
as `-gke.N`, which semver reads as pre-releases.

When a new Kubernetes minor version is released and kind publishes a node image
for it, add its `tests/kind/<minor>` directory and matrix entry and raise the
`kubeVersion` ceiling; when a minor version reaches end of life, remove it and
raise the floor. Each such change is a chart release.

kind clusters do not stand in for every environment: before production use,
repeat the checks below where the chart will run, including storage
permissions, admission policies, image pulls and the upgrade interruption.

## Development

Needs Node.js of the major version in [`.nvmrc`](.nvmrc) (CI uses its latest
release), Docker, jq, OpenSSL and ShellCheck:

```sh
npm ci
node scripts/install-tools.ts            # Helm, kind and actionlint into .bin/
npm run typecheck && npm test            # the CI static job, with the two lines below
.bin/actionlint
shellcheck scripts/*.sh tests/e2e/*.sh
tests/e2e/kind.sh                         # newest tests/kind version
KIND_CONFIG=tests/kind/<minor>/cluster.yaml tests/e2e/kind.sh
UPGRADE_FROM=oci://ghcr.io/browserless/charts/browserless tests/e2e/kind.sh
```

`npm test` runs the chart tests (schema, defaults and overrides, entrypoint
guards, Kubernetes and runner coverage, lint, package contents and
reproducibility, use as a dependency) and the tool installer's tests. Node runs
the TypeScript directly; `npm run typecheck` checks it with `tsc`. npm packages
are third-party code, so jobs that can push, publish, sign or read an
environment's secrets install none and run only scripts that import Node
built-ins. A chart test checks the common ways this could regress; it is not a
complete security analysis of the workflows.

`tests/e2e/kind.sh` (the CI `e2e` jobs) installs the working tree on a
disposable kind cluster under the restricted Pod Security Standard and checks
real browser requests and authentication through the pod and the Service, a
profile on a PVC surviving pod replacement and rollback, saturation removing the
only endpoint without a restart and capacity restoring it, the token and volume
guards, that the token never reaches a log, uninstall keeping the PVC, and with
`UPGRADE_FROM` an upgrade that never runs two browsers at once. It deletes its
cluster unless `KEEP_CLUSTER=1` and writes redacted diagnostics to
`tests/e2e/out/`. Its sessions are idle: it shows admission behaviour, not
memory capacity.

### Tools

[`tools/`](tools) is not a Go program. Its `go.mod` is the list of Helm, kind and
actionlint versions, kept there because Dependabot updates Go modules;
nothing builds it, and you do not need Go. `scripts/install-tools.ts` downloads
each version's official release binary for the current platform and refuses it
unless its SHA-256 matches the checksum file published with the same release.
That proves integrity, not authenticity: a release whose binary and checksum file
were both replaced would pass, and `tools/go.sum`, which Dependabot maintains,
does not attest the binaries.

## Releases

Pull requests are squash-merged with the pull request title as the commit
subject and a blank body (`squash_merge_commit_title=PR_TITLE`,
`squash_merge_commit_message=BLANK`), and titles must be Conventional Commits
(`pr-title.yml`). [Release Please](https://github.com/googleapis/release-please)
reads them: `feat` raises the minor version; `fix`, `perf`, `revert` and `build`
the patch version; `chore`, `ci`, `docs`, `style`, `refactor` and `test` release
nothing. Mark a breaking change with `!` in the title (`feat!: ...`), which
raises the major version; footers in the body are not kept. Dependabot's image
updates are `build` commits, so a new Browserless image is a patch release.

Release Please keeps a draft release pull request per chart that sets
`Chart.yaml` `version`, the chart's `CHANGELOG.md` and
`.release-please-manifest.json`. Merging it creates the tag `<chart>-v<version>`
and its GitHub Release, which starts `publish.yml`. From the tag, a job without
write access repeats the chart tests and checks `appVersion`. The publishing
job then runs `scripts/publish-chart.sh`, which refuses unless the checkout is
the tag, the tag is on `main`, and the chart version and manifest agree. It
refuses to overwrite an existing version, packages reproducibly (times come
from the tag's commit), pushes to `oci://ghcr.io/browserless/charts/browserless`,
and pulls the chart back to compare bytes and digest. The job then records a
signed SLSA provenance attestation for the pushed manifest digest and verifies
it.

If `publish.yml` fails before its push, rerun it. If it fails during or after
the push, or a rerun finds the version already exists, treat that version as
failed: do not use, delete, overwrite or describe it as verified, note this in
its GitHub Release, and release the next patch version with a `fix:` pull request
that changes `charts/browserless` (a `ci:` change releases nothing).

The registry alone does not prove where a chart came from: anyone with write
access to this repository can push packages with a workflow's `GITHUB_TOKEN`.
Only a digest whose attestation `publish.yml` signed for the version's tag
identifies a published chart. Resolve the digest once, verify it, and install
that digest, not the version tag:

```sh
CHART=oci://ghcr.io/browserless/charts/browserless VERSION=<version>
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

### Repository settings

- A `release-please` environment limited to `main`, without administrator
  bypass, holding the release GitHub App's client ID (`RELEASE_APP_CLIENT_ID`
  variable) and private key (`RELEASE_APP_PRIVATE_KEY` secret). The App needs
  Contents, Pull requests and Issues write access. `release-please.yml` fails
  without them instead of falling back to `GITHUB_TOKEN`, whose pull requests
  and releases would trigger no workflows. Code that runs in that job on `main`
  can read the key, so the `main` ruleset decides who controls it.
- A `chart-release` environment with required reviewers, without administrator
  bypass, limited to `browserless-v*` tags. It is a single-person gate: the App
  starts the deployment, so preventing self-review does not stop whoever merged
  the release pull request from approving its publication.
- Tag rulesets for `browserless-v*`: only the release App may create these tags,
  and nobody may update or delete them.
- A `main` ruleset requiring pull requests with one approving review and
  approval of the most recent push, the GitHub Actions checks `static` and
  `kind`, squash merging only, and no force pushes or deletion. `kind` fails
  unless every `e2e` job passed, so the required checks stay the same when the
  tested Kubernetes versions change.
- Workflow `GITHUB_TOKEN` permissions default to read, GitHub Actions cannot
  approve pull requests, and workflows from all outside contributors need
  approval.

The release App is `browserless-actions-bot`, which `browserless/browserless`
also releases with. Each token `release-please.yml` creates is limited to this
repository and three permissions, but the App's keys are not: any of its keys,
wherever stored, can create tokens for every repository the App is installed on
with all its permissions, including Actions, secrets and environments, and
creating `browserless-v*` tags here. The App cannot change rulesets, and the
`chart-release` reviewers still decide what is published. After the first
publish, make the GHCR package public.

## Dependency updates

Dependabot ([`.github/dependabot.yml`](.github/dependabot.yml)) proposes updates
for the default image (`helm`, as `build` commits), workflow actions, Helm,
kind and actionlint (`gomod`, through `tools/go.mod`), the scripts' npm packages
and the kind node images (patch and digest updates only). It does not update
`appVersion`: `dependabot-app-version.yml` commits the matching `appVersion` to
Dependabot's image pull requests and starts CI for that commit. The PR title
check does not run again for it, which is why branch protection requires only
`static` and `kind`. `@dependabot recreate` drops the sync commit, and the
workflow adds it again. A node image that the pinned kind release cannot start
fails CI until kind is updated. Not covered: the Node.js patch release, and the
runner's ShellCheck, jq, OpenSSL and Docker; kubectl runs inside the kind node.

## Smoke test after installation

With the port-forward running:

```sh
TOKEN="$(cat token.txt)"
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/pressure   # 401
curl -i -H "Authorization: Bearer $TOKEN" -H 'Accept: text/plain' \
  http://localhost:3000/pressure                                           # 200 when idle
curl --fail-with-body -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"html":"<html><body><h1>Browserless works</h1></body></html>"}' \
  http://localhost:3000/screenshot -o /tmp/browserless-smoke.png
file /tmp/browserless-smoke.png
unset TOKEN
```

A port-forward connects to the pod directly; check EndpointSlices to see the
Service's endpoints.
