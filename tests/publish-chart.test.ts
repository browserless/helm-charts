// Exercise the real packaging/publishing entrypoints in a disposable Git repo.
// PUBLISH_TEST_REGISTRY optionally enables push/pull tests against a local OCI
// registry; never point it at GHCR or another shared registry.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const helm = process.env.HELM ?? join(root, '.bin/helm');

test('publishes the prepared chart, preserves its timestamp, and rejects invalid releases', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'publish-chart-test-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  for (const name of ['scripts', 'charts']) cpSync(join(root, name), join(work, name), { recursive: true });
  cpSync(join(root, '.release-please-manifest.json'), join(work, '.release-please-manifest.json'));
  const version = JSON.parse(readFileSync(join(work, '.release-please-manifest.json'), 'utf8'))['charts/browserless'];
  const tag = `browserless-v${version}`;
  const epoch = 1700000123;
  const env = {
    ...process.env, HELM: helm, MAIN_REF: 'main', OCI_REGISTRY: '127.0.0.1:1',
    OCI_NAMESPACE: `test-${process.pid}`, PLAIN_HTTP: '1',
    REGISTRY_USER: '', REGISTRY_PASSWORD: '', GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '',
    GIT_AUTHOR_DATE: `${epoch} +0000`, GIT_COMMITTER_DATE: `${epoch} +0000`,
  };
  const run = (command: string, args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(command, args, { cwd: work, env: { ...env, ...extra }, encoding: 'utf8' });
    if (result.error) throw result.error;
    return { status: result.status, text: result.stdout + result.stderr };
  };
  const ok = (command: string, args: string[], extra?: NodeJS.ProcessEnv) => {
    const result = run(command, args, extra);
    assert.equal(result.status, 0, result.text);
    return result.text;
  };
  const rejects = (args: string[], message: RegExp) => {
    const result = run('bash', ['scripts/publish-chart.sh', ...args]);
    assert.notEqual(result.status, 0, result.text);
    assert.match(result.text, message);
  };
  ok('git', ['init', '-q', '-b', 'main']);
  ok('git', ['add', '.']);
  ok('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  ok('git', ['tag', tag]);
  const packages = join(work, 'packages');
  ok('bash', ['scripts/package-chart.sh', tag, packages]);
  const archive = join(packages, `browserless-${version}.tgz`);
  const bytes = readFileSync(archive);
  assert.equal(statSync(archive).mtimeMs, epoch * 1000);
  ok('bash', ['scripts/package-chart.sh', tag, join(work, 'second')]);
  assert.deepEqual(readFileSync(join(work, 'second', `browserless-${version}.tgz`)), bytes);
  // Neither untracked nor ignored chart files may enter a signed release.
  for (const name of ['injected.yaml', 'ignored.yaml']) {
    writeFileSync(join(work, '.git/info/exclude'), 'ignored.yaml\n');
    const injected = join(work, 'charts/browserless/templates', name);
    writeFileSync(injected, 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: injected\n');
    const result = run('bash', ['scripts/package-chart.sh', tag, packages]);
    assert.notEqual(result.status, 0, `${name} must be rejected`);
    assert.match(result.text, /chart files differ from tag/);
    rmSync(injected);
  }
  rejects([tag], /usage/);
  rejects([tag, join(work, 'absent.tgz')], /archive/);
  rejects(['../browserless-v1.0.0', archive], /not <chart>/);
  const wrong = join(work, 'wrong');
  mkdirSync(wrong);
  writeFileSync(join(wrong, 'Chart.yaml'), 'apiVersion: v2\nname: browserless\nversion: 99.0.0\n');
  ok(helm, ['package', wrong, '-d', wrong]);
  rejects([tag, join(wrong, 'browserless-99.0.0.tgz')], /archive.*version/);
  writeFileSync(join(wrong, 'Chart.yaml'), `apiVersion: v2\nname: other\nversion: ${version}\n`);
  ok(helm, ['package', wrong, '-d', wrong]);
  rejects([tag, join(wrong, `other-${version}.tgz`)], /archive.*name/);

  // Artifact download does not preserve mtime. The publisher must restore it
  // without rebuilding or modifying the archive bytes.
  // Make the prepared archive distinguishable from a fresh source rebuild.
  ok(helm, ['package', join(work, 'charts/browserless'), '--app-version', '0.0.1', '-d', packages], { SOURCE_DATE_EPOCH: String(epoch) });
  const prepared = readFileSync(archive);
  assert.notDeepEqual(prepared, bytes);
  utimesSync(archive, 0, 0);
  const registry = process.env.PUBLISH_TEST_REGISTRY;
  if (registry) {
    assert.match(registry, /^(127\.0\.0\.1|localhost):\d+$/, 'test registry must be local');
    const output = ok('bash', ['scripts/publish-chart.sh', tag, archive], { OCI_REGISTRY: registry });
    assert.match(output, /published oci:\/\/.*@sha256:[0-9a-f]{64}/);
    assert.equal(statSync(archive).mtimeMs, epoch * 1000);
    assert.deepEqual(readFileSync(archive), prepared);
    const pulled = join(work, 'independent-pull');
    mkdirSync(pulled);
    ok(helm, ['pull', `oci://${registry}/${env.OCI_NAMESPACE}/browserless`, '--version', version, '--plain-http', '-d', pulled]);
    assert.deepEqual(readFileSync(join(pulled, `browserless-${version}.tgz`)), prepared, 'publish must not repackage the source');
    const duplicate = run('bash', ['scripts/publish-chart.sh', tag, archive], { OCI_REGISTRY: registry });
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.text, /already exists; refusing to overwrite/);
    t.diagnostic('real local OCI push, pull-back comparison and overwrite refusal passed');
  } else {
    rejects([tag, archive], /cannot tell whether/);
    t.diagnostic('registry unavailable fails closed; set PUBLISH_TEST_REGISTRY for local push/pull coverage');
  }
  ok('git', ['tag', 'browserless-v99.0.0']);
  rejects(['browserless-v99.0.0', archive], /Chart.yaml version/);
  ok('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'later']);
  rejects([tag, archive], /checkout .* is not tag/);
});
