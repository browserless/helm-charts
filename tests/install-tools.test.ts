// scripts/install-tools.ts must install exactly the tool versions tools/go.mod
// requires, from the right release asset for each platform, and refuse anything
// it cannot verify against its release's checksum file.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { asset, expectedSha256, lockedVersions, platform, verifySha256 } from '../scripts/install-tools.ts';

const goMod = readFileSync(new URL('../tools/go.mod', import.meta.url), 'utf8');
const required = 'require (\n\tgithub.com/rhysd/actionlint v1.7.12\n\thelm.sh/helm/v4 v4.3.1\n\tsigs.k8s.io/kind v0.33.0 // a comment\n)\n';

test('reads the tool versions tools/go.mod requires', () => {
  const versions = lockedVersions(goMod);
  assert.match(versions.helm, /^v4\.\d+\.\d+$/);
  assert.match(versions.kind, /^v\d+\.\d+\.\d+$/);
  assert.match(versions.actionlint, /^v\d+\.\d+\.\d+$/);
  assert.deepEqual(lockedVersions(`module tools\n\n${required}\nrequire golang.org/x/net v0.1.0 // indirect\n`), {
    helm: 'v4.3.1',
    kind: 'v0.33.0',
    actionlint: 'v1.7.12',
  });
  assert.equal(lockedVersions('require helm.sh/helm/v4 v4.0.0\nrequire sigs.k8s.io/kind v0.1.0\nrequire github.com/rhysd/actionlint v1.0.0\n').helm, 'v4.0.0');
});

test('refuses missing, repeated, replaced or non-release tool versions', () => {
  const broken = {
    'missing tool': required.replace(/.*kind.*\n/, ''),
    'tool required twice': `${required}require sigs.k8s.io/kind v0.32.0\n`,
    'pseudo-version': required.replace('v0.33.0', 'v0.33.1-0.20260101000000-abcdefabcdef'),
    'pre-release': required.replace('v4.3.1', 'v4.4.0-rc.1'),
    'other Helm major version': required.replace('helm.sh/helm/v4 v4.3.1', 'helm.sh/helm/v5 v5.0.0'),
    'replace directive': `${required}replace helm.sh/helm/v4 => ../helm\n`,
    'replace block': `${required}replace (\n\tsigs.k8s.io/kind v0.33.0 => example.org/kind v0.33.0\n)\n`,
  };
  for (const [name, mod] of Object.entries(broken)) assert.throws(() => lockedVersions(mod), Error, name);
});

test('maps each tool and platform to its official release asset', () => {
  const linux = (arch: 'amd64' | 'arm64') => ({ os: 'linux' as const, arch });
  assert.deepEqual(asset('helm', 'v4.9.8', linux('amd64')), {
    file: 'helm-v4.9.8-linux-amd64.tar.gz',
    url: 'https://get.helm.sh/helm-v4.9.8-linux-amd64.tar.gz',
    checksums: 'https://get.helm.sh/helm-v4.9.8-linux-amd64.tar.gz.sha256sum',
    member: 'linux-amd64/helm',
  });
  assert.deepEqual(asset('helm', 'v4.9.8', linux('arm64')).member, 'linux-arm64/helm');
  assert.deepEqual(asset('kind', 'v0.40.1', linux('arm64')), {
    file: 'kind-linux-arm64',
    url: 'https://github.com/kubernetes-sigs/kind/releases/download/v0.40.1/kind-linux-arm64',
    checksums: 'https://github.com/kubernetes-sigs/kind/releases/download/v0.40.1/kind-linux-arm64.sha256sum',
  });
  assert.equal(asset('kind', 'v0.40.1', linux('amd64')).file, 'kind-linux-amd64');
  assert.deepEqual(asset('actionlint', 'v1.8.2', linux('amd64')), {
    file: 'actionlint_1.8.2_linux_amd64.tar.gz',
    url: 'https://github.com/rhysd/actionlint/releases/download/v1.8.2/actionlint_1.8.2_linux_amd64.tar.gz',
    checksums: 'https://github.com/rhysd/actionlint/releases/download/v1.8.2/actionlint_1.8.2_checksums.txt',
    member: 'actionlint',
  });
  assert.equal(asset('actionlint', 'v1.8.2', linux('arm64')).file, 'actionlint_1.8.2_linux_arm64.tar.gz');
  assert.deepEqual(platform('linux', 'x64'), linux('amd64'));
  assert.deepEqual(platform('linux', 'arm64'), linux('arm64'));
  assert.deepEqual(platform('darwin', 'arm64'), { os: 'darwin', arch: 'arm64' });
  assert.throws(() => platform('win32', 'x64'));
  assert.throws(() => platform('linux', 'arm'));
  assert.throws(() => platform('linux', 'ia32'));
});

test('takes the one checksum listed for the exact file name and fails closed', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const c = 'c'.repeat(64);
  const list = `${a}  actionlint_1.8.2_linux_armv6.tar.gz\n${b}  actionlint_1.8.2_linux_arm64.tar.gz\n${c} *actionlint_1.8.2_linux_amd64.tar.gz\n`;
  assert.equal(expectedSha256(list, 'actionlint_1.8.2_linux_arm64.tar.gz'), b);
  assert.equal(expectedSha256(list, 'actionlint_1.8.2_linux_amd64.tar.gz'), c);
  assert.equal(expectedSha256(`${a}  kind-linux-arm64\r\n`, 'kind-linux-arm64'), a);
  assert.throws(() => expectedSha256(list, 'actionlint_1.8.2_linux_arm.tar.gz'), /found 0/);
  assert.throws(() => expectedSha256(`${list}${a}  actionlint_1.8.2_linux_arm64.tar.gz\n`, 'actionlint_1.8.2_linux_arm64.tar.gz'), /found 2/);
  assert.throws(() => expectedSha256(`${a.slice(1)}  kind-linux-arm64\n`, 'kind-linux-arm64'), /malformed/);
  assert.throws(() => expectedSha256(`${a.toUpperCase()}  kind-linux-arm64\n`, 'kind-linux-arm64'), /malformed/);
  assert.throws(() => expectedSha256('<html>Not Found</html>', 'kind-linux-arm64'), /malformed/);
  assert.throws(() => expectedSha256('', 'kind-linux-arm64'), /found 0/);
});

test('rejects a download whose SHA-256 differs from the release checksum', () => {
  const data = new TextEncoder().encode('binary');
  const sha = '9a3a45d01531a20e89ac6ae10b0b0beb0492acd7216a368aa062d1a5fecaf9cd';
  assert.equal(verifySha256(data, sha, 'binary'), sha);
  assert.throws(() => verifySha256(data, 'f'.repeat(64), 'binary'), /SHA-256 9a3a45d0/);
});
