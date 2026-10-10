// Versioned business rules (RuleVersions). Every computed result records the rule version used.
// Values shipped in seeds are EXAMPLES (is_example = true) and the System Health page blocks
// production go-live until the school confirms real values (MASTER_PROMPT §3, §9).

import { assertValid } from '../shared/validate.js';
import { AppError } from '../shared/errors.js';

const LEVELS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'];

export const RULE_PARAM_SCHEMAS = Object.freeze({
  SCHOOL_LATENESS: {
    type: 'object', additionalProperties: false,
    required: ['cutoff_time', 'grace_minutes', 'rounding', 'late_minutes_basis'],
    properties: {
      cutoff_time: { type: 'string', format: 'hhmm', description: 'เวลาเริ่มนับสายเข้าโรงเรียน (ไม่ใช่เวลาเริ่มสายรายคาบ)' },
      grace_minutes: { type: 'integer', minimum: 0, maximum: 60 },
      rounding: { type: 'string', enum: ['CEIL_MINUTE', 'FLOOR_MINUTE'] },
      late_minutes_basis: { type: 'string', enum: ['CUTOFF', 'GRACE_END'] },
      applies_to_levels: { type: ['array', 'null'], items: { type: 'string', enum: LEVELS } },
    },
  },
  PERIOD_LATENESS: {
    type: 'object', additionalProperties: false, required: ['grace_minutes'],
    properties: { grace_minutes: { type: 'integer', minimum: 0, maximum: 30 } },
  },
  FOLLOWUP_LATE_COUNT: {
    type: 'object', additionalProperties: false,
    required: ['threshold_count', 'window_school_days', 'count_exempted', 'cooldown_school_days', 'priority', 'due_in_days'],
    properties: {
      threshold_count: { type: 'integer', minimum: 1, maximum: 100 },
      window_school_days: { type: 'integer', minimum: 1, maximum: 200 },
      count_exempted: { type: 'boolean' },
      cooldown_school_days: { type: 'integer', minimum: 0, maximum: 200 },
      priority: { type: 'string', enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'] },
      due_in_days: { type: 'integer', minimum: 0, maximum: 60 },
    },
  },
  FOLLOWUP_ABSENCE_COUNT: {
    type: 'object', additionalProperties: false,
    required: ['threshold_count', 'window_school_days', 'cooldown_school_days', 'priority', 'due_in_days'],
    properties: {
      threshold_count: { type: 'integer', minimum: 1, maximum: 100 },
      window_school_days: { type: 'integer', minimum: 1, maximum: 200 },
      cooldown_school_days: { type: 'integer', minimum: 0, maximum: 200 },
      priority: { type: 'string', enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'] },
      due_in_days: { type: 'integer', minimum: 0, maximum: 60 },
    },
  },
  LEAVE_ROUTING: {
    type: 'object', additionalProperties: false,
    required: ['routes', 'guardian_confirmation_required_for', 'retroactive_max_days', 'attachment_required_rules'],
    properties: {
      routes: {
        type: 'array', minItems: 1,
        items: {
          type: 'object', additionalProperties: false, required: ['approver_role'],
          properties: {
            leave_types: { type: ['array', 'null'], items: { type: 'string', enum: ['SICK', 'PERSONAL', 'SCHOOL_ACTIVITY', 'OTHER'] } },
            min_school_days: { type: ['integer', 'null'], minimum: 0 },
            max_school_days: { type: ['integer', 'null'], minimum: 0 },
            grade_levels: { type: ['array', 'null'], items: { type: 'string', enum: LEVELS } },
            approver_role: { type: 'string', enum: ['HOMEROOM_TEACHER', 'STUDENT_AFFAIRS'] },
          },
        },
      },
      guardian_confirmation_required_for: { type: 'array', items: { type: 'string', enum: ['STUDENT', 'STAFF', 'GUARDIAN'] } },
      retroactive_max_days: { type: 'integer', minimum: 0, maximum: 60 },
      attachment_required_rules: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: ['leave_type', 'min_school_days'], properties: { leave_type: { type: 'string' }, min_school_days: { type: 'integer', minimum: 1 } } },
      },
    },
  },
  ABSENCE_VERIFICATION: {
    type: 'object', additionalProperties: false, required: ['verify_after_time', 'notify_guardian_on_confirm'],
    properties: { verify_after_time: { type: 'string', format: 'hhmm' }, notify_guardian_on_confirm: { type: 'boolean' } },
  },
  NOTIFICATION_POLICY: {
    type: 'object', additionalProperties: false,
    required: ['quiet_hours', 'ack_required_types', 'ack_timeout_hours', 'max_attempts', 'channels_by_type'],
    properties: {
      quiet_hours: { type: ['object', 'null'], additionalProperties: false, required: ['start', 'end'], properties: { start: { type: 'string', format: 'hhmm' }, end: { type: 'string', format: 'hhmm' } } },
      ack_required_types: { type: 'array', items: { type: 'string' } },
      ack_timeout_hours: { type: 'integer', minimum: 1, maximum: 168 },
      max_attempts: { type: 'integer', minimum: 1, maximum: 20 },
      channels_by_type: { type: 'object' },
    },
  },
});

