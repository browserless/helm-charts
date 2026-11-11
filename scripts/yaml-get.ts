// Prints one scalar from a YAML file for shell scripts, for example
//   node scripts/yaml-get.ts charts/browserless/Chart.yaml version
//   node scripts/yaml-get.ts tests/kind/1.37/cluster.yaml nodes.0.image
// and fails unless the value exists and is a string, number or boolean.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const [file, path] = process.argv.slice(2);
if (!file || !path) throw new Error('usage: node scripts/yaml-get.ts <file> <key>[.<key>...]');
let value: unknown = parse(readFileSync(file, 'utf8'));
for (const key of path.split('.')) {
  value = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}
if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
  throw new Error(`${file}: ${path} is not a scalar value`);
}
process.stdout.write(String(value));
