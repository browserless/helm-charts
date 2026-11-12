// Chart contract tests: schema validation, rendered defaults and overrides, the
// entrypoint guards, the Kubernetes versions, runners and Node.js version CI
// tests, lint and packaging. They do not prove that the container boots or that
// a browser works; tests/e2e/kind.sh does. Needs Helm 4 (HELM, default .bin/helm).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments } from 'yaml';

// Rendered manifests are untyped YAML.
type Json = any;

const root = fileURLToPath(new URL('..', import.meta.url));
const chart = join(root, 'charts/browserless');
const HELM = process.env.HELM ?? join(root, '.bin/helm');
const tmp = mkdtempSync(join(tmpdir(), 'chart-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let dirs = 0;
const scratch = () => {
  const dir = join(tmp, String(dirs++));
  mkdirSync(dir);
  return dir;
};
const readYaml = (path: string): Json => parse(readFileSync(join(root, path), 'utf8'));

// Check every updater: zizmor 1.32.0 stops after its first compliant entry.
test('every Dependabot updater covers all dependencies with a three-day cooldown', () => {
  const { updates } = readYaml('.github/dependabot.yml');
  for (const ecosystem of ['helm', 'github-actions', 'gomod', 'npm', 'docker']) {
    assert.ok(updates.some((update: Json) => update['package-ecosystem'] === ecosystem), `missing ${ecosystem} updater`);
  }
  for (const update of updates) {
    const cooldown = update.cooldown;
    const name = update['package-ecosystem'];
    assert.ok(Number.isInteger(cooldown?.['default-days']) && cooldown['default-days'] >= 3, `${name}: explicit three-day cooldown required`);
    for (const key of ['semver-major-days', 'semver-minor-days', 'semver-patch-days']) {
      assert.ok(!(key in cooldown) || (Number.isInteger(cooldown[key]) && cooldown[key] >= 3), `${name}: ${key} bypasses cooldown`);
    }
    assert.ok(!('include' in cooldown) && !('exclude' in cooldown), `${name}: cooldown must cover every dependency`);
  }
});

test('CI actionlint uses the same version as tools/go.mod', () => {
  const version = readFileSync(join(root, 'tools/go.mod'), 'utf8').match(/github\.com\/rhysd\/actionlint v(\S+)/)?.[1];
  assert.ok(version);
  assert.equal(readYaml('.github/workflows/ci.yml').jobs.actionlint?.env.ACTIONLINT_VERSION, version);
});

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}, cwd?: string) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, ...env }, cwd });
  if (result.error) throw result.error;
  return { out: result.stdout, err: result.stderr, ok: result.status === 0 };
}
const helm = (...args: string[]) => run(HELM, args);
function valuesFile(values: Json): string {
  const file = join(scratch(), 'values.json');
  writeFileSync(file, JSON.stringify({ ...values, token: { existingSecret: 'browserless-token', ...values.token } }));
  return file;
}
function render(release = 'alpha', values: Json = {}): Json[] {
  const { out, err, ok } = helm('template', release, chart, '-f', valuesFile(values));
  assert.ok(ok, err);
  const docs = parseAllDocuments(out);
  for (const doc of docs) assert.deepEqual(doc.errors, []);
  return docs.map((doc) => doc.toJS()).filter((doc) => doc != null);
}
const kind = (docs: Json[], name: string): Json => docs.find((doc) => doc.kind === name);
// Runs the container's command with this machine's /bin/sh, from an empty directory.
const entrypoint = (command: string[], env: NodeJS.ProcessEnv) =>
  run(command[0] ?? '', command.slice(1), { LC_ALL: 'C', ...env }, scratch());
const files = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));

const defaults = render();
const deployment = kind(defaults, 'Deployment');
const pod = deployment.spec.template.spec;
const container = pod.containers[0];
const meta = readYaml('charts/browserless/Chart.yaml');

test('runs Helm 4', () => {
  assert.match(helm('version', '--template', '{{.Version}}').out, /^v4\./);
});

