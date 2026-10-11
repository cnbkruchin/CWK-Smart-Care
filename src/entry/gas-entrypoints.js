/**
 * CWK Smart Care — public Apps Script entrypoints (copied verbatim to gas-dist/Entrypoints.js).
 * Every top-level function here is callable by google.script.run and/or triggers, so:
 *   - rpc() is the ONLY client entry; it dispatches an allowlist of operations with auth/permission checks.
 *   - cronTick() refuses to run unless invoked by this project's installed trigger.
 *   - admin*() run only from the Apps Script Editor by the installation owner within an explicit
 *     time window (CWK_ADMIN_TASKS_ENABLED_UNTIL) — see src/adapters/gas/setup.js.
 * Adding a function here requires updating tests/gas/surface.test.mjs.
 */

function doGet(e) {
  return CWK.doGet(e);
}

function doPost(e) {
  return CWK.doPost(e);
}

function rpc(envelopeJson) {
  return CWK.rpc(envelopeJson);
}

function cronTick(e) {
  return CWK.cronTick(e);
}

function adminSetup() {
  return CWK.admin.setup();
}

function adminSeedDemo() {
  return CWK.admin.seedDemo();
}

function adminInstallTriggers() {
  return CWK.admin.installTriggers();
}

function adminSelfTest() {
  return CWK.admin.selfTest();
}

function adminSchemaCheck() {
  return CWK.admin.schemaCheck();
}

function adminRecoverJournal() {
  return CWK.admin.recoverJournal();
}

function adminRestoreSnapshot() {
  return CWK.admin.restoreSnapshot();
}
