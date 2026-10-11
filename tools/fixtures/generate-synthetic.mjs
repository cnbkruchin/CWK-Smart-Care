#!/usr/bin/env node
// Synthetic portable package for demos, CLI tests and docker-compose rehearsals — NO real data:
// builds an in-memory CWK system through its real operations (tests/helpers/migration-fixture.mjs:
// synthetic names, example.com contacts, +999 phone numbers), freezes it and exports a FULL_SNAPSHOT
// package to a directory.
//   node tools/fixtures/generate-synthetic.mjs --out ./tmp/packages [--mode FULL_SNAPSHOT|REHEARSAL]
import path from 'node:path';
import fs from 'node:fs';
import { buildSource, exportSource } from '../../tests/helpers/migration-fixture.mjs';
import { FsPackageStore } from '../../src/adapters/node/fs-package.js';

export function generatePackage(outDir, { mode = 'FULL_SNAPSHOT' } = {}) {
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const store = new FsPackageStore(outDir);
  const src = buildSource({ packageStore: store });
  const { run } = exportSource(src, { mode });
  return { dir: run.package_location, run, src };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : './synthetic-packages';
  const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'FULL_SNAPSHOT';
  const { dir, run } = generatePackage(path.resolve(out), { mode });
  process.stdout.write(JSON.stringify({ package: dir, state: run.state, completeness: run.completeness, manifest_sha256: run.manifest_sha256 }) + '\n');
}
