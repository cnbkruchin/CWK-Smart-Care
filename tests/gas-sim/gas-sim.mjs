// Minimal Apps Script runtime emulator for automated tests of the BUILT gas-dist bundle.
// It models the behaviors this project depends on; where real Apps Script behavior is assumed
// (apostrophe quote-prefix, TextFinder on display values, auto-typing of unprefixed strings) the
// emulator follows the documented/assumed behavior — results are "automated pass on emulator",
// NOT evidence for real Apps Script (see docs/LIMITATIONS.md and adminSelfTest()).

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_CELLS = 10_000_000;

function toSigned(buf) { return Array.from(buf, (b) => (b > 127 ? b - 256 : b)); }
function toBuf(arr) { return Buffer.from(Uint8Array.from(arr, (b) => b & 0xff)); }

/** Emulate user-entered value semantics of Range.setValues. */
function enterValue(v) {
  if (v === null || v === undefined || v === '') return { v: '' };
  if (typeof v === 'number' || typeof v === 'boolean') return { v };
  if (v instanceof Date) return { v: new Date(v.getTime()) };
  const s = String(v);
  if (s.startsWith("'")) return { v: s.slice(1), text: true };
  if (s.startsWith('=')) return { v: '#ERROR!', formula: s };
  if (/^[+-]?\d+(\.\d+)?$/.test(s.trim())) return { v: Number(s) };
  if (/^(true|false)$/i.test(s)) return { v: s.toUpperCase() === 'TRUE' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { v: new Date(`${s}T00:00:00+07:00`) };
  return { v: s };
}

function display(cell) {
  if (!cell || cell.v === '') return '';
  if (typeof cell.v === 'boolean') return cell.v ? 'TRUE' : 'FALSE';
  if (cell.v instanceof Date) return cell.v.toISOString().slice(0, 10);
  return String(cell.v);
}

class Sheet {
  constructor(book, name) { this.book = book; this.name = name; this.rows = []; this.frozen = 0; }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  getLastRow() {
    for (let r = this.rows.length - 1; r >= 0; r--) if (this.rows[r] && this.rows[r].some((c) => c && c.v !== '')) return r + 1;
    return 0;
  }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r ? r.length : 0), 0); }
  getMaxRows() { return Math.max(1000, this.rows.length); }
  getRange(row, col, numRows = 1, numCols = 1) {
    if (typeof row !== 'number' || row < 1 || col < 1 || numRows < 1 || numCols < 1) throw new Error(`Exception: The coordinates or dimensions of the range are invalid. (${row},${col},${numRows},${numCols})`);
    return new Range(this, row, col, numRows, numCols);
  }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  setFrozenRows(n) { this.frozen = n; return this; }
  getFrozenRows() { return this.frozen; }
  cell(r, c) { return (this.rows[r - 1] && this.rows[r - 1][c - 1]) || null; }
  setCell(r, c, cell) {
    while (this.rows.length < r) this.rows.push([]);
    const row = this.rows[r - 1];
    while (row.length < c) row.push({ v: '' });
    row[c - 1] = cell;
  }
}

class TextFinder {
  constructor(range, text) { this.range = range; this.text = text; this.entire = false; this.mcase = false; this.regex = false; this.pos = 0; }
  matchEntireCell(b) { this.entire = b; return this; }
  matchCase(b) { this.mcase = b; return this; }
  useRegularExpression(b) { this.regex = b; return this; }
  _matches() {
    const out = [];
    const r = this.range;
    const re = this.regex ? new RegExp(this.entire ? `^(?:${this.text})$` : this.text, this.mcase ? '' : 'i') : null;
    for (let i = 0; i < r.numRows; i++) for (let j = 0; j < r.numCols; j++) {
      const d = display(r.sheet.cell(r.row + i, r.col + j));
      if (d === '') continue;
      let ok;
      if (re) ok = re.test(d);
      else {
        const a = this.mcase ? d : d.toLowerCase();
        const b = this.mcase ? this.text : this.text.toLowerCase();
        ok = this.entire ? a === b : a.includes(b);
      }
      if (ok) out.push(new Range(r.sheet, r.row + i, r.col + j, 1, 1));
    }
    r.sheet.book.sim.stats.textFinder++;
    return out;
  }
  findAll() { return this._matches(); }
  findNext() { const m = this._matches(); return m[this.pos++] || null; }
}

