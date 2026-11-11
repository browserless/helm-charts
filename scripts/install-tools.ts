// Installs Helm, kind and actionlint into .bin/ (or TOOLS_BIN) from their
// official release binaries, at exactly the versions tools/go.mod requires:
//   node scripts/install-tools.ts [helm] [kind] [actionlint]   (default: all three)
//
// tools/ is not a Go program and nothing here builds or runs Go: go.mod only
// lists these versions so that Dependabot (gomod) proposes updates. Each
// download must match the SHA-256 that the same release publishes in its
// checksum file before it is unpacked or run. That proves the file is the one
// the release lists, not who made the release: a release whose binary and
// checksum file were both replaced would pass. tools/go.sum does not cover the
// binaries.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const modules = {
  helm: 'helm.sh/helm/v4',
  kind: 'sigs.k8s.io/kind',
  actionlint: 'github.com/rhysd/actionlint',
} as const;
export type Tool = keyof typeof modules;
export interface Platform {
  os: 'linux' | 'darwin';
  arch: 'amd64' | 'arm64';
}
export interface Asset {
  file: string;
  url: string;
  checksums: string;
  // The binary's path inside the archive; a release without one ships the bare binary.
  member?: string;
}

const isTool = (name: string): name is Tool => Object.hasOwn(modules, name);

// The release version tools/go.mod requires for each tool.
export function lockedVersions(goMod: string): Record<Tool, string> {
  if (/^\s*replace\b/m.test(goMod)) {
    throw new Error('tools/go.mod must not replace modules: a replacement is not what gets downloaded');
  }
  const requirements = goMod
    .split('\n')
    .map((line) => line.replace(/\/\/.*/, '').trim().replace(/^require\s+/, '').split(/\s+/));
  const versions: Partial<Record<Tool, string>> = {};
  for (const [tool, module] of Object.entries(modules)) {
    const found = requirements.filter(([path]) => path === module);
    const [requirement] = found;
    if (found.length !== 1 || !requirement || requirement.length !== 2) {
      throw new Error(`tools/go.mod must require ${module} exactly once, with one version`);
    }
    const version = requirement[1] ?? '';
    if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error(`${module} ${version} is not a release version`);
    if (isTool(tool)) versions[tool] = version;
  }
  const { helm, kind, actionlint } = versions;
  if (!helm || !kind || !actionlint) throw new Error('tools/go.mod is missing a tool');
  if (!helm.startsWith('v4.')) throw new Error(`the chart and its tests require Helm 4, not ${helm}`);
  return { helm, kind, actionlint };
}

export function platform(os: string = process.platform, arch: string = process.arch): Platform {
  if (os !== 'linux' && os !== 'darwin') throw new Error(`unsupported operating system ${os}`);
  if (arch === 'x64') return { os, arch: 'amd64' };
  if (arch === 'arm64') return { os, arch: 'arm64' };
  throw new Error(`unsupported architecture ${arch}`);
}

// Where each project publishes the release binary and its checksum file.
export function asset(tool: Tool, version: string, { os, arch }: Platform): Asset {
  const bare = version.replace(/^v/, '');
  switch (tool) {
    case 'helm': {
      const file = `helm-${version}-${os}-${arch}.tar.gz`;
      const url = `https://get.helm.sh/${file}`;
      return { file, url, checksums: `${url}.sha256sum`, member: `${os}-${arch}/helm` };
    }
    case 'kind': {
      const file = `kind-${os}-${arch}`;
      const url = `https://github.com/kubernetes-sigs/kind/releases/download/${version}/${file}`;
      return { file, url, checksums: `${url}.sha256sum` };
    }
    case 'actionlint': {
      const base = `https://github.com/rhysd/actionlint/releases/download/${version}`;
      const file = `actionlint_${bare}_${os}_${arch}.tar.gz`;
      return { file, url: `${base}/${file}`, checksums: `${base}/actionlint_${bare}_checksums.txt`, member: 'actionlint' };
    }
  }
}

// The SHA-256 a sha256sum-format checksum file lists for exactly this file name.
export function expectedSha256(checksums: string, file: string): string {
  const found: string[] = [];
  for (const line of checksums.split('\n').map((l) => l.trim())) {
    if (!line) continue;
    const match = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line);
    if (!match) throw new Error(`malformed checksum line: ${line}`);
    if (match[2] === file && match[1]) found.push(match[1]);
  }
  const [sha] = found;
  if (found.length !== 1 || !sha) throw new Error(`expected one checksum for ${file}, found ${found.length}`);
  return sha;
}

export function verifySha256(data: Uint8Array, expected: string, what: string): string {
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== expected) throw new Error(`${what}: SHA-256 ${actual}, but its release lists ${expected}`);
  return actual;
}

// The version a binary reports, in go.mod's form (v1.2.3).
function reportedVersion(tool: Tool, binary: string): string {
  const run = (...args: string[]) => execFileSync(binary, args, { encoding: 'utf8' }).trim();
  switch (tool) {
    case 'helm':
      return run('version', '--template', '{{.Version}}');
    case 'kind': // kind v0.33.0 go1.26.1 linux/amd64
      return run('version').split(/\s+/)[1] ?? '';
    case 'actionlint': // first line: 1.7.12
      return `v${run('-version').split('\n')[0]}`;
  }
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function install(tool: Tool, version: string, bin: string, target: Platform): Promise<void> {
  const { file, url, checksums, member } = asset(tool, version, target);
  const expected = expectedSha256((await download(checksums)).toString('utf8'), file);
  const data = await download(url);
  const sha = verifySha256(data, expected, url);
  const work = mkdtempSync(join(tmpdir(), 'install-tools-'));
  const dest = join(bin, tool);
  try {
    writeFileSync(join(work, file), data);
    if (member) execFileSync('tar', ['-xzf', join(work, file), '-C', work, member]);
    copyFileSync(join(work, member ?? file), `${dest}.tmp`);
    chmodSync(`${dest}.tmp`, 0o755);
    renameSync(`${dest}.tmp`, dest);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const reported = reportedVersion(tool, dest);
  if (reported !== version) throw new Error(`${dest} reports ${reported}, but tools/go.mod requires ${version}`);
  console.log(`${tool} ${version} (${target.os}-${target.arch}, ${file} sha256 ${sha})`);
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const versions = lockedVersions(readFileSync(join(root, 'tools/go.mod'), 'utf8'));
  const args = process.argv.slice(2);
  const unknown = args.filter((name) => !isTool(name));
  if (unknown.length) throw new Error(`unknown tools: ${unknown.join(', ')}; choose from ${Object.keys(modules).join(', ')}`);
  const tools = args.length ? args.filter(isTool) : (Object.keys(modules) as Tool[]);
  const bin = process.env.TOOLS_BIN ?? join(root, '.bin');
  const target = platform();
  mkdirSync(bin, { recursive: true });
  for (const tool of tools) await install(tool, versions[tool], bin, target);
}
