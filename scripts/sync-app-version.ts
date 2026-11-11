// Keeps each chart's appVersion equal to its default image tag without the
// leading "v". With --check, only reports a mismatch (publish-chart.sh);
// otherwise rewrites the appVersion line in place (for Dependabot image updates).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const charts = fileURLToPath(new URL('../charts', import.meta.url));
const check = process.argv[2] === '--check';
for (const entry of readdirSync(charts, { withFileTypes: true }).filter((e) => e.isDirectory())) {
  const name = entry.name;
  const chartFile = join(charts, name, 'Chart.yaml');
  const chartYaml = readFileSync(chartFile, 'utf8');
  const tag = String(parse(readFileSync(join(charts, name, 'values.yaml'), 'utf8'))?.image?.tag ?? '');
  const have = String(parse(chartYaml)?.appVersion ?? '');
  const want = tag.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(want)) {
    console.error(`${name}: image.tag '${tag}' is not a release version`);
    process.exitCode = 1;
    continue;
  }
  if (have === want) continue;
  if (check) {
    console.error(`${name}: appVersion '${have}' does not match image.tag '${tag}'; run node scripts/sync-app-version.ts`);
    process.exitCode = 1;
    continue;
  }
  if (chartYaml.match(/^appVersion:/gm)?.length !== 1) throw new Error(`${chartFile}: expected one appVersion line`);
  writeFileSync(chartFile, chartYaml.replace(/^appVersion:.*$/m, `appVersion: "${want}"`));
  console.log(`${name}: appVersion ${have} -> ${want}`);
}