class Range {
  constructor(sheet, row, col, numRows, numCols) { Object.assign(this, { sheet, row, col, numRows, numCols }); }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.numRows; }
  getNumColumns() { return this.numCols; }
  getValues() {
    this.sheet.book.sim.stats.reads++;
    const out = [];
    for (let i = 0; i < this.numRows; i++) {
      const row = [];
      for (let j = 0; j < this.numCols; j++) {
        const c = this.sheet.cell(this.row + i, this.col + j);
        row.push(c ? (c.v instanceof Date ? new Date(c.v.getTime()) : c.v) : '');
      }
      out.push(row);
    }
    return out;
  }
  getDisplayValues() { return this.getValues().map((r, i) => r.map((_, j) => display(this.sheet.cell(this.row + i, this.col + j)))); }
  getValue() { return this.getValues()[0][0]; }
  setValues(values) {
    if (!Array.isArray(values) || values.length !== this.numRows || values.some((r) => !Array.isArray(r) || r.length !== this.numCols)) {
      throw new Error(`Exception: The number of rows/columns in the data does not match the range. (${values.length} vs ${this.numRows})`);
    }
    const sim = this.sheet.book.sim;
    if (sim.failNextWrite) { const e = sim.failNextWrite; sim.failNextWrite = null; throw e; }
    sim.stats.writes++;
    values.forEach((r, i) => r.forEach((v, j) => {
      if (typeof v === 'string' && v.length > 50000) throw new Error('Exception: Your input contains more than the maximum of 50000 characters in a single cell.');
      this.sheet.setCell(this.row + i, this.col + j, enterValue(v));
    }));
    const cells = this.sheet.book.cellCount();
    if (cells > MAX_CELLS) throw new Error('Exception: This action would increase the number of cells in the workbook above the limit of 10000000 cells.');
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  setNumberFormat() { return this; }
  createTextFinder(text) { return new TextFinder(this, String(text)); }
}

class Spreadsheet {
  constructor(sim, id, name) { this.sim = sim; this.id = id; this.name = name; this.sheets = [new Sheet(this, 'Sheet1')]; this.tz = 'America/Los_Angeles'; this.trashed = false; }
  getId() { return this.id; }
  getName() { return this.name; }
  getUrl() { return `https://docs.google.com/spreadsheets/d/${this.id}/edit`; }
  getSheets() { return [...this.sheets]; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { if (this.getSheetByName(n)) throw new Error(`A sheet with the name "${n}" already exists.`); const s = new Sheet(this, n); this.sheets.push(s); return s; }
  deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
  setSpreadsheetTimeZone(tz) { this.tz = tz; }
  getSpreadsheetTimeZone() { return this.tz; }
  cellCount() { return this.sheets.reduce((n, s) => n + s.rows.reduce((m, r) => m + (r ? r.length : 0), 0), 0); }
}

class Blob {
  constructor(bytes, contentType, name) { this.bytes = Buffer.from(bytes); this.contentType = contentType || 'application/octet-stream'; this.name = name || null; }
  getBytes() { return toSigned(this.bytes); }
  getDataAsString() { return this.bytes.toString('utf8'); }
  getContentType() { return this.contentType; }
  setContentType(t) { this.contentType = t; return this; }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  copyBlob() { return new Blob(this.bytes, this.contentType, this.name); }
}

class DriveFile {
  constructor(sim, id, name, blob, folder) { Object.assign(this, { sim, id, name, blob, folder, trashed: false, description: null, sharing: 'PRIVATE' }); }
  getId() { return this.id; }
  getName() { return this.name; }
  getBlob() { return this.blob.copyBlob(); }
  getSize() { return this.blob.bytes.length; }
  getMimeType() { return this.blob.contentType; }
  setTrashed(t) { this.trashed = !!t; return this; }
  isTrashed() { return this.trashed; }
  moveTo(folder) { this.folder = folder; return this; }
  setDescription(d) { this.description = d; return this; }
  setSharing(access) { this.sharing = access; return this; }
  getSharingAccess() { return this.sharing; }
}

class Folder {
  constructor(sim, id, name, parent) { Object.assign(this, { sim, id, name, parent }); }
  getId() { return this.id; }
  getName() { return this.name; }
  createFolder(n) { return this.sim.newFolder(n, this); }
  getFoldersByName(n) { return iter(this.sim.folders.filter((f) => f.parent === this && f.name === n)); }
  getFilesByName(n) { return iter(this.sim.files.filter((f) => f.folder === this && f.name === n && !f.trashed)); }
  getFiles() { return iter(this.sim.files.filter((f) => f.folder === this && !f.trashed)); }
  createFile(blob) { const f = new DriveFile(this.sim, this.sim.newId('file'), blob.getName() || 'untitled', blob, this); this.sim.files.push(f); return f; }
}

function iter(list) {
  let i = 0;
  return { hasNext: () => i < list.length, next: () => list[i++] };
}

export class GasSim {
  constructor({ ownerEmail = 'owner@example.com', activeEmail = null, properties = {}, now = null } = {}) {
    this.ownerEmail = ownerEmail;
    this.activeEmail = activeEmail === null ? ownerEmail : activeEmail;
    this.props = { ...properties };
    this.books = new Map();
    this.files = [];
    this.folders = [];
    this.cache = new Map();
    this.triggers = [];
    this.mail = [];
    this.fetchHandler = null;
    this.lockHeldByOther = false;
    this.lockHeld = false;
    this.stats = { reads: 0, writes: 0, textFinder: 0 };
    this.failNextWrite = null;
    this.seq = 0;
    this.root = new Folder(this, 'root', 'My Drive', null);
    this.nowOverride = now;
  }