test('rejects a missing token Secret and invalid values', () => {
  const { out, err, ok } = helm('template', 'alpha', chart);
  assert.ok(!ok && (out + err).includes('existingSecret'), 'missing secret must fail');
  for (const values of [
    { token: { existingSecret: '' } },
    { token: { existingSecret: 'bad/name' } },
    { token: { key: '' } },
    { image: { tag: 123 } },
    { image: { digest: 'bad' } },
    { service: { port: '3000' } },
    { resources: [] },
    { persistence: { mountPath: 'relative' } },
    { replicaCount: 0 },
    { replicaCount: 1.5 },
    { replicaCount: '2' },
    { token: { value: 'plaintext' } },
    { concurrent: 0 },
    { concurrent: -1 },
    { queued: -1 },
    { timeout: 0 },
    { timeout: '30000' },
    { resources: { limits: { memory: '2mi' } } },
    { resources: { limits: { cpu: '1ki' } } },
  ]) {
    const result = helm('template', 'alpha', chart, '-f', valuesFile(values));
    assert.ok(!result.ok && result.err.includes('schema'), `invalid values accepted: ${JSON.stringify(values)}`);
  }
});

test('replicas', () => {
  const docs = render('alpha', { replicaCount: 3 });
  const replicated = kind(docs, 'Deployment');
  assert.equal(replicated.spec.replicas, 3, 'replicaCount sets the replicas');
  assert.equal(replicated.spec.strategy.type, 'Recreate', 'an upgrade still stops every replica first');
  assert.deepEqual(kind(docs, 'Service').spec.selector, replicated.spec.selector.matchLabels, 'the Service selects every replica');
  assert.equal(replicated.spec.selector.matchLabels['app.kubernetes.io/instance'], 'alpha', 'and only pods of its own release');
  // A browser profile supports one browser at a time, so replicas must not share a volume.
  // The schema rejects it, also for helm lint, which ignores the template's fail;
  // the template guard covers installs that skip schema validation.
  for (const replicaCount of [2, 3]) {
    const values = valuesFile({ replicaCount, persistence: { existingClaim: 'data' } });
    const lint = helm('lint', chart, '-f', values);
    assert.ok(!lint.ok && (lint.out + lint.err).includes("'/persistence/existingClaim'"), `lint must reject replicaCount ${replicaCount} with a claim: ${lint.out}${lint.err}`);
    const guard = helm('template', 'alpha', chart, '--skip-schema-validation', '-f', values);
    assert.ok(!guard.ok && guard.err.includes('replicaCount above 1 cannot be combined with persistence.existingClaim'), `the template must reject replicaCount ${replicaCount} with a claim: ${guard.err}`);
  }
  const single = kind(render('alpha', { replicaCount: 1, persistence: { existingClaim: 'data' } }), 'Deployment');
  assert.equal(single.spec.replicas, 1, 'one replica may use a claim');
  assert.equal(single.spec.template.spec.volumes.find((v: Json) => v.name === 'data').persistentVolumeClaim.claimName, 'data', 'and mounts it');
});

