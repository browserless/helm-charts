// Tests for scripts/notify-slack.sh, which posts to a local HTTP receiver here,
// never to Slack, and for the publish.yml step that runs it.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), 'notify-slack-'));

let reply = { status: 200, body: 'ok' };
let received: { method?: string; type?: string; body: string }[] = [];
const server = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk: string) => (body += chunk));
  request.on('end', () => {
    received.push({ method: request.method, type: request.headers['content-type'], body });
    response.writeHead(reply.status).end(reply.body);
  });
});
before(() => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)));
after(() => {
  server.close();
  rmSync(cwd, { recursive: true, force: true });
});
beforeEach(() => {
  reply = { status: 200, body: 'ok' };
  received = [];
});
// The secret part of a Slack webhook is its path.
const secret = 'T0SECRET/B0SECRET/s3cr3t';
const webhook = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/services/${secret}`;

const release = {
  TAG: 'browserless-v1.2.3',
  RELEASE_URL: 'https://github.com/browserless/helm-charts/releases/tag/browserless-v1.2.3',
  NAME: 'ghcr.io/browserless/charts/browserless',
  DIGEST: `sha256:${'0123456789abcdef'.repeat(4)}`,
};
// Only PATH and these variables, so nothing from the caller's environment.
function notify(env: Record<string, string>): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(join(root, 'scripts/notify-slack.sh'), { cwd, env: { PATH: process.env.PATH, ...env } }, (error, stdout, stderr) =>
      resolve({ ok: !error, out: stdout + stderr }),
    );
  });
}
const text = (body: string) => JSON.parse(body).text;

test('posts the release, chart reference and digest without printing the webhook', async () => {
  const { ok, out } = await notify({ ...release, SLACK_WEBHOOK_URL: webhook() });
  assert.ok(ok, out);
  assert.equal(received.length, 1);
  assert.equal(received[0]?.method, 'POST');
  assert.equal(received[0]?.type, 'application/json');
  assert.equal(
    text(received[0]?.body ?? ''),
    ':package: *<https://github.com/browserless/helm-charts/releases/tag/browserless-v1.2.3|browserless-v1.2.3>*' +
      ' of the Browserless Helm chart published as' +
      ' `oci://ghcr.io/browserless/charts/browserless:1.2.3@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`' +
      ' (provenance attestation verified).',
  );
  assert.ok(!out.includes(secret), out);
});

test('values cannot break the JSON, add Slack links or mentions, or run commands', async () => {
  const { ok, out } = await notify({
    TAG: 'x<!channel> & "q" \\ `touch t1` $(touch t2)\n-v1.2.3',
    RELEASE_URL: 'https://e.test/?a=1&b=2|<@U1>',
    NAME: 'n<https://e.test|x>',
    DIGEST: 'sha256:d',
    SLACK_WEBHOOK_URL: webhook(),
  });
  assert.ok(ok, out);
  assert.equal(
    text(received[0]?.body ?? ''),
    ':package: *<https://e.test/?a=1&amp;b=2|&lt;@U1&gt;|x&lt;!channel&gt; &amp; "q" \\ `touch t1` $(touch t2)\n-v1.2.3>*' +
      ' of the Browserless Helm chart published as `oci://n&lt;https://e.test|x&gt;:1.2.3@sha256:d` (provenance attestation verified).',
  );
  assert.ok(!existsSync(join(cwd, 't1')) && !existsSync(join(cwd, 't2')));
});

test('without a webhook it warns and fails, sending nothing', async () => {
  for (const env of [release, { ...release, SLACK_WEBHOOK_URL: '' }]) {
    const { ok, out } = await notify(env);
    assert.ok(!ok);
    assert.match(out, /^::warning title=Slack notification not sent::SLACK_RELEASES_WEBHOOK is not set/m);
  }
  assert.equal(received.length, 0);
});

test('a message Slack rejects fails the step, once, without printing the webhook', async () => {
  reply = { status: 400, body: 'invalid_payload' };
  const { ok, out } = await notify({ ...release, SLACK_WEBHOOK_URL: webhook() });
  assert.ok(!ok);
  assert.match(out, /invalid_payload/);
  assert.ok(!out.includes(secret), out);
  assert.equal(received.length, 1);
});

// A step without `if` runs only when every step before it succeeded, and
// continue-on-error keeps its own failure from failing the job.
test('publish.yml notifies last, only after the attestation verifies, without failing the release', () => {
  const steps: { name?: string; if?: string; run?: string; env?: Record<string, string>; 'continue-on-error'?: boolean }[] =
    parse(readFileSync(join(root, '.github/workflows/publish.yml'), 'utf8')).jobs.publish.steps;
  const notifyStep = steps.at(-1);
  assert.equal(notifyStep?.run, 'scripts/notify-slack.sh');
  assert.equal(notifyStep?.if, undefined);
  assert.equal(notifyStep?.['continue-on-error'], true);
  assert.deepEqual(notifyStep?.env, {
    TAG: '${{ github.event.release.tag_name }}',
    RELEASE_URL: '${{ github.event.release.html_url }}',
    NAME: '${{ steps.publish.outputs.name }}',
    DIGEST: '${{ steps.publish.outputs.digest }}',
    SLACK_WEBHOOK_URL: '${{ secrets.SLACK_RELEASES_WEBHOOK }}',
  });
  assert.match(steps.at(-2)?.run ?? '', /^gh attestation verify /);
  for (const step of steps.slice(0, -1)) {
    assert.equal(step.if, undefined, String(step.name));
    assert.equal(step['continue-on-error'], undefined, String(step.name));
  }
});