  /** Fixed/adjustable clock for code running in the VM (new Date() / Date.now()); host Date otherwise. */
  setNow(iso) { this.nowOverride = iso; }
  simDate() {
    const sim = this;
    return class SimDate extends Date {
      constructor(...a) { if (a.length === 0 && sim.nowOverride) super(Date.parse(sim.nowOverride)); else super(...a); }
      static now() { return sim.nowOverride ? Date.parse(sim.nowOverride) : Date.now(); }
    };
  }

  newId(prefix) { this.seq++; return `${prefix}-${String(this.seq).padStart(6, '0')}-${crypto.randomBytes(6).toString('hex')}`; }
  newFolder(name, parent) { const f = new Folder(this, this.newId('folder'), name, parent); this.folders.push(f); return f; }

  globals() {
    const sim = this;
    const SpreadsheetApp = {
      create(name) { const b = new Spreadsheet(sim, sim.newId('ss'), name); sim.books.set(b.id, b); sim.files.push(Object.assign(new DriveFile(sim, b.id, name, new Blob([], 'application/vnd.google-apps.spreadsheet', name), sim.root), { book: b })); return b; },
      openById(id) { const b = sim.books.get(id); if (!b) throw new Error(`Exception: Unexpected error while getting the method or property openById on object SpreadsheetApp. (${id})`); return b; },
      flush() {},
    };
    const LockService = {
      getScriptLock() {
        return {
          tryLock() { if (sim.lockHeldByOther) return false; sim.lockHeld = true; return true; },
          waitLock() { if (sim.lockHeldByOther) throw new Error('Lock timeout'); sim.lockHeld = true; },
          releaseLock() { sim.lockHeld = false; },
          hasLock() { return sim.lockHeld; },
        };
      },
    };
    const PropertiesService = {
      getScriptProperties() {
        return {
          getProperty: (k) => (k in sim.props ? sim.props[k] : null),
          setProperty: (k, v) => { sim.props[k] = String(v); },
          getProperties: () => ({ ...sim.props }),
          setProperties: (o) => { Object.assign(sim.props, o); },
          deleteProperty: (k) => { delete sim.props[k]; },
          getKeys: () => Object.keys(sim.props),
        };
      },
    };
    const CacheService = {
      getScriptCache() {
        return {
          get: (k) => { const e = sim.cache.get(k); if (!e || e.exp < Date.now()) return null; return e.v; },
          put: (k, v, ttl = 600) => { if (String(v).length > 100000) throw new Error('Argument too large'); sim.cache.set(k, { v: String(v), exp: Date.now() + ttl * 1000 }); },
          remove: (k) => { sim.cache.delete(k); },
        };
      },
    };
    const Utilities = {
      DigestAlgorithm: { SHA_256: 'sha256', SHA_1: 'sha1', MD5: 'md5' },
      Charset: { UTF_8: 'utf8' },
      getUuid: () => crypto.randomUUID(),
      computeDigest: (alg, value) => toSigned(crypto.createHash(alg).update(typeof value === 'string' ? Buffer.from(value, 'utf8') : toBuf(value)).digest()),
      computeHmacSha256Signature: (value, key) => toSigned(crypto.createHmac('sha256', typeof key === 'string' ? Buffer.from(key, 'utf8') : toBuf(key)).update(typeof value === 'string' ? Buffer.from(value, 'utf8') : toBuf(value)).digest()),
      base64Encode: (v) => (typeof v === 'string' ? Buffer.from(v, 'utf8') : toBuf(v)).toString('base64'),
      base64Decode: (s) => toSigned(Buffer.from(s, 'base64')),
      newBlob: (data, contentType, name) => new Blob(typeof data === 'string' ? Buffer.from(data, 'utf8') : toBuf(data || []), contentType, name),
      parseCsv: (s) => s.split(/\r?\n/).filter(Boolean).map((l) => l.split(',')),
      formatDate: (d, tz, fmt) => d.toISOString(),
      sleep: () => {},
    };
    const DriveApp = {
      createFolder: (n) => sim.newFolder(n, sim.root),
      getRootFolder: () => sim.root,
      getFolderById: (id) => { const f = sim.folders.find((x) => x.id === id); if (!f) throw new Error('No item with the given ID could be found.'); return f; },
      getFileById: (id) => { const f = sim.files.find((x) => x.id === id); if (!f) throw new Error('No item with the given ID could be found.'); return f; },
      Access: { PRIVATE: 'PRIVATE', ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', ANYONE: 'ANYONE' },
      Permission: { VIEW: 'VIEW', EDIT: 'EDIT', NONE: 'NONE' },
    };
    const MailApp = { sendEmail: (o) => { sim.mail.push(o); }, getRemainingDailyQuota: () => 100 - sim.mail.length };
    const UrlFetchApp = {
      fetch: (url, params = {}) => {
        if (!sim.fetchHandler) throw new Error('Exception: DNS error (no handler in emulator)');
        const r = sim.fetchHandler(url, params);
        return { getResponseCode: () => r.status, getContentText: () => r.body, getAllHeaders: () => r.headers || {}, getHeaders: () => r.headers || {}, getBlob: () => new Blob(Buffer.from(r.body), 'application/json') };
      },
    };
    const ScriptApp = {
      getProjectTriggers: () => [...sim.triggers],
      deleteTrigger: (t) => { sim.triggers = sim.triggers.filter((x) => x !== t); },
      newTrigger: (fn) => ({ timeBased: () => ({ everyMinutes: (n) => ({ create: () => { const t = { fn, n, id: String(1000 + sim.triggers.length + 1), getHandlerFunction: () => fn, getUniqueId: () => t.id }; sim.triggers.push(t); return t; } }) }) }),
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/EMULATOR/exec' }),
      getOAuthToken: () => 'emulator-token',
    };
    const Session = {
      getActiveUser: () => ({ getEmail: () => sim.activeEmail }),
      getEffectiveUser: () => ({ getEmail: () => sim.ownerEmail }),
      getScriptTimeZone: () => 'Asia/Bangkok',
    };
    const htmlOutput = (content) => {
      const o = { content, title: null, meta: {}, xfo: null };
      return Object.assign(o, {
        getContent: () => o.content, setTitle: (t) => { o.title = t; return o; }, addMetaTag: (n, v) => { o.meta[n] = v; return o; },
        setXFrameOptionsMode: (m) => { o.xfo = m; return o; },
      });
    };
    const HtmlService = {
      XFrameOptionsMode: { DEFAULT: 'DEFAULT', ALLOWALL: 'ALLOWALL' },
      createHtmlOutputFromFile: (name) => htmlOutput(sim.htmlFiles[name]),
      createHtmlOutput: (c) => htmlOutput(c),
    };
    const ContentService = {
      MimeType: { JSON: 'JSON', TEXT: 'TEXT' },
      createTextOutput: (s) => { const o = { s, mime: null }; return Object.assign(o, { setMimeType: (m) => { o.mime = m; return o; }, getContent: () => o.s }); },
    };
    const logs = [];
    this.logs = logs;
    const consoleProxy = { log: (...a) => logs.push(['log', a.join(' ')]), info: (...a) => logs.push(['info', a.join(' ')]), warn: (...a) => logs.push(['warn', a.join(' ')]), error: (...a) => logs.push(['error', a.join(' ')]) };
    return { SpreadsheetApp, LockService, PropertiesService, CacheService, Utilities, DriveApp, MailApp, UrlFetchApp, ScriptApp, Session, HtmlService, ContentService, Logger: { log: consoleProxy.log }, console: consoleProxy };
  }

  /** Load gas-dist files into a fresh V8 context exactly like Apps Script concatenates project files. */
  load(distDir) {
    const files = ['Code.js', 'Entrypoints.js'];
    this.htmlFiles = { App: fs.readFileSync(path.join(distDir, 'App.html'), 'utf8') };
    const ctx = vm.createContext({ ...this.globals(), Date: this.simDate(), Math, JSON, Uint8Array, DataView, ArrayBuffer, Uint32Array, Map, Set, Promise, Symbol, Error, TypeError, RangeError, Object, Array, String, Number, Boolean, RegExp, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent, setTimeout: undefined });
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(distDir, f), 'utf8'), ctx, { filename: f });
    this.ctx = ctx;
    return ctx;
  }

  /** Simulate google.script.run.rpc(...) from a browser. */
  rpc(envelope) {
    return JSON.parse(this.ctx.rpc(JSON.stringify(envelope)));
  }

  book(id) { return this.books.get(id); }
}

/** Parse top-level function declarations of a script (surface audit). */
export function topLevelFunctions(src) {
  return [...src.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]);
}
