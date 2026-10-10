// Operation allowlist + job handlers. Adding an operation here is the ONLY way to expose it.
import { createRegistry } from './dispatcher.js';
import { authOps } from './ops/auth.js';
import { userOps } from './ops/users.js';
import { studentOps } from './ops/students.js';
import { settingsOps } from './ops/settings.js';
import { systemOps } from './ops/system.js';
import { importOps, importApplyJob } from './ops/imports.js';
import { EXTRA_OPS, EXTRA_JOB_HANDLERS } from './extensions.js';

export function buildRegistry() {
  return createRegistry([...authOps, ...userOps, ...studentOps, ...settingsOps, ...systemOps, ...importOps, ...EXTRA_OPS]);
}

export const JOB_HANDLERS = Object.freeze({
  'import.apply': importApplyJob,
  ...EXTRA_JOB_HANDLERS,
});
