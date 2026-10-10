// Port definitions (MASTER_PROMPT §4). Every method may return a value (GAS) or a Promise (Node);
// application code `yield`s the result (see src/application/runtime.js).
// Interfaces are shaped around real constraints: Sheets cannot do multi-range transactions, so
// MutationStore exposes one `commit(changeSet)` whose atomicity guarantee is adapter-specific
// (journal + roll-forward on Sheets, ACID transaction on PostgreSQL) — see ARCHITECTURE.md §4.

/**
 * @typedef {object} TableStore  read side, logical IDs only (never row numbers)
 * @property {(table:string, id:string, opts?:{partitions?:string[]}) => any} get
 * @property {(table:string, ids:string[], opts?:{partitions?:string[]}) => any} getMany          → Map<id, record>
 * @property {(table:string, column:string, value:any, opts?:{partitions?:string[]}) => any} findBy  exact match
 * @property {(table:string, query:ListQuery) => any} list                                        → {items, next_cursor}
 * @property {(table:string, partition:string, opts:{cursor?:string, limit:number}) => any} scan   raw storage order, for export
 * @property {(table:string) => any} partitions                                                   → string[] newest first
 *
 * @typedef {object} ListQuery
 * @property {Object<string, any>} [where]   {col: v} | {col: {in:[]}} | {col: {gte, gt, lte, lt, ne, isNull}}
 * @property {string[]} [partitions]
 * @property {Array<[string, 'asc'|'desc']>} [orderBy]
 * @property {number} [limit]                default 50, max 500
 * @property {string|null} [cursor]
 *
 * @typedef {object} ChangeSet
 * @property {string} operation_id
 * @property {string} operation
 * @property {string} actor_id
 * @property {string|null} request_id
 * @property {Array<{table:string, op:'insert'|'update', partition:string, record:object, expected_version:number|null}>} writes
 * @property {{scope_key:string, request_hash:string, record:object}|null} idempotency
 * @property {object} result
 * @property {boolean} [maintenance_allowed]
 *
 * @typedef {object} MutationStore
 * @property {(cs:ChangeSet) => any} commit   → {replayed:boolean, result, committed_at, seq}
 *   Errors: CONFLICT (expected version mismatch), UNIQUE_VIOLATION, DUPLICATE_REQUEST_MISMATCH,
 *           LOCK_TIMEOUT, MAINTENANCE_MODE, STORAGE_UNAVAILABLE
 *
 * @typedef {object} IdentityVerifier  (AuthProvider.verifyCredential)
 * @property {(credential:string) => any} verifyCredential  → trusted claims {provider, issuer, subject, email, email_verified, exp, auth_time}
 *
 * @typedef {object} AttachmentStorage
 * @property {(logicalId:string, bytes:Uint8Array, meta:object) => any} put        → {provider, object_key, container, sha256, size}
 * @property {(mapping:object) => any} get                                          → Uint8Array
 * @property {(mapping:object) => any} delete
 * @property {(mapping:object) => any} metadata                                     → {size, sha256?}
 *
 * @typedef {object} NotificationProvider
 * @property {(message:object, stableRetryKey:string) => any} send  → {result, http_status, provider_request_id, provider_message_id, error_code, error_message}
 *
 * @typedef {object} ServiceClient  (HttpApiAdapter)
 * @property {(operation:string, payload:object, context:object) => any} call
 *
 * @typedef {object} Clock    { now(): string }                 UTC ISO with ms
 * @typedef {object} Ids      { uuid(): string }                random v4
 * @typedef {object} Crypto   { sha256Hex(data), hmacSha256Base64(key, data), randomBytes(n) }
 * @typedef {object} Cache    { get(k), put(k, v, ttlSeconds), remove(k) }  acceleration only (never source of truth)
 */

export const PORT_METHODS = Object.freeze({
  TableStore: ['get', 'getMany', 'findBy', 'list', 'scan', 'partitions'],
  MutationStore: ['commit'],
  IdentityVerifier: ['verifyCredential'],
  AttachmentStorage: ['put', 'get', 'delete', 'metadata'],
  NotificationProvider: ['send'],
  Clock: ['now'],
  Ids: ['uuid'],
  Crypto: ['sha256Hex', 'hmacSha256Base64', 'randomBytes'],
  Cache: ['get', 'put', 'remove'],
});

export function assertImplements(portName, impl) {
  const missing = PORT_METHODS[portName].filter((m) => typeof impl[m] !== 'function');
  if (missing.length) throw new Error(`${portName} implementation missing: ${missing.join(', ')}`);
  return impl;
}
