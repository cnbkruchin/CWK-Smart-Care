// Report files on Apps Script (MASTER_PROMPT §12, DECISIONS D-016). No HTML→PDF shortcuts:
//   XLSX — temporary Google Sheet (text columns use the Plain text format so no cell is evaluated as a
//          formula) → Drive API v3 files.export (real .xlsx, not a renamed CSV) → temp file trashed.
//   PDF  — copy of the Docs template (A4, school header, page numbers inserted once by the installer)
//          → placeholders filled with literal text → table with the header row pinned (Docs API
//          pinTableHeaderRows, so it repeats on every page) → getAs('application/pdf') → temp trashed.
// Temporary files live in the private root folder; nothing is shared.
const G = () => globalThis;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FONT = 'Sarabun';

const unsigned = (arr) => Uint8Array.from(arr, (b) => b & 0xff);

function tempFolder(rootFolderId) {
  const root = G().DriveApp.getFolderById(rootFolderId);
  const it = root.getFoldersByName('reports-tmp');
  return it.hasNext() ? it.next() : root.createFolder('reports-tmp');
}

/** Replace {{key}} with literal text everywhere in a body/header/footer section (no regex replacement semantics). */
function fill(section, key, value) {
  if (!section) return;
  const token = `{{${key}}}`;
  for (let guard = 0; guard < 50; guard++) {
    const found = section.findText(`\\{\\{${key}\\}\\}`);
    if (!found) return;
    const t = found.getElement().asText();
    const start = found.getStartOffset();
    t.deleteText(start, start + token.length - 1);
    if (value) t.insertText(start, String(value));
  }
}

/** Paragraph (child of body) that contains {{key}}, or null. */
function placeholderParagraph(body, key) {
  const found = body.findText(`\\{\\{${key}\\}\\}`);
  if (!found) return null;
  let el = found.getElement();
  while (el.getParent() && el.getParent().getType() !== G().DocumentApp.ElementType.BODY_SECTION) el = el.getParent();
  return el;
}

export class GasReportRenderer {
  constructor({ rootFolderId, templateDocId }) {
    this.rootFolderId = rootFolderId;
    this.templateDocId = templateDocId;
  }

