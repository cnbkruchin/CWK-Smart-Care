// Shared PostgreSQL codec: canonical SELECT lists (dates/timestamps as the same ISO text every other adapter
// returns), parameter values, ListQuery → parameterized WHERE/ORDER BY, and error mapping to AppError codes.
// Identifiers always come from the schema module (never from requests or packages).
import { getTable } from '../../schema/index.js';
import { SQL_TABLE } from '../../schema/sql.js';
import { AppError } from '../../shared/errors.js';

export { SQL_TABLE };

export function columnOf(table, name) {
  const c = getTable(table).columns.find((x) => x.name === name);
  if (!c) throw new AppError('INTERNAL_ERROR', `unknown column ${table}.${name}`);
  return c;
}

/** SELECT list returning canonical text for date/ts columns (all columns, or the named ones). */
export function selectList(table, only = null) {
  return getTable(table).columns.filter((c) => !only || only.includes(c.name)).map((c) => {
    if (c.type === 'ts') return `to_char(${c.name} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${c.name}`;
    if (c.type === 'date') return `to_char(${c.name}, 'YYYY-MM-DD') AS ${c.name}`;
    return c.name;
  }).join(', ');
}

export function paramValue(c, v) {
  if (v === null || v === undefined) return null;
  if (c.type === 'json') return JSON.stringify(v);
  return v;
}

const textLike = (c) => ['string', 'text', 'enum', 'hhmm'].includes(c.type); // uuid sorts bytewise already

/** ListQuery.where → SQL (same semantics as shared/query.js matchesCondition, NULL-aware). */
export function whereSql(table, where, params) {
  const parts = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  for (const [col, cond] of Object.entries(where || {})) {
    const c = columnOf(table, col);
    const x = textLike(c) ? `${col} COLLATE "C"` : col;
    const val = (v) => (c.type === 'json' ? JSON.stringify(v) : v);
    if (cond === null) { parts.push(`${col} IS NULL`); continue; }
    if (typeof cond !== 'object' || Array.isArray(cond)) { parts.push(`${col} = ${p(val(cond))}`); continue; }
    for (const [op, arg] of Object.entries(cond)) {
      switch (op) {
        case 'in': {
          const vals = arg.filter((v) => v !== null);
          const any = vals.length ? `${col} = ANY(${p(vals.map(val))})` : 'FALSE';
          parts.push(arg.includes(null) ? `(${any} OR ${col} IS NULL)` : any);
          break;
        }
        case 'nin': {
          const vals = arg.filter((v) => v !== null);
          const none = vals.length ? `NOT (${col} = ANY(${p(vals.map(val))}))` : 'TRUE';
          parts.push(arg.includes(null) ? `(${col} IS NOT NULL AND ${none})` : `(${col} IS NULL OR ${none})`);
          break;
        }
        case 'ne': parts.push(`${col} IS DISTINCT FROM ${p(val(arg))}`); break;
        case 'gt': parts.push(`${x} > ${p(arg)}`); break;
        case 'gte': parts.push(`${x} >= ${p(arg)}`); break;
        case 'lt': parts.push(`${x} < ${p(arg)}`); break;
        case 'lte': parts.push(`${x} <= ${p(arg)}`); break;
        case 'isNull': parts.push(arg ? `${col} IS NULL` : `${col} IS NOT NULL`); break;
        case 'prefix': parts.push(`left(${col}, char_length(${p(arg)})) = $${params.length}`); break;
        case 'contains': parts.push(`position(${p(arg)} in ${col}) > 0`); break;
        default: throw new AppError('INTERNAL_ERROR', `unsupported where operator ${op}`);
      }
    }
  }
  return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
}

/** ORDER BY with byte-order collation for text (same order as JavaScript string comparison) and id tiebreak. */
export function orderSql(table, orderBy) {
  const order = orderBy && orderBy.length ? orderBy : [['id', 'asc']];
  const withId = order.some(([c]) => c === 'id') ? order : [...order, ['id', 'asc']];
  return `ORDER BY ${withId.map(([col, dir]) => {
    const c = columnOf(table, col);
    const d = dir === 'desc' ? 'DESC NULLS LAST' : 'ASC NULLS FIRST';
    return `${textLike(c) ? `${col} COLLATE "C"` : col} ${d}`;
  }).join(', ')}`;
}

/** PostgreSQL error → AppError (stable API codes; no SQL text or values leak to clients). */
export function mapPgError(e) {
  if (!e || e.name === 'AppError') return e;
  const details = { constraint: e.constraint || null, table: e.table || null };
  switch (e.code) {
    case '23505': return new AppError('UNIQUE_VIOLATION', 'unique violation', { details });
    case '23P01': return new AppError('VALIDATION_ERROR', 'overlapping period', { details, messageTh: 'ช่วงเวลาซ้อนกับรายการที่มีอยู่' });
    case '23503': return new AppError('VALIDATION_ERROR', 'reference missing', { details, messageTh: 'ข้อมูลที่อ้างอิงไม่มีอยู่' });
    case '23514': case '23502': case '22P02': case '22007': case '22008': case '22001': return new AppError('VALIDATION_ERROR', `invalid value (${e.code})`, { details });
    case '40001': case '40P01': return new AppError('CONFLICT', 'concurrent update', { retryable: true });
    case '55P03': return new AppError('LOCK_TIMEOUT', 'lock timeout');
    case '57014': return new AppError('STORAGE_UNAVAILABLE', 'statement timeout');
    default:
      if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|Connection terminated|connect/i.test(String(e.code || e.message))) return new AppError('STORAGE_UNAVAILABLE', 'database unavailable');
      return new AppError('INTERNAL_ERROR', 'database error', { cause: e });
  }
}

export function tableName(table) {
  if (!SQL_TABLE[table]) throw new AppError('INTERNAL_ERROR', `unknown table ${table}`);
  return SQL_TABLE[table];
}
