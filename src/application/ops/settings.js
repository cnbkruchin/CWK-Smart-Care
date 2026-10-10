// Business settings (non-secret): academic years, terms, calendar, periods, stations, rules, settings.
// Deployment configuration and secrets are NOT editable here (Script Properties / env only).
import { op } from '../dispatcher.js';
import { obj, S, EMPTY, notFound, assertVersion } from './common.js';
import { requirePermission } from '../authz.js';
import { commit, invalidateConfigCache, loadRules } from '../context.js';
import { AppError } from '../../shared/errors.js';
import { validateRuleParams, findOverlappingRule, RULE_PARAM_SCHEMAS } from '../../domain/rules.js';
import { rangesOverlap } from '../../shared/time.js';
import { enqueueJobOnce } from '../jobs.js';

function* school(ctx) {
  const s = (yield ctx.store.list('Schools', { limit: 1 })).items[0];
  if (!s) throw new AppError('CONFIGURATION_REQUIRED', 'school missing', { messageTh: 'ยังไม่ได้ตั้งค่าโรงเรียน' });
  return s;
}

export const settingsOps = [
  op({
    name: 'settings.overview', description_th: 'ค่าตั้งค่าธุรกิจทั้งหมด (ไม่รวม secrets)', permission: 'settings.business | system.health', input: EMPTY,
    *handler(ctx) {
      let ok = false;
      for (const a of ['settings.business', 'system.health']) {
        try { yield* requirePermission(ctx, a); ok = true; break; } catch (e) { if (e.code !== 'FORBIDDEN') throw e; }
      }
      if (!ok) throw new AppError('FORBIDDEN', 'settings');
      const [schools, years, terms, stations, periods, rules, settings, calendar] = [
        yield ctx.store.list('Schools', { limit: 2 }), yield ctx.store.list('AcademicYears', { limit: 50, orderBy: [['start_date', 'desc']] }),
        yield ctx.store.list('Terms', { limit: 100, orderBy: [['start_date', 'desc']] }), yield ctx.store.list('Stations', { limit: 100 }),
        yield ctx.store.list('Periods', { limit: 200, orderBy: [['effective_from', 'desc'], ['period_no', 'asc']] }),
        yield ctx.store.list('RuleVersions', { limit: 200, orderBy: [['rule_type', 'asc'], ['version_no', 'desc']] }),
        yield ctx.store.list('Settings', { limit: 200 }), yield ctx.store.list('SchoolCalendar', { limit: 500, orderBy: [['calendar_date', 'desc']] }),
      ];
      return {
        school: schools.items[0] || null, academic_years: years.items, terms: terms.items, stations: stations.items, periods: periods.items,
        rules: rules.items, settings: settings.items, calendar: calendar.items, rule_param_schemas: RULE_PARAM_SCHEMAS,
      };
    },
  }),

  op({
    name: 'school.update', mutation: true, description_th: 'แก้ไขข้อมูลโรงเรียน (ชื่อ หน่วยงาน สี ตรา)', permission: 'settings.business',
    input: obj({ name_th: S.str(200), unit_th: S.strOrNull(200), brand_color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' }, logo_file_id: S.uuidOrNull }),
    *handler(ctx, input, env) {
      yield* requirePermission(ctx, 'settings.business');
      const s = yield* school(ctx);
      assertVersion(s, env.expected_version);
      const cs = ctx.changeSet();
      const after = cs.update('Schools', s, input);
      cs.audit({ action: 'school.update', entityType: 'Schools', entityId: s.id, table: 'Schools', before: s, after });
      const res = yield* commit(ctx, cs, { version: after.version });
      invalidateConfigCache(ctx);
      return res;
    },
  }),

  op({
    name: 'academicYear.create', mutation: true, description_th: 'สร้างปีการศึกษา', permission: 'settings.business',
    input: obj({ start_year_ce: S.int(2000, 2200), start_date: S.date, end_date: S.date }, ['start_year_ce', 'start_date', 'end_date']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'settings.business');
      if (input.start_date >= input.end_date) throw new AppError('VALIDATION_ERROR', 'range', { messageTh: 'วันเริ่มต้องก่อนวันสิ้นสุด' });
      const s = yield* school(ctx);
      const cs = ctx.changeSet();
      const y = cs.insert('AcademicYears', { school_id: s.id, start_year_ce: input.start_year_ce, label_th: `ปีการศึกษา ${input.start_year_ce + 543}`, start_date: input.start_date, end_date: input.end_date, status: 'ACTIVE' });
      cs.audit({ action: 'academic_year.create', entityType: 'AcademicYears', entityId: y.id, after: input });
      return yield* commit(ctx, cs, { academic_year_id: y.id });
    },
  }),

  op({
    name: 'term.create', mutation: true, description_th: 'สร้างภาคเรียน (สร้าง partition workbook ให้อัตโนมัติบน Sheets)', permission: 'settings.business',
    input: obj({ academic_year_id: S.uuid, term_no: S.int(1, 3), start_date: S.date, end_date: S.date }, ['academic_year_id', 'term_no', 'start_date', 'end_date']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'settings.business');
      const y = yield ctx.store.get('AcademicYears', input.academic_year_id);
      if (!y) throw notFound('academic year');
      if (input.start_date >= input.end_date) throw new AppError('VALIDATION_ERROR', 'range', { messageTh: 'วันเริ่มต้องก่อนวันสิ้นสุด' });
      if (ctx.terms.some((t) => rangesOverlap(t.start_date, t.end_date, input.start_date, input.end_date))) {
        throw new AppError('VALIDATION_ERROR', 'overlap', { messageTh: 'ช่วงภาคเรียนซ้อนกับภาคเรียนอื่น' });
      }
      const code = `AY${y.start_year_ce}-T${input.term_no}`;
      if (ctx.deps.platform && ctx.deps.platform.ensurePartitions) yield ctx.deps.platform.ensurePartitions(code);
      const cs = ctx.changeSet();
      const t = cs.insert('Terms', { academic_year_id: y.id, term_no: input.term_no, code, start_date: input.start_date, end_date: input.end_date, status: 'ACTIVE' });
      cs.audit({ action: 'term.create', entityType: 'Terms', entityId: t.id, after: { code, ...input } });
      const res = yield* commit(ctx, cs, { term_id: t.id, code });
      invalidateConfigCache(ctx);
      return res;
    },
  }),

  op({
    name: 'calendar.set', mutation: true, description_th: 'กำหนดวันหยุด/วันพิเศษ (ทับค่าเริ่มต้นจันทร์–ศุกร์)', permission: 'settings.business',
    input: obj({ calendar_date: S.date, day_type: S.enum('DayType'), applies_to_level: S.enumOrNull('GradeLevel'), title_th: S.strOrNull(200) }, ['calendar_date', 'day_type']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'settings.business');
      const s = yield* school(ctx);
      const existing = (yield ctx.store.findBy('SchoolCalendar', 'calendar_date', input.calendar_date)).find((c) => (c.applies_to_level || null) === (input.applies_to_level || null));
      const cs = ctx.changeSet();
      let row;
      if (existing) {
        row = cs.update('SchoolCalendar', existing, { day_type: input.day_type, title_th: input.title_th });
        cs.audit({ action: 'calendar.update', entityType: 'SchoolCalendar', entityId: row.id, table: 'SchoolCalendar', before: existing, after: row });
      } else {
        row = cs.insert('SchoolCalendar', { school_id: s.id, ...input });
        cs.audit({ action: 'calendar.create', entityType: 'SchoolCalendar', entityId: row.id, after: input });
      }
      if (input.calendar_date <= ctx.today) {
        yield* enqueueJobOnce(ctx, cs, { job_type: 'attendance.recomputeDate', payload: { school_date: input.calendar_date }, dedupe_key: `recompute-date|${input.calendar_date}` });
      }
      return yield* commit(ctx, cs, { calendar_id: row.id });
    },
  }),

  op({
    name: 'period.create', mutation: true, description_th: 'กำหนดคาบเรียนพร้อมวันที่มีผล', permission: 'settings.business',
    input: obj({ period_no: S.int(0, 20), label_th: S.str(50), session: S.enum('DaySession'), start_time: S.hhmm, end_time: S.hhmm, effective_from: S.date, effective_to: S.dateOrNull, applies_to_level: S.enumOrNull('GradeLevel') },
      ['period_no', 'label_th', 'session', 'start_time', 'end_time', 'effective_from']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'settings.business');
      if (input.start_time >= input.end_time) throw new AppError('VALIDATION_ERROR', 'time', { messageTh: 'เวลาเริ่มต้องก่อนเวลาสิ้นสุด' });
      const s = yield* school(ctx);
      const cs = ctx.changeSet();
      const p = cs.insert('Periods', { school_id: s.id, ...input });
      cs.audit({ action: 'period.create', entityType: 'Periods', entityId: p.id, after: input });
      return yield* commit(ctx, cs, { period_id: p.id });
    },
  }),

  op({
    name: 'station.create', mutation: true, description_th: 'เพิ่มจุดลงเวลา', permission: 'settings.business',
    input: obj({ code: { type: 'string', pattern: '^[0-9A-Za-z_-]{1,30}$' }, name_th: S.str(200), station_type: S.enum('StationType') }, ['code', 'name_th', 'station_type']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'settings.business');
      const s = yield* school(ctx);
      const cs = ctx.changeSet();
      const st = cs.insert('Stations', { school_id: s.id, ...input, status: 'ACTIVE' });
      cs.audit({ action: 'station.create', entityType: 'Stations', entityId: st.id, after: input });
      return yield* commit(ctx, cs, { station_id: st.id });
    },
  }),

  op({
    name: 'station.list', description_th: 'จุดลงเวลา', input: EMPTY,
    *handler(ctx) {
      const page = yield ctx.store.list('Stations', { where: { status: 'ACTIVE' }, limit: 100, orderBy: [['code', 'asc']] });
      return { items: page.items.map((s) => ({ id: s.id, code: s.code, name_th: s.name_th, station_type: s.station_type })) };
    },
  }),

  op({
    name: 'rule.createVersion', mutation: true, description_th: 'สร้างกฎเวอร์ชันใหม่ (ร่าง) พร้อมตรวจ schema ของพารามิเตอร์', permission: 'settings.business',
    input: obj({ rule_type: S.enum('RuleType'), effective_from: S.date, effective_to: S.dateOrNull, params_json: { type: 'object' }, notes_th: S.strOrNull(2000) }, ['rule_type', 'effective_from', 'params_json']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'settings.business');
      validateRuleParams(input.rule_type, input.params_json);
      const s = yield* school(ctx);
      const rules = yield* loadRules(ctx);
      const maxVersion = rules.filter((r) => r.rule_type === input.rule_type).reduce((m, r) => Math.max(m, r.version_no), 0);
      const cs = ctx.changeSet();
      const r = cs.insert('RuleVersions', { school_id: s.id, rule_type: input.rule_type, version_no: maxVersion + 1, effective_from: input.effective_from, effective_to: input.effective_to, params_json: input.params_json, status: 'DRAFT', is_example: false, notes_th: input.notes_th });
      cs.audit({ action: 'rule.create', entityType: 'RuleVersions', entityId: r.id, after: { rule_type: r.rule_type, version_no: r.version_no, params_json: r.params_json } });
      return yield* commit(ctx, cs, { rule_id: r.id, version_no: r.version_no });
    },
  }),

  op({
    name: 'rule.activate', mutation: true,
    description_th: 'เปิดใช้กฎ (ห้ามช่วงซ้อนกับเวอร์ชันที่ใช้งาน; ต้องปิดเวอร์ชันเดิมก่อน) — ไม่คำนวณย้อนหลังอัตโนมัติ', permission: 'settings.business',
    input: obj({ rule_id: S.uuid, confirm_school_policy: S.bool }, ['rule_id', 'confirm_school_policy']),
    *handler(ctx, input, env) {
      yield* requirePermission(ctx, 'settings.business');
      const r = yield ctx.store.get('RuleVersions', input.rule_id);
      if (!r) throw notFound('rule');
      assertVersion(r, env.expected_version);
      if (r.status !== 'DRAFT') throw new AppError('INVALID_STATE', 'not draft');
      if (!input.confirm_school_policy) throw new AppError('VALIDATION_ERROR', 'confirmation required', { messageTh: 'กรุณายืนยันว่าค่าดังกล่าวเป็นเกณฑ์ที่โรงเรียนกำหนดแล้ว' });
      const rules = yield* loadRules(ctx);
      const clash = findOverlappingRule(rules, { ...r, status: 'ACTIVE' });
      if (clash) throw new AppError('CONFLICT', 'overlapping active rule', { messageTh: `ช่วงเวลาซ้อนกับเวอร์ชัน ${clash.version_no} ที่ใช้งานอยู่ — กำหนดวันสิ้นสุดของเวอร์ชันเดิมก่อน`, details: { conflicts: [clash.id] } });
      const cs = ctx.changeSet();
      cs.update('RuleVersions', r, { status: 'ACTIVE', is_example: false, approved_by: ctx.principal.user_id, approved_at: ctx.now });
      cs.audit({ action: 'rule.activate', entityType: 'RuleVersions', entityId: r.id, after: { rule_type: r.rule_type, version_no: r.version_no, effective_from: r.effective_from } });
      const res = yield* commit(ctx, cs, { rule_id: r.id });
      invalidateConfigCache(ctx);
      return res;
    },
  }),

  op({
    name: 'rule.setEnd', mutation: true, description_th: 'กำหนดวันสิ้นสุดของกฎที่ใช้งาน (เก็บกฎเดิมไว้อธิบายผลคำนวณเดิม)', permission: 'settings.business',
    input: obj({ rule_id: S.uuid, effective_to: S.date, reason: S.str(500) }, ['rule_id', 'effective_to', 'reason']),
    *handler(ctx, input, env) {
      yield* requirePermission(ctx, 'settings.business');
      const r = yield ctx.store.get('RuleVersions', input.rule_id);
      if (!r) throw notFound('rule');
      assertVersion(r, env.expected_version);
      if (input.effective_to <= r.effective_from) throw new AppError('VALIDATION_ERROR', 'range', { messageTh: 'วันสิ้นสุดต้องหลังวันเริ่ม' });
      if (input.effective_to < ctx.today) throw new AppError('VALIDATION_ERROR', 'retroactive end', { messageTh: 'การสิ้นสุดย้อนหลังจะเปลี่ยนผลคำนวณเดิม ต้องใช้คำสั่งคำนวณย้อนหลังที่มีสิทธิ์และ audit แยก' });
      const cs = ctx.changeSet();
      const after = cs.update('RuleVersions', r, { effective_to: input.effective_to, status: r.status });
      cs.audit({ action: 'rule.set_end', entityType: 'RuleVersions', entityId: r.id, reason: input.reason, table: 'RuleVersions', before: r, after });
      const res = yield* commit(ctx, cs, { rule_id: r.id });
      invalidateConfigCache(ctx);
      return res;
    },
  }),

  op({
    name: 'setting.set', mutation: true, description_th: 'ตั้งค่าธุรกิจที่ไม่ลับ', permission: 'settings.business',
    input: obj({ key: { type: 'string', pattern: '^[a-z][a-z0-9_.]*$', maxLength: 100 }, value: {}, description_th: S.strOrNull(500) }, ['key']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'settings.business');
      if (/secret|token|password|key$/i.test(input.key)) throw new AppError('VALIDATION_ERROR', 'secret-like key', { messageTh: 'ห้ามเก็บค่าลับในตาราง Settings ให้ใช้ Script Properties' });
      const s = yield* school(ctx);
      const existing = (yield ctx.store.findBy('Settings', 'key', input.key))[0];
      const cs = ctx.changeSet();
      const value_json = { value: input.value === undefined ? null : input.value };
      const row = existing ? cs.update('Settings', existing, { value_json, is_example: false, description_th: input.description_th ?? existing.description_th })
        : cs.insert('Settings', { school_id: s.id, key: input.key, value_json, is_example: false, description_th: input.description_th });
      cs.audit({ action: 'setting.set', entityType: 'Settings', entityId: row.id, table: 'Settings', before: existing || null, after: row });
      return yield* commit(ctx, cs, { setting_id: row.id });
    },
  }),
];
