# Capacity estimate — Google Sheets phase

> สร้างอัตโนมัติจาก `tools/lib/capacity-model.mjs` + จำนวนคอลัมน์จริงใน `src/schema/tables.js` (`npm run gen`). ปรับสมมติฐานได้ด้วย `npm run capacity -- --students=1200 --late_rate=0.08`
> **ตัวเลขทั้งหมดเป็นสมมติฐานเพื่อวางแผน** ไม่ใช่จำนวนนักเรียนจริงหรือผลวัด ต้องแทนด้วยข้อมูลจาก pilot ก่อนตัดสินใจ

## สมมติฐาน

| ค่า | สมมติฐาน |
|---|---|
| students | 1500 |
| classes | 40 |
| guardians_per_student | 1.6 |
| staff | 120 |
| school_days_per_term | 100 |
| terms_per_year | 2 |
| late_rate | 0.05 |
| rollcall_exception_rate | 0.05 |
| absence_confirm_rate | 0.02 |
| leave_requests_per_day | 30 |
| segments_per_leave | 1.5 |
| revisions_per_leave | 3 |
| corrections_per_day | 5 |
| cases_per_day | 4 |
| contacts_per_day | 15 |
| notified_guardians_per_event | 1.5 |
| external_channels_per_recipient | 1.2 |
| dashboard_users | 10 |
| dashboard_poll_seconds | 60 |
| active_hours_per_day | 10 |
| gate_stations | 5 |

## จำนวนแถวและเซลล์ (rows × columns จาก schema จริง)

| ตาราง | ช่วง | workbook | แถว | คอลัมน์ | เซลล์ |
|---|---|---|---|---|---|
| DailyAttendance | ต่อภาคเรียน | Daily/term | 150,000 | 34 | 5,100,000 |
| AttendanceEvents | ต่อภาคเรียน | Ops/term | 18,500 | 23 | 425,500 |
| RollCallSessions | ต่อภาคเรียน | Ops/term | 4,000 | 19 | 76,000 |
| AttendanceCorrections | ต่อภาคเรียน | Ops/term | 500 | 21 | 10,500 |
| NotificationAttempts | ต่อภาคเรียน | Notify/term | 33,726 | 13 | 438,438 |
| MutationJournal | ต่อภาคเรียน | Ops/term | 62,118 | 19 | 1,180,242 |
| IdempotencyRecords | ต่อภาคเรียน | Ops/term | 28,500 | 11 | 313,500 |
| AuditEvents | ต่อภาคเรียน | Ops/term | 60,660 | 16 | 970,560 |
| ChangeLog | ต่อภาคเรียน | Ops/term | 59,160 | 9 | 532,440 |
| OperationMetrics | ต่อภาคเรียน | Ops/term | 25,000 | 11 | 275,000 |
| Notifications | ต่อภาคเรียน | Notify/term | 20,300 | 15 | 304,500 |
| NotificationRecipients | ต่อภาคเรียน | Notify/term | 25,550 | 14 | 357,700 |
| NotificationOutbox | ต่อภาคเรียน | Notify/term | 30,660 | 27 | 827,820 |
| Acknowledgements | ต่อภาคเรียน | Notify/term | 10,220 | 12 | 122,640 |
| WebhookInbox | ต่อภาคเรียน | Notify/term | 12,775 | 16 | 204,400 |
| Students | ต่อปี | Master | 525 | 20 | 10,500 |
| Guardians | ต่อปี | Master | 840 | 12 | 10,080 |
| StudentGuardians | ต่อปี | Master | 840 | 20 | 16,800 |
| Users | ต่อปี | Master | 682 | 18 | 12,276 |
| IdentityLinks | ต่อปี | Master | 682 | 17 | 11,594 |
| Enrollments | ต่อปี | Master | 1,575 | 13 | 20,475 |
| Classes | ต่อปี | Master | 40 | 13 | 520 |
| LeaveRequests | ต่อปี | Master | 6,000 | 30 | 180,000 |
| LeaveSegments | ต่อปี | Master | 9,000 | 14 | 126,000 |
| LeaveRevisions | ต่อปี | Master | 18,000 | 13 | 234,000 |
| LeaveApprovals | ต่อปี | Master | 9,000 | 15 | 135,000 |
| Cases | ต่อปี | Master | 800 | 23 | 18,400 |
| CaseEvents | ต่อปี | Master | 4,800 | 10 | 48,000 |
| ContactLogs | ต่อปี | Master | 3,000 | 16 | 48,000 |
| Appointments | ต่อปี | Master | 400 | 14 | 5,600 |
| ReconciliationTasks | ต่อปี | Master | 3,400 | 20 | 68,000 |
| Attachments | ต่อปี | Master | 2,325 | 19 | 44,175 |
| AttachmentLinks | ต่อปี | Master | 2,325 | 13 | 30,225 |
| StorageObjectMappings | ต่อปี | Master | 2,325 | 12 | 27,900 |
| ReportRuns | ต่อปี | Master | 4,000 | 23 | 92,000 |