test('default rendering', () => {
  assert.deepEqual(defaults.map((doc) => doc.kind).sort(), ['Deployment', 'Service'], 'only Deployment and Service');
  const service = kind(defaults, 'Service');
  // Dependabot updates the tag, so derive it; it must stay a pinned release that appVersion names.
  const tag = readYaml('charts/browserless/values.yaml').image.tag;
  assert.match(tag, /^v\d+\.\d+\.\d+$/, 'default image tag must be a pinned release');
  assert.equal(container.image, `ghcr.io/browserless/chromium:${tag}`, 'public pinned image');
  assert.equal(meta.appVersion, tag.replace(/^v/, ''), 'appVersion names the default image release');
  // Helm publishes the first source as the OCI package's org.opencontainers.image.source.
  assert.equal(meta.sources[0], 'https://github.com/browserless/helm-charts', 'the chart repository is the first source');
  assert.equal(deployment.spec.replicas, 1, 'one replica by default');
  assert.equal(deployment.spec.strategy.type, 'Recreate', 'no overlapping PVC users during upgrade');
  assert.equal(service.spec.type, 'ClusterIP', 'internal service');
  assert.deepEqual(service.spec.selector, deployment.spec.selector.matchLabels, 'selectors agree');
  assert.equal(pod.automountServiceAccountToken, false, 'no Kubernetes API token');
  assert.deepEqual(
    container.env.find((e: Json) => e.name === 'TOKEN'),
    { name: 'TOKEN', valueFrom: { secretKeyRef: { name: 'browserless-token', key: 'TOKEN' } } },
    'secret reference only',
  );
  assert.ok(container.command.join(' ').includes('TOKEN:?'), 'empty secret fails closed');
  const env = Object.fromEntries(container.env.map((e: Json) => [e.name, e.value]));
  assert.deepEqual([env.CONCURRENT, env.QUEUED, env.TIMEOUT], ['10', '10', '30000'], 'admission limits default to the image defaults');
  assert.ok(!('PERSISTENCE_MOUNT_PATH' in env), 'no writability check without a volume');
  assert.ok(env.DEBUG.split(',').includes('-**:debug'), 'debug logs that print TOKEN stay disabled');
  assert.deepEqual(
    pod.securityContext,
    { fsGroup: 999, fsGroupChangePolicy: 'OnRootMismatch', seccompProfile: { type: 'RuntimeDefault' } },
    'restricted pod defaults',
  );
  assert.deepEqual(
    container.securityContext,
    { runAsNonRoot: true, runAsUser: 999, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
    'restricted container defaults',
  );
  assert.deepEqual(pod.volumes, [{ name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '1Gi' } }], 'memory-backed shared memory');
  assert.ok('tcpSocket' in container.startupProbe && 'tcpSocket' in container.livenessProbe, 'capacity must not restart pods');
  const probe = container.readinessProbe.exec.command;
  assert.deepEqual(probe.slice(0, 2), ['node', '-e'], 'readiness uses the image Node runtime');
  const script = probe.at(-1);
  assert.ok(
    script.includes('text/plain') && script.includes('/pressure') && script.includes('process.env.TOKEN'),
    'authenticated saturation-sensitive readiness',
  );
});

test('the entrypoint stops on unusable tokens', () => {
  const empty = entrypoint(container.command, { TOKEN: '' });
  assert.ok(!empty.ok && empty.err.includes('TOKEN must be nonempty'), 'empty token blocks the entrypoint');
  // The image's /bin/sh (dash) matches bytes; LC_ALL=C makes other shells do the same.
  for (const token of ['token\n', 'two words', '\ttoken', ' ', 'tok\u00e9n', 'tok\u20acn', 'tok\x7fn']) {
    const result = entrypoint(container.command, { TOKEN: token });
    assert.ok(!result.ok && result.err.includes('printable ASCII'), `unusable token accepted: ${JSON.stringify(token)}`);
  }
  assert.ok(!entrypoint(container.command, { TOKEN: 'valid-Token_1.x~!' }).err.includes('TOKEN must'), 'a valid token passes the guard');
});