  xlsx(doc) {
    const g = G();
    const ss = g.SpreadsheetApp.create(`cwk-report-tmp-${doc.code}`);
    const file = g.DriveApp.getFileById(ss.getId());
    file.moveTo(tempFolder(this.rootFolderId));
    try {
      const sh = ss.getSheets()[0];
      sh.setName(doc.code);
      const head = [[doc.title], [doc.subtitle || ''], [`${doc.meta.school_name} · ${doc.meta.scope_th} · ข้อมูล ณ ${doc.meta.as_of_local} · ผู้จัดทำ ${doc.meta.generated_by}`], ['']];
      sh.getRange(1, 1, head.length, 1).setNumberFormat('@').setValues(head);
      const nCols = doc.columns.length;
      const top = head.length + 1;
      const body = [doc.columns.map((c) => c.label), ...doc.rows_data, ...(doc.totals_data ? [doc.totals_data] : [])];
      // text columns: Plain text format before writing, so values like "=1+1" stay text
      doc.columns.forEach((c, i) => {
        const numeric = ['int', 'percent'].includes(c.type);
        sh.getRange(top, i + 1, body.length, 1).setNumberFormat(numeric ? (c.type === 'percent' ? '0.0' : '0') : '@');
      });
      sh.getRange(top, 1, 1, nCols).setNumberFormat('@');
      sh.getRange(top, 1, body.length, nCols).setValues(body.map((r) => r.map((v) => (v === null || v === undefined ? '' : v))));
      sh.setFrozenRows(top);
      let row = top + body.length + 1;
      const notes = (doc.notes_th || []).map((n) => [`หมายเหตุ: ${n}`]);
      if (notes.length) { sh.getRange(row, 1, notes.length, 1).setNumberFormat('@').setValues(notes); row += notes.length; }
      g.SpreadsheetApp.flush();
      const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(ss.getId())}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`;
      const res = g.UrlFetchApp.fetch(url, { method: 'get', headers: { Authorization: `Bearer ${g.ScriptApp.getOAuthToken()}` }, muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) throw new Error(`Drive export failed HTTP ${res.getResponseCode()}`);
      return unsigned(res.getBlob().getBytes());
    } finally {
      file.setTrashed(true);
    }
  }

  pdf(doc) {
    const g = G();
    if (!this.templateDocId) {
      const e = new Error('report template not configured (run adminSetup)');
      e.code = 'CONFIGURATION_REQUIRED';
      throw e;
    }
    const copy = g.DriveApp.getFileById(this.templateDocId).makeCopy(`cwk-report-tmp-${doc.code}`, tempFolder(this.rootFolderId));
    try {
      const d = g.DocumentApp.openById(copy.getId());
      const body = d.getBody();
      const values = {
        school: [doc.meta.school_name, doc.meta.unit_th].filter(Boolean).join(' · '), title: doc.title, subtitle: doc.subtitle || '', scope: doc.meta.scope_th,
        as_of: doc.meta.as_of_th, generated_by: doc.meta.generated_by,
      };
      for (const section of [body, d.getHeader(), d.getFooter()]) for (const [k, v] of Object.entries(values)) fill(section, k, v);
      // table at the {{table}} placeholder
      const holder = placeholderParagraph(body, 'table');
      const index = holder ? body.getChildIndex(holder) : body.getNumChildren();
      const cells = [doc.columns.map((c) => c.label), ...doc.rows_display, ...(doc.totals_display ? [doc.totals_display] : [])].map((r) => r.map((v) => String(v === null || v === undefined ? '' : v)));
      const table = body.insertTable(index, cells);
      table.getRow(0).editAsText().setBold(true);
      if (doc.totals_display) table.getRow(cells.length - 1).editAsText().setBold(true);
      if (holder) body.removeChild(holder);
      // notes and signature lines
      const notesAt = placeholderParagraph(body, 'notes');
      const notes = (doc.notes_th || []).map((n) => `• ${n}`).join('\n');
      if (notesAt) { notesAt.asParagraph().setText(notes || ' '); } else if (notes) body.appendParagraph(notes);
      const sigAt = placeholderParagraph(body, 'signatures');
      const sigs = (doc.meta.signatures || []).map((s) => `ลงชื่อ ........................................ (${s})`).join('\n\n');
      if (sigAt) { sigAt.asParagraph().setText(sigs || ' '); } else if (sigs) body.appendParagraph(sigs);
      body.editAsText().setFontFamily(FONT);
      d.saveAndClose();
      // repeat the header row on every page (Docs API; DocumentApp has no equivalent)
      const content = g.Docs.Documents.get(copy.getId()).body.content;
      const t = content.find((x) => x.table);
      if (t) g.Docs.Documents.batchUpdate({ requests: [{ pinTableHeaderRows: { tableStartLocation: { index: t.startIndex }, pinnedHeaderRowsCount: 1 } }] }, copy.getId());
      return unsigned(g.DriveApp.getFileById(copy.getId()).getAs('application/pdf').getBytes());
    } finally {
      copy.setTrashed(true);
    }
  }
}

/** Create the A4 report template once (adminSetup). Page numbers: Insert → Page numbers in the footer (manual, see INSTALL). */
export function ensureReportTemplate(rootFolderId, env) {
  const g = G();
  const props = g.PropertiesService.getScriptProperties();
  const existing = props.getProperty('CWK_REPORT_TEMPLATE_DOC_ID');
  if (existing) return { template_doc_id: existing, created: false };
  const d = g.DocumentApp.create(`CWK Smart Care (${env}) — report template`);
  const body = d.getBody();
  body.setPageWidth(595.28).setPageHeight(841.89).setMarginTop(42).setMarginBottom(42).setMarginLeft(36).setMarginRight(36);
  body.clear();
  body.appendParagraph('{{title}}').setHeading(g.DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph('{{subtitle}}');
  body.appendParagraph('ขอบเขต: {{scope}} · ข้อมูล ณ {{as_of}} · ผู้จัดทำ: {{generated_by}}');
  body.appendParagraph('{{table}}');
  body.appendParagraph('{{notes}}');
  body.appendParagraph('{{signatures}}');
  body.editAsText().setFontFamily(FONT).setFontSize(10);
  (d.getHeader() || d.addHeader()).appendParagraph('{{school}}');
  (d.getFooter() || d.addFooter()).appendParagraph('CWK Smart Care · ออกรายงาน {{as_of}}');
  d.saveAndClose();
  const file = g.DriveApp.getFileById(d.getId());
  file.moveTo(g.DriveApp.getFolderById(rootFolderId));
  props.setProperty('CWK_REPORT_TEMPLATE_DOC_ID', d.getId());
  return { template_doc_id: d.getId(), created: true };
}
