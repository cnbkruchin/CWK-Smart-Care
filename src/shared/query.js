// In-process evaluation of ListQuery filters/sorting/pagination (memory + Sheets adapters).
// PostgreSQL translates the same ListQuery to parameterized SQL (src/adapters/postgres).

import { AppError } from './errors.js';
import { toBase64, fromBase64 } from './hash.js';
import { utf8Encode, utf8Decode } from './canonical-json.js';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;

function cmp(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return a < b ? -1 : 1;
}

export function matchesCondition(value, cond) {
  if (cond === null) return value === null || value === undefined;
  if (typeof cond !== 'object' || Array.isArray(cond)) return value === cond;
  for (const [op, arg] of Object.entries(cond)) {
    switch (op) {
      case 'in': if (!arg.includes(value)) return false; break;
      case 'nin': if (arg.includes(value)) return false; break;
      case 'ne': if (value === arg) return false; break;
      case 'gt': if (!(value !== null && value !== undefined && value > arg)) return false; break;
      case 'gte': if (!(value !== null && value !== undefined && value >= arg)) return false; break;
      case 'lt': if (!(value !== null && value !== undefined && value < arg)) return false; break;
      case 'lte': if (!(value !== null && value !== undefined && value <= arg)) return false; break;
      case 'isNull': if ((value === null || value === undefined) !== !!arg) return false; break;
      case 'prefix': if (!(typeof value === 'string' && value.startsWith(arg))) return false; break;
      case 'contains': if (!(typeof value === 'string' && value.includes(arg))) return false; break;
      default: throw new AppError('INTERNAL_ERROR', `unsupported where operator ${op}`);
    }
  }
  return true;
}

export function matchesWhere(record, where) {
  if (!where) return true;
  for (const [col, cond] of Object.entries(where)) {
    if (!matchesCondition(record[col], cond)) return false;
  }
  return true;
}

export function sortRecords(items, orderBy) {
  const order = orderBy && orderBy.length ? orderBy : [['id', 'asc']];
  const withId = order.some(([c]) => c === 'id') ? order : [...order, ['id', 'asc']];
  return items.sort((x, y) => {
    for (const [col, dir] of withId) {
      const c = cmp(x[col], y[col]);
      if (c !== 0) return dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

export function encodeCursor(obj) {
  return toBase64(utf8Encode(JSON.stringify(obj))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const b64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(utf8Decode(fromBase64(b64)));
  } catch (_) {
    throw new AppError('VALIDATION_ERROR', 'bad cursor', { messageTh: 'ตัวชี้หน้าข้อมูลไม่ถูกต้อง กรุณาโหลดใหม่' });
  }
}

export function pageSize(limit) {
  const n = limit == null ? DEFAULT_PAGE_SIZE : Number(limit);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

/**
 * Offset pagination over a fully sorted list; cursor carries the last id to detect shifts.
 * `all: true` returns every matching row in one page (internal reads through listAll(); never exposed
 * to clients, whose page size stays capped at MAX_PAGE_SIZE).
 */
export function paginate(sorted, { limit, cursor, all }) {
  if (all === true && !cursor) return { items: sorted, next_cursor: null };
  const size = pageSize(limit);
  let start = 0;
  const c = decodeCursor(cursor);
  if (c) {
    start = c.o;
    if (c.id && sorted[start - 1] && sorted[start - 1].id !== c.id) {
      const idx = sorted.findIndex((x) => x.id === c.id);
      start = idx >= 0 ? idx + 1 : start;
    }
  }
  const items = sorted.slice(start, start + size);
  const next = start + size < sorted.length && items.length ? encodeCursor({ o: start + size, id: items[items.length - 1].id }) : null;
  return { items, next_cursor: next };
}

export function applyListQuery(records, q = {}) {
  const filtered = records.filter((r) => matchesWhere(r, q.where));
  return paginate(sortRecords(filtered, q.orderBy), q);
}

/** Evaluate the small SQL predicate subset used by partial unique keys in tables.js. */
export function evalUniquePredicate(sqlWhere, record) {
  if (!sqlWhere) return true;
  let m = /^(\w+)\s*=\s*'([^']*)'$/.exec(sqlWhere.trim());
  if (m) return record[m[1]] === m[2];
  m = /^(\w+)\s+(NOT\s+)?IN\s*\(([^)]*)\)$/i.exec(sqlWhere.trim());
  if (m) {
    const vals = m[3].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    const inList = vals.includes(record[m[1]]);
    return m[2] ? !inList : inList;
  }
  throw new AppError('INTERNAL_ERROR', `unsupported unique predicate ${sqlWhere}`);
}