/** Example rule params used in DEV seeds — NOT school policy. */
export const EXAMPLE_RULE_PARAMS = Object.freeze({
  SCHOOL_LATENESS: { cutoff_time: '08:00', grace_minutes: 0, rounding: 'CEIL_MINUTE', late_minutes_basis: 'CUTOFF', applies_to_levels: null },
  FOLLOWUP_LATE_COUNT: { threshold_count: 3, window_school_days: 30, count_exempted: false, cooldown_school_days: 10, priority: 'NORMAL', due_in_days: 3 },
  FOLLOWUP_ABSENCE_COUNT: { threshold_count: 3, window_school_days: 30, cooldown_school_days: 10, priority: 'HIGH', due_in_days: 2 },
  LEAVE_ROUTING: {
    routes: [
      { leave_types: ['SCHOOL_ACTIVITY'], approver_role: 'STUDENT_AFFAIRS' },
      { leave_types: null, max_school_days: 3, approver_role: 'HOMEROOM_TEACHER' },
      { leave_types: null, min_school_days: 4, approver_role: 'STUDENT_AFFAIRS' },
    ],
    guardian_confirmation_required_for: ['STUDENT'],
    retroactive_max_days: 7,
    attachment_required_rules: [{ leave_type: 'SICK', min_school_days: 3 }],
  },
  ABSENCE_VERIFICATION: { verify_after_time: '10:00', notify_guardian_on_confirm: true },
  NOTIFICATION_POLICY: {
    quiet_hours: { start: '21:00', end: '06:00' },
    ack_required_types: ['ABSENCE_CONFIRMED', 'CASE_NEW'],
    ack_timeout_hours: 24,
    max_attempts: 6,
    channels_by_type: {
      LATE_CONFIRMED: ['LINE', 'EMAIL'], ABSENCE_CONFIRMED: ['LINE', 'EMAIL'], LEAVE_DECIDED: ['LINE', 'EMAIL'],
      LEAVE_PENDING_GUARDIAN: ['LINE', 'EMAIL'], LEAVE_PENDING_SCHOOL: ['EMAIL'], LEAVE_NEW: ['EMAIL'], CASE_NEW: ['EMAIL'],
      CASE_OVERDUE: ['EMAIL'], CALLBACK_REQUESTED: ['EMAIL'], DATA_CORRECTED: ['LINE', 'EMAIL'], ROLL_CALL_REMINDER: ['EMAIL'], SYSTEM: ['EMAIL'],
    },
  },
});

export function validateRuleParams(ruleType, params) {
  const schema = RULE_PARAM_SCHEMAS[ruleType];
  if (!schema) throw new AppError('VALIDATION_ERROR', `unknown rule type ${ruleType}`);
  return assertValid(schema, params, `invalid ${ruleType} params`);
}

/**
 * Select the ACTIVE rule version effective on `date`. When several overlap (should not happen —
 * the settings service rejects overlaps) the highest version_no wins, deterministically.
 * Returns null when no rule is configured: callers must surface CONFIGURATION_REQUIRED.
 */
export function selectRule(ruleVersions, ruleType, date) {
  let best = null;
  for (const r of ruleVersions) {
    if (r.rule_type !== ruleType || r.status !== 'ACTIVE') continue;
    if (date < r.effective_from) continue;
    if (r.effective_to != null && date >= r.effective_to) continue;
    if (!best || r.version_no > best.version_no) best = r;
  }
  return best;
}

export function requireRule(ruleVersions, ruleType, date) {
  const r = selectRule(ruleVersions, ruleType, date);
  if (!r) throw new AppError('CONFIGURATION_REQUIRED', `no active ${ruleType} rule on ${date}`, { messageTh: `ยังไม่ได้ตั้งค่ากฎ ${ruleType} ที่มีผลในวันที่ ${date}` });
  return r;
}

/** Overlap check used when activating a new version. */
export function findOverlappingRule(ruleVersions, candidate) {
  return ruleVersions.find((r) => r.id !== candidate.id && r.rule_type === candidate.rule_type && r.status === 'ACTIVE'
    && (r.effective_to == null || r.effective_to > candidate.effective_from)
    && (candidate.effective_to == null || candidate.effective_to > r.effective_from)) || null;
}
