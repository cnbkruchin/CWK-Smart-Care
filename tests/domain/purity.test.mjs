// Layering rules (ARCHITECTURE.md §1): domain/application/shared/schema code must not touch
// platform APIs. Adapters are the only place allowed to call them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FORBIDDEN = /\b(SpreadsheetApp|DriveApp|UrlFetchApp|PropertiesService|CacheService|LockService|ScriptApp|MailApp|HtmlService|ContentService|Utilities|Session|DocumentApp|google\.script\.run|require\(|process\.env|node:)/;

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

for (const layer of ['src/domain', 'src/shared', 'src/schema', 'src/application']) {
  test(`${layer} is platform-agnostic`, () => {
    for (const file of walk(path.join(ROOT, layer)).filter((f) => f.endsWith('.js'))) {
      const src = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
      // string literal contents (descriptions, messages) are not code
      const code = (line) => line.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
      src.forEach((line, i) => assert.ok(!FORBIDDEN.test(code(line)), `${path.relative(ROOT, file)}:${i + 1} uses a platform API: ${line.trim()}`));
    }
  });
}

test('domain does not import application or adapters', () => {
  for (const file of walk(path.join(ROOT, 'src/domain'))) {
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(!/from '\.\.\/(application|adapters|entry)\//.test(src), `${file} imports an outer layer`);
  }
});
