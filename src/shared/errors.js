// Typed application errors shared by every layer (domain, application, adapters, transports).
// Error codes are stable API contract values; Thai messages are for display only.

export const ERROR_CODES = Object.freeze({
  UNAUTHENTICATED: { retryable: false, th: 'กรุณาเข้าสู่ระบบใหม่' },
  ACCOUNT_NOT_LINKED: { retryable: false, th: 'บัญชีนี้ยังไม่ได้เชื่อมกับผู้ใช้ในระบบ กรุณาใช้รหัสคำเชิญจากโรงเรียน' },
  ACCOUNT_DISABLED: { retryable: false, th: 'บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อโรงเรียน' },
  FORBIDDEN: { retryable: false, th: 'คุณไม่มีสิทธิ์ทำรายการนี้' },
  NOT_FOUND: { retryable: false, th: 'ไม่พบข้อมูลที่ต้องการ หรือคุณไม่มีสิทธิ์เข้าถึง' },
  VALIDATION_ERROR: { retryable: false, th: 'ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบช่องที่แจ้งเตือน' },
  CONFLICT: { retryable: false, th: 'ข้อมูลถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดข้อมูลล่าสุดก่อนทำรายการอีกครั้ง' },
  UNIQUE_VIOLATION: { retryable: false, th: 'มีข้อมูลนี้อยู่แล้วในระบบ' },
  INVALID_STATE: { retryable: false, th: 'ไม่สามารถทำรายการนี้ได้ในสถานะปัจจุบัน' },
  DUPLICATE_REQUEST_MISMATCH: { retryable: false, th: 'คำขอซ้ำใช้รหัสอ้างอิงเดิมแต่ข้อมูลต่างกัน ระบบไม่บันทึกซ้ำ' },
  MAINTENANCE_MODE: { retryable: true, th: 'ระบบอยู่ระหว่างปรับปรุง (อ่านอย่างเดียว) กรุณาลองใหม่ภายหลัง' },
  RATE_LIMITED: { retryable: true, th: 'มีการเรียกใช้งานถี่เกินไป กรุณารอสักครู่' },
  QUOTA_EXCEEDED: { retryable: true, th: 'ระบบใช้โควตาบริการเกินกำหนด กรุณาลองใหม่ภายหลัง' },
  STORAGE_UNAVAILABLE: { retryable: true, th: 'ระบบจัดเก็บข้อมูลไม่พร้อมใช้งานชั่วคราว ข้อมูลยังไม่ถูกบันทึก' },
  LOCK_TIMEOUT: { retryable: true, th: 'มีผู้ใช้งานพร้อมกันจำนวนมาก ข้อมูลยังไม่ถูกบันทึก กรุณาลองใหม่' },
  CONFIGURATION_REQUIRED: { retryable: false, th: 'ระบบยังตั้งค่าไม่ครบ กรุณาติดต่อผู้ดูแลระบบ' },
  FEATURE_DISABLED: { retryable: false, th: 'ฟังก์ชันนี้ยังไม่เปิดใช้งาน' },
  PAYLOAD_TOO_LARGE: { retryable: false, th: 'ข้อมูลหรือไฟล์มีขนาดเกินกำหนด' },
  UNSUPPORTED_OPERATION: { retryable: false, th: 'ไม่รองรับคำสั่งนี้' },
  UNSUPPORTED_SCHEMA: { retryable: false, th: 'รูปแบบข้อมูลหรือเวอร์ชัน schema ไม่รองรับ' },
  INTEGRITY_ERROR: { retryable: false, th: 'ข้อมูลไม่สมบูรณ์หรือ checksum ไม่ตรงกัน' },
  EXTERNAL_SERVICE_ERROR: { retryable: true, th: 'บริการภายนอกขัดข้อง ระบบจะลองใหม่อัตโนมัติ' },
  INTERNAL_ERROR: { retryable: true, th: 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่ หากยังพบปัญหาให้แจ้งรหัสอ้างอิงต่อผู้ดูแลระบบ' },
});

export class AppError extends Error {
  /**
   * @param {keyof typeof ERROR_CODES} code
   * @param {string} [message] developer-facing message (never contains secrets or other users' data)
   * @param {{fieldErrors?: Array<{field:string, code:string, message_th:string}>, details?: object, messageTh?: string, retryable?: boolean, cause?: unknown}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message || code);
    const def = ERROR_CODES[code] || ERROR_CODES.INTERNAL_ERROR;
    this.name = 'AppError';
    this.code = ERROR_CODES[code] ? code : 'INTERNAL_ERROR';
    this.messageTh = opts.messageTh || def.th;
    this.retryable = typeof opts.retryable === 'boolean' ? opts.retryable : def.retryable;
    this.fieldErrors = opts.fieldErrors || [];
    this.details = opts.details || null;
    if (opts.cause) this.cause = opts.cause;
  }
}

export function isAppError(err) {
  return !!err && (err instanceof AppError || err.name === 'AppError') && typeof err.code === 'string';
}

export function fieldError(field, code, messageTh) {
  return { field, code, message_th: messageTh };
}

export function validationError(fieldErrors, message) {
  return new AppError('VALIDATION_ERROR', message || 'validation failed', { fieldErrors });
}

/** Convert any thrown value to the public error envelope. Never leaks stack traces or internal messages. */
export function toErrorEnvelope(err, requestId) {
  const e = isAppError(err) ? err : new AppError('INTERNAL_ERROR', 'unexpected');
  return {
    ok: false,
    error: {
      code: e.code,
      message_th: e.messageTh,
      retryable: e.retryable,
      field_errors: e.fieldErrors,
      details: safeDetails(e.details),
    },
    meta: { request_id: requestId || null },
  };
}

function safeDetails(details) {
  if (!details || typeof details !== 'object') return null;
  // Only allow-listed keys are exposed to clients.
  const allowed = ['current_version', 'expected_version', 'entity', 'retry_after_seconds', 'conflicts', 'existing_id', 'status', 'missing', 'allowed_transitions'];
  const out = {};
  for (const k of allowed) if (k in details) out[k] = details[k];
  return Object.keys(out).length ? out : null;
}