## รวมต่อ workbook เทียบขีดจำกัด 10,000,000 เซลล์ต่อ spreadsheet

| workbook | เซลล์ที่คาด | % ของขีดจำกัด | ข้อสรุป |
|---|---|---|---|
| Daily/term | 5,100,000 | 51.0% | เฝ้าระวัง — แยก workbook/partition เพิ่ม |
| Ops/term | 3,783,742 | 37.8% | เหลือพื้นที่ |
| Notify/term | 2,255,498 | 22.6% | เหลือพื้นที่ |
| Master/year | 1,139,545 | 11.4% | เหลือพื้นที่ |

Master workbook สะสม 5 ปี ≈ 5,697,725 เซลล์ (57.0%) — ตาราง Leave*/Cases*/ContactLogs เติบโตตามปี ควร archive ตาม retention (docs/OPERATIONS_TH.md); Jobs ล้างตาม retention 90 วันจึงไม่นับสะสม

## ภาระงานและโควตาที่เกี่ยวข้อง (ประมาณการ)

| รายการ | ประมาณการ/วัน | ข้อจำกัดที่ต้องตรวจ |
|---|---|---|
| mutation (ผ่าน ScriptLock) | 592 | lock wait p95 วัดจริง; simultaneous executions 30/user (สคริปต์รันในบัญชีเจ้าของ) |
| outbox ภายนอก | 307 | ถ้าทั้งหมดเป็นอีเมล: MailApp recipients/day (consumer 100, Workspace 1,500 — ตรวจหน้าโควตาปัจจุบัน) → ใช้ LINE สำหรับผู้ปกครองเป็นหลัก |
| dashboard RPC | 1,800 | polling 60 วินาที + jitter เฉพาะแท็บที่เปิด |
| การสแกนช่วงพีค (ต่อนาที) | 30 | p95 ต่อการสแกนต้องวัดบนอุปกรณ์จริง |
| trigger ticks (ทุก 1 นาที) | 1,440 | trigger total runtime/day (consumer ~90 นาที, Workspace ~6 ชม. — ยืนยันกับหน้าโควตา) → tick ที่ไม่มีงานต้องจบเร็ว |

## เกณฑ์เริ่มย้ายไป REST backend + PostgreSQL (จากผล pilot)

- p95 การสแกนประตู > 4 วินาที ต่อเนื่อง 5 วันเรียน หรือ lock wait p95 > 2 วินาที
- queue age ของ outbox > 15 นาที ในช่วงเวลาทำการบ่อยครั้ง
- workbook ใดเกิน 70% ของขีดจำกัดเซลล์ก่อนสิ้นภาคเรียน
- quota error (Mail/UrlFetch/trigger runtime) เกิดซ้ำมากกว่า 1 ครั้ง/สัปดาห์
- ต้องการ transaction ข้าม workbook, availability หรือ realtime เกินที่ Apps Script ให้ได้