test('custom values', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const custom = render('beta', {
    concurrent: 3,
    queued: 0,
    timeout: 1_800_000,
    image: { repository: 'example.org/chromium', tag: 'other', digest },
    token: { existingSecret: 'custom-token', key: 'password' },
    service: { port: 8080 },
    resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: 2, memory: '3Gi' } },
    shmSizeLimit: '512Mi',
    persistence: { existingClaim: 'browser-data', mountPath: '/data' },
    nodeSelector: { 'kubernetes.io/arch': 'amd64' },
    tolerations: [{ key: 'browser', operator: 'Exists' }],
    affinity: { nodeAffinity: {} },
    podSecurityContext: { fsGroup: 999 },
    securityContext: { runAsUser: 999, runAsNonRoot: true },
    imagePullSecrets: [{ name: 'registry' }],
  });
  const customPod = kind(custom, 'Deployment').spec.template.spec;
  const c = customPod.containers[0];
  assert.equal(c.image, `example.org/chromium@${digest}`, 'digest wins over tag');
  assert.deepEqual(c.env[0].valueFrom.secretKeyRef, { name: 'custom-token', key: 'password' }, 'custom secret');
  assert.equal(kind(custom, 'Service').spec.ports[0].port, 8080, 'custom service port');
  assert.deepEqual(c.resources.limits, { cpu: 2, memory: '3Gi' }, 'custom resources, including a plain-number quantity');
  const env = Object.fromEntries(c.env.map((e: Json) => [e.name, e.value]));
  assert.deepEqual([env.CONCURRENT, env.QUEUED, env.TIMEOUT], ['3', '0', '1800000'], 'typed admission limits, never in exponent form');
  assert.equal(env.PERSISTENCE_MOUNT_PATH, '/data', 'mounted volume path passed to the writability check');
  const writable = scratch();
  const readonly = join(writable, 'readonly');
  mkdirSync(readonly, { mode: 0o555 });
  const blocked = entrypoint(c.command, { TOKEN: 'token', PERSISTENCE_MOUNT_PATH: readonly });
  assert.ok(!blocked.ok && blocked.err.includes('is not writable by UID'), 'an unwritable volume stops the container');
  assert.ok(!entrypoint(c.command, { TOKEN: 'token', PERSISTENCE_MOUNT_PATH: writable }).err.includes('not writable'), 'a writable volume passes');
  assert.equal(customPod.volumes.at(-1).persistentVolumeClaim.claimName, 'browser-data', 'existing PVC');
  assert.equal(c.volumeMounts.at(-1).mountPath, '/data', 'PVC mount');
  assert.equal(customPod.volumes[0].emptyDir.sizeLimit, '512Mi', 'custom shm');
  assert.equal(customPod.nodeSelector['kubernetes.io/arch'], 'amd64', 'node selector');
  assert.equal(customPod.tolerations[0].key, 'browser', 'tolerations');
  assert.ok('nodeAffinity' in customPod.affinity, 'affinity');
  assert.equal(customPod.securityContext.fsGroup, 999, 'pod security override');
  assert.equal(c.securityContext.runAsUser, 999, 'container security override');
  assert.deepEqual(customPod.imagePullSecrets, [{ name: 'registry' }], 'image pull secrets');
  const names = (docs: Json[]) => docs.map((doc) => doc.metadata.name);
  assert.deepEqual(names(defaults).filter((name) => names(custom).includes(name)), [], 'release names isolated');
  assert.notDeepEqual(deployment.spec.selector.matchLabels, kind(custom, 'Deployment').spec.selector.matchLabels, 'release selectors isolated');
});

test('release names', () => {
  assert.ok(render('a'.repeat(53)).every((doc) => doc.metadata.name.length <= 63), 'valid longest Helm release name');
  for (const release of ['123', '1abc', 'a.b']) {
    const result = helm('template', release, chart, '--set', 'token.existingSecret=browserless-token');
    assert.ok(!result.ok && result.err.includes('release name must start with a lowercase letter'), `invalid Service name prefix accepted: ${release}`);
  }
});

