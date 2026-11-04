import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const script = resolve('scripts/licenses.mjs');
function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'nexrun-license-gate-'));
  try { mkdirSync(join(dir, 'docs/dependencies'), { recursive: true }); run(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
const json = (dir, path, value) => writeFileSync(join(dir, path), JSON.stringify(value));
const invoke = dir => spawnSync(process.execPath, [script, 'check'], { cwd: dir, encoding: 'utf8' });
test('license gate rejects an unreviewed lockfile before checking installed packages', () => fixture(dir => {
  json(dir, 'package-lock.json', { packages: {} });
  json(dir, 'docs/dependencies/inventory.json', { lockfileSha256: 'not-reviewed', packages: [] });
  const result = invoke(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Dependency lock changed/);
}));
test('license gate rejects a newly introduced nonadmitted license', () => fixture(dir => {
  const lock = { packages: { 'node_modules/example': { version: '1.0.0', resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz', integrity: 'example' } } };
  json(dir, 'package-lock.json', lock);
  json(dir, 'docs/dependencies/inventory.json', { lockfileSha256: createHash('sha256').update(JSON.stringify(lock)).digest('hex'), packages: [] });
  mkdirSync(join(dir, 'node_modules/example'), { recursive: true });
  json(dir, 'node_modules/example/package.json', { name: 'example', version: '1.0.0', license: 'AGPL-3.0-only' });
  writeFileSync(join(dir, 'node_modules/example/LICENSE'), 'Example license evidence');
  const result = invoke(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unapproved license AGPL-3.0-only/);
}));
test('license gate rejects changed copied component source', () => fixture(dir => {
  const lock = { packages: {} };
  json(dir, 'package-lock.json', lock);
  json(dir, 'docs/dependencies/inventory.json', { lockfileSha256: createHash('sha256').update(JSON.stringify(lock)).digest('hex'), packages: [] });
  json(dir, 'docs/dependencies/shadcn-sources.json', { components: [{ path: 'component.tsx', installedSha256: 'reviewed-old-content' }] });
  writeFileSync(join(dir, 'component.tsx'), 'changed-source');
  const result = invoke(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Changed copied source/);
}));
