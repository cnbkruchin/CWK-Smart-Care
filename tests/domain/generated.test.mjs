// Generated artifacts (docs, JSON Schema, SQL, API contract, gas-dist) must match their sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

test('generated docs/schema/SQL/API contract are up to date (npm run gen)', () => {
  const r = spawnSync(process.execPath, ['tools/gen-docs.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('gas-dist is rebuilt from current sources (npm run build)', () => {
  const r = spawnSync(process.execPath, ['tools/build-gas.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