// The chart supports the Kubernetes minor versions the Kubernetes project
// maintains, and CI runs the runtime tests on each of them on both runners: one
// tests/kind/<minor> directory per version, the e2e matrix and kubeVersion must agree.
test('kubeVersion admits exactly the Kubernetes minor versions CI tests', () => {
  const minors = readdirSync(join(root, 'tests/kind')).map((dir) => {
    const match = /^(\d+)\.(\d+)$/.exec(dir);
    assert.ok(match, `tests/kind/${dir} is not named <major>.<minor>`);
    return { dir, major: Number(match[1]), minor: Number(match[2]) };
  });
  minors.sort((a, b) => a.major - b.major || a.minor - b.minor);
  const first = minors[0];
  const last = minors.at(-1);
  assert.ok(first && last, 'tests/kind lists at least one Kubernetes version');
  minors.forEach(({ dir, major, minor }, i) => {
    assert.equal(major, first.major, 'one Kubernetes major version');
    if (i > 0) assert.equal(minor, (minors[i - 1]?.minor ?? NaN) + 1, 'tested minor versions are consecutive');
    const { nodes } = readYaml(`tests/kind/${dir}/cluster.yaml`);
    assert.equal(nodes.length, 1, `tests/kind/${dir}: one node`);
    assert.match(nodes[0].image, new RegExp(`^kindest/node:v${major}\\.${minor}\\.\\d+@sha256:[0-9a-f]{64}$`), `tests/kind/${dir}: node image pinned by digest`);
  });
  // -0 admits versions with a pre-release part, which is how semver reads
  // vendor builds such as v1.35.3-gke.1, also for Helm 3 based tools; the
  // ceiling excludes pre-releases of the next minor version.
  const major = first.major;
  assert.equal(meta.kubeVersion, `>=${major}.${first.minor}.0-0 <${major}.${last.minor + 1}.0-0`);
  const accepts = (version: string) => helm('template', 'k', chart, '--set', 'token.existingSecret=t', '--kube-version', version).ok;
  for (const version of [`v${major}.${first.minor}.0`, `v${major}.${first.minor}.3-gke.1245000`, `v${major}.${last.minor}.2-eks-ab12cd3`, `v${major}.${last.minor}.99+k3s1`]) {
    assert.ok(accepts(version), `Kubernetes ${version} rejected`);
  }
  for (const version of [`v${major}.${first.minor - 1}.99`, `v${major}.${last.minor + 1}.0`, `v${major}.${last.minor + 1}.0-alpha.1`]) {
    assert.ok(!accepts(version), `Kubernetes ${version} accepted`);
  }
  const ci = readYaml('.github/workflows/ci.yml');
  assert.deepEqual(ci.jobs.e2e.strategy.matrix.kubernetes, minors.map(({ dir }) => dir), 'the e2e matrix runs every tests/kind version');
  assert.deepEqual(ci.jobs.e2e.strategy.matrix.runner, ['ubuntu-26.04', 'ubuntu-26.04-arm'], 'the e2e matrix runs on amd64 and arm64');
  // Branch protection requires `kind`, which must fail unless every e2e job
  // passed; it checks each leg because the matrix result can hide a cancelled one.
  assert.equal(ci.jobs.kind.if, 'always()');
  assert.deepEqual(ci.jobs.kind.needs, ['static', 'e2e']);
  assert.equal(ci.jobs.e2e.outputs.legs, '${{ strategy.job-total }}');
  assert.equal(ci.jobs.kind.steps[0].env.LEGS, '${{ needs.e2e.outputs.legs }}');
});

// npm packages are third-party code. A job that can write to the repository or
// packages, sign, or read an environment's secrets installs none, and every
// script it runs, directly or from a shell script, imports only Node built-ins.
test('jobs that can write, sign or read secrets run no npm packages', () => {
  const builtinsOnly = (script: string, where: string) => {
    for (const [, from] of readFileSync(join(root, script), 'utf8').matchAll(/\bfrom '([^']+)'/g)) {
      assert.match(from ?? '', /^node:/, `${where} runs ${script}, which imports ${from}`);
    }
  };
  const dir = join(root, '.github/workflows');
  const privileged: string[] = [];
  for (const file of readdirSync(dir).filter((name) => /\.ya?ml$/.test(name))) {
    const workflow: Json = parse(readFileSync(join(dir, file), 'utf8'));
    for (const [id, job] of Object.entries<Json>(workflow.jobs)) {
      // No permissions key means the token's default permissions.
      const permissions = job.permissions ?? workflow.permissions;
      const writes = permissions === undefined || permissions === 'write-all' || Object.values(permissions).includes('write');
      if (!job.environment && !writes) continue;
      const where = `${file} ${id}`;
      privileged.push(where);
      for (const { run = '' } of job.steps) {
        assert.doesNotMatch(run, /\b(npm|npx|pnpm|yarn|corepack)\b/, `${where} runs a package manager`);
        for (const [, script] of run.matchAll(/\b(scripts\/[\w-]+\.ts)\b/g)) builtinsOnly(script ?? '', where);
        for (const [, shell] of run.matchAll(/\b(scripts\/[\w-]+\.sh)\b/g)) {
          for (const [, script] of readFileSync(join(root, shell ?? ''), 'utf8').matchAll(/\b(scripts\/[\w-]+\.ts)\b/g)) {
            builtinsOnly(script ?? '', `${where} (${shell})`);
          }
        }
      }
    }
  }
  assert.deepEqual(privileged.sort(), [
    'dependabot-app-version.yml push',
    'publish.yml publish',
    'release-please.yml release-please',
  ]);
  // Both jobs check out the release event's commit, so the publishing job
  // publishes the commit the read-only verify job tested.
  const publish = readYaml('.github/workflows/publish.yml');
  for (const job of ['verify', 'publish']) assert.equal(publish.jobs[job].steps[0].with.ref, '${{ github.sha }}', job);
});

