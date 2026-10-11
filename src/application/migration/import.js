// Import a portable package into a store-backed environment (memory for tests, Google Sheets for a new
// Apps Script environment) and reconcile it. The PostgreSQL importer lives in tools/lib/pg-target.mjs
// and uses the same processPackage() checks. Reports are written back into the package (reports/), where
// the source's Migration Center reads them as evidence (migration.recordEvidence).
import { processPackage } from './process.js';
import { StoreSink } from './sinks.js';
import { reconcile, StoreTarget } from './reconcile.js';

const json = (o) => JSON.stringify(o, null, 2) + '\n';

export function summarizeImport(res, { target, importId, mode, startedAt, finishedAt }) {
  const t = res.report.tables || {};
  const sum = (k) => Object.values(t).reduce((s, x) => s + (x[k] || 0), 0);
  return {
    format: 'cwk-import', target, import_id: importId, mode, manifest_sha256: res.manifest_sha256 || null, export_id: res.manifest ? res.manifest.export_id : null,
    package_kind: res.manifest ? res.manifest.kind : null, base_export_id: res.manifest && res.manifest.delta ? res.manifest.delta.base_export_id : null,
    started_at: startedAt, finished_at: finishedAt, ok: res.report.ok, fatal: res.report.fatal,
    rows_inserted: mode === 'APPLY' ? sum('inserted') : 0, rows_updated: mode === 'APPLY' ? sum('updated') : 0, rows_identical: sum('identical'), conflicts: sum('conflicts'),
    error_count: res.report.error_count, errors: res.report.errors.slice(0, 200), warnings: res.report.warnings.slice(0, 50), tables: t, attachments: res.report.attachments,
  };
}

/**
 * @param {object} deps    {store, ids, clock, crypto, platform:{storage}}
 * @param {object} handle  package handle
 * @param {{importId:string, target?:string, dryRun?:boolean, conflictPolicy?:'REJECT'|'APPLY_NEWER', checkpoint?, deadlineAt?, reportName?:string}} o
 */
export function* importIntoStore(deps, handle, o) {
  const startedAt = deps.clock.now();
  const sink = new StoreSink({ store: deps.store, storage: deps.platform && deps.platform.storage, ids: deps.ids, clock: deps.clock, crypto: deps.crypto, conflictPolicy: o.conflictPolicy || 'REJECT' });
  if (o.dryRun) {
    sink.append = function* () { return { inserted: 0 }; };
    sink.attachment = function* () { return { written: false }; };
  }
  const res = yield* processPackage(handle, sink, { sha256Hex: (d) => deps.crypto.sha256Hex(d), failFast: !o.dryRun, checkpoint: o.checkpoint || null, deadlineAt: o.deadlineAt || null });
  if (!res.done) return { done: false, report: res.report };
  const mode = o.dryRun ? 'DRY_RUN' : 'APPLY';
  const report = summarizeImport(res, { target: o.target || 'memory', importId: o.importId, mode, startedAt, finishedAt: deps.clock.now() });
  const name = o.reportName || (o.dryRun ? 'reports/import-dry-run.json' : 'reports/import.json');
  if (handle.writeText) yield handle.writeText(name, json(report));
  return { done: true, report };
}

export function* reconcileStore(deps, handle, { target = 'memory', writeReport = true } = {}) {
  const res = yield* reconcile(handle, new StoreTarget({ name: target, deps }), { sha256Hex: (d) => deps.crypto.sha256Hex(d), now: deps.clock.now() });
  if (writeReport && handle.writeText) yield handle.writeText('reports/reconciliation.json', json(res.result));
  return res.result;
}