test('workflow jobs use approved Ubuntu runners', () => {
  const dir = join(root, '.github/workflows');
  for (const file of readdirSync(dir).filter((name) => /\.ya?ml$/.test(name))) {
    const workflow: Json = parse(readFileSync(join(dir, file), 'utf8'));
    for (const [id, job] of Object.entries<Json>(workflow.jobs)) {
      assert.ok(['ubuntu-slim', 'ubuntu-26.04', '${{ matrix.runner }}'].includes(job['runs-on']), `${file} ${id} runs on ${job['runs-on']}`);
    }
  }
});

// Dependabot ignores major @types/node updates, so a change of the Node.js
// major version in .nvmrc must also change engines and the types.
test('.nvmrc, engines and @types/node name the same Node.js major version', () => {
  const major = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
  assert.match(major, /^\d+$/);
  const range = `>=${major} <${Number(major) + 1}`;
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).engines.node, range);
  assert.equal(lock.packages[''].engines.node, range);
  assert.equal(lock.packages['node_modules/@types/node'].version.split('.')[0], major);
});

test('lint, package contents and reproducibility, packaged and dependency rendering', () => {
  const lint = helm('lint', chart, '--strict', '--set', 'token.existingSecret=browserless-token');
  assert.ok(lint.ok, lint.err);
  const dir = scratch();
  const packaged = helm('package', chart, '--destination', dir);
  assert.ok(packaged.ok, packaged.err);
  const archive = join(dir, readdirSync(dir).find((name) => name.endsWith('.tgz')) ?? '');
  const unpacked = join(dir, 'unpacked');
  mkdirSync(unpacked);
  assert.ok(run('tar', ['-xzf', archive, '-C', unpacked]).ok, 'package unpacks');
  const entries = files(unpacked);
  for (const file of entries) {
    assert.doesNotMatch(readFileSync(file, 'latin1'), /\/Users\/|\/home\/\w|\.worktrees|\.amp\//, `local path in package: ${file}`);
  }
  assert.deepEqual(
    entries.map((file) => relative(unpacked, file)).sort(),
    ['Chart.yaml', 'values.yaml', 'values.schema.json', 'templates/deployment.yaml', 'templates/service.yaml'].map((p) => `browserless/${p}`).sort(),
    'package entries',
  );
  // Release Please writes CHANGELOG.md into the chart directory; it must not ship.
  // With SOURCE_DATE_EPOCH (as publish-chart.sh sets it) the package is reproducible.
  const copy = join(dir, 'copy', 'browserless');
  cpSync(chart, copy, { recursive: true });
  writeFileSync(join(copy, 'CHANGELOG.md'), '# Changelog\n');
  for (const entry of readdirSync(copy, { recursive: true })) utimesSync(join(copy, String(entry)), 0, 0);
  const reproducible = (source: string, destination: string) => {
    const result = run(HELM, ['package', source, '--destination', destination], { SOURCE_DATE_EPOCH: '1700000000' });
    assert.ok(result.ok, result.err);
    return readFileSync(join(destination, readdirSync(destination)[0] ?? ''));
  };
  assert.deepEqual(reproducible(copy, join(dir, 'r1')), reproducible(chart, join(dir, 'r2')), 'package must be reproducible and exclude CHANGELOG.md and .helmignore');
  const packagedRender = helm('template', 'packaged', archive, '--set', 'token.existingSecret=browserless-token');
  assert.ok(packagedRender.ok, packagedRender.err);
  // Helm always passes `global` to dependencies, even when the parent sets none.
  const parent = join(dir, 'parent');
  mkdirSync(join(parent, 'charts'), { recursive: true });
  writeFileSync(join(parent, 'Chart.yaml'), 'apiVersion: v2\nname: parent\nversion: 1.0.0\n');
  copyFileSync(archive, join(parent, 'charts', basename(archive)));
  for (const extra of [[], ['--set', 'global.environment=test']]) {
    const result = helm('template', 'parent', parent, '--set', 'browserless.token.existingSecret=browserless-token', ...extra);
    assert.ok(result.ok && result.out.includes('kind: Deployment'), `dependency render failed: ${result.err}`);
  }
});
