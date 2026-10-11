# ผลทดสอบโหลด — ช่วงพีคตอนเช้า (ข้อมูลสังเคราะห์)

> เครื่องมือ: `tools/load-test.mjs` (`npm run load -- --target …`) · รันเมื่อ 2026-10-11 บน container พัฒนา (4 vCPU, RAM 15 GB, Node 22.22.0, PostgreSQL 16)
> **ทุกตัวเลขในหน้านี้มาจากเครื่องพัฒนา ไม่ใช่ Apps Script จริง** — ผลบน Apps Script/Google Sheets จริง **ยังไม่ได้วัด** (ต้องใช้บัญชีโรงเรียน; วิธีวัดใน §5)

## 1. สถานการณ์และสมมติฐาน (MASTER_PROMPT §3)

| รายการ | ค่า (สมมติ ไม่ใช่ข้อมูลจริงของโรงเรียน) |
|---|---|
| นักเรียน | 1,500 คน (6 ระดับชั้น × 5 ห้อง × 50 คน, ข้อมูลสังเคราะห์) |
| จุดลงเวลา | 5 จุด — ต่อคน: `attendance.lookupForGate` (สแกน/พิมพ์รหัส) แล้ว `attendance.recordArrival` (ยืนยัน) เหมือนหน้าจอจริง |
| แดชบอร์ด | 10 ผู้ใช้ เรียก `dashboard.summary` นาทีละครั้ง (ค่าเริ่มต้นของหน้าจอ) |
| ช่วงเวลา | 07:10–08:10 (เวลาไทย) วันจันทร์ในภาคเรียนตัวอย่าง; เวลาเริ่มสาย 08:00 (กฎตัวอย่าง) → มาสาย ~1/6 |
| งานเบื้องหลัง | tick ทุกนาทีจำลอง (openDay ก่อนพีค, outbox, jobs ระหว่างพีค) |
| ผู้ปกครองที่มีบัญชี | 20% (300 บัญชี, อีเมล example.com) — ข้อความไม่ออกนอก process (fake provider) |

## 2. ผล

### 2.1 REST backend อ้างอิง + PostgreSQL 16 (`--target rest`) — **พร้อมกันจริง** 5 จุด + 10 แดชบอร์ด

API (node:http) และตัวสร้างโหลดอยู่ใน process เดียวกันบนเครื่องเดียวกับ PostgreSQL — เวลาจึงรวมการแย่ง CPU ของตัวสร้างโหลดด้วย

| operation | จำนวน | p50 ms | p95 ms | max ms | error |
|---|---|---|---|---|---|
| attendance.lookupForGate | 1,500 | 22.1 | 117.5 | 708.9 | 0 |
| attendance.recordArrival | 1,500 | 62.6 | 217.1 | 387.6 | 0 |
| dashboard.summary (ทั้งโรงเรียน/ตามขอบเขต) | 316 | 262.7 | **3,443.1** | 4,030.6 | 0 |
| tick ทุกนาที | 60 | 119.0 | 222.6 | 285.1 | 0 |

- ChangeLog sequence lock wait: p50 3 ms, p95 22 ms, max 142 ms (1,563 commit)
- เหตุการณ์ 1,500 แถว, **ไม่มีการบันทึกซ้ำ** (0 นักเรียนที่มีเหตุการณ์มาถึงซ้ำ), มาสาย 246 คน
- ทำ 1,500 คนเสร็จใน 37.4 วินาที (≈ 2,400 คน/นาที — เพดานของเครื่องพัฒนา ไม่ใช่สิ่งที่ต้องการจริงซึ่ง ≈ 25–30 คน/นาที)
- outbox = 0 แถว เพราะ REST backend ยังไม่มีช่องทางอีเมล/LINE (D-036) — queue latency ไม่มีความหมายบน REST ในชุดนี้

### 2.2 Application layer ใน process (`--target memory`) — ต้นทุนของโค้ดเอง ไม่มี I/O

| operation | จำนวน | p50 ms | p95 ms | max ms | error |
|---|---|---|---|---|---|
| attendance.lookupForGate | 1,500 | 0.6 | 1.4 | 4.5 | 0 |
| attendance.recordArrival | 1,500 | 3.0 | 6.6 | 12.6 | 0 |
| dashboard.summary | 750 | 25.3 | 109.0 | 146.6 | 0 |
| tick ทุกนาที | 60 | 0.8 | 11.6 | 19.9 | 0 |

- openDay (สร้างแถว UNKNOWN 1,500 แถว) 661 ms
- **queue latency** (สร้างข้อความ → ผู้ให้บริการรับ, นับเป็นนาทีจำลอง tick ละ 1 นาที): 50 อีเมล, p50 0.6, p95 1.6, max 1.8 นาที
- โควตาอีเมล: 50 อีเมล/เช้า (มาสาย 249 คน × ผู้ปกครองที่มีบัญชี 20%) — ถ้าผู้ปกครองทุกคนมีบัญชีอีเมล จะใช้ราว 250 ผู้รับ/เช้าสำหรับการมาสายอย่างเดียว เทียบโควตา MailApp ที่ต้องตรวจ (CAPACITY.md: consumer 100/วัน, Workspace 1,500/วัน) → ใช้ LINE เป็นช่องทางหลักของผู้ปกครอง

### 2.3 gas-dist บน Apps Script emulator (`--target gas-emulator`) — ทีละ execution, ไม่มี latency ของ Sheets

| operation | จำนวน | p50 ms | p95 ms | max ms | error |
|---|---|---|---|---|---|
| attendance.lookupForGate | 1,500 | 1.2 | 2.4 | 5.5 | 0 |
| attendance.recordArrival | 1,500 | 4.9 | 10.5 | 18.2 | 0 |
| dashboard.summary | 750 | 36.2 | 195.4 | 269.0 | 0 |
| cronTick ทุกนาที | 60 | 1.1 | 3.1 | 5.1 | 0 |

- 3,810 execution ในช่วงพีค (สแกน 3,000 + แดชบอร์ด 750 + tick 60) — **เป็นขอบล่างเท่านั้น**: emulator ไม่มีเวลาเรียก SpreadsheetApp/Drive จริง ไม่มี execution พร้อมกัน และไม่มีโควตา

## 3. ข้อสรุปจากผลที่มี

| หัวข้อ | ผล | สิ่งที่ต้องทำ |
|---|---|---|
| ความถูกต้องภายใต้โหลด | 0 error, ไม่มีบันทึกซ้ำ ทั้ง 3 เป้าหมาย; ChangeLog ต่อเนื่อง | — |
| ลงเวลา (ฝั่ง server) | REST p95 ≈ 0.2 วินาที ภายใต้ 5 จุด + 10 แดชบอร์ดพร้อมกัน | วัดบน Apps Script จริง (§5) — ScriptLock + Sheets I/O คาดว่าช้ากว่ามาก |
| **คอขวด: แดชบอร์ดทั้งโรงเรียน** | REST p95 3.4 วินาทีเมื่อแข่งกับการสแกน; คำนวณสดจาก projection ทุกครั้ง | ก่อนเพิ่มผู้ใช้แดชบอร์ด: cache ผลต่อขอบเขต 60 วินาที หรือสรุปล่วงหน้า; บน Sheets ให้วัดก่อนเปิดแดชบอร์ดทั้งโรงเรียนช่วงเช้า |
| lock ของ ChangeLog (PostgreSQL) | p95 22 ms | เพียงพอสำหรับขนาดนี้; ถ้าเพิ่มหลายโรงเรียนต้องทบทวน (D-032) |
| คิวข้อความ | ≤ 2 นาทีจำลองในชุดนี้ | ขึ้นกับโควตา MailApp/LINE จริง และจังหวะ trigger บน Apps Script |
| เป้าหมาย 10–15 วินาที/คน | **ยังไม่ได้วัด** — ต้องวัดกับคนจริงที่ประตู (รวมเวลาสแกน มองหน้า กดยืนยัน) | UAT_CHECKLIST_TH §B4 |

## 4. ผลกระทบต่อโควตา Apps Script (ประมาณจากจำนวนที่วัดได้ — ไม่ใช่ผลวัดบน Google)

| รายการ | จากการทดสอบ | เทียบกับข้อจำกัด (ต้องตรวจหน้าโควตาปัจจุบัน — DECISIONS ท้ายไฟล์) |
|---|---|---|
| execution ของ `google.script.run` ช่วงพีค 1 ชม. | ≈ 3,750 (+ cronTick 60) | ทุก execution รันในบัญชีเจ้าของ (Execute as me): ต้องไม่เกิน simultaneous executions ต่อผู้ใช้ — 5 จุด + 10 แดชบอร์ด = พร้อมกันไม่เกิน ~15 ในหลักการ แต่ต้องวัดจริง |
| การเขียนผ่าน ScriptLock | 1,500 ในชั่วโมงเดียว (≈ 25/นาที) | lock wait จริงอ่านได้จาก `system.metrics` (OperationMetrics) |
| UrlFetch (ตรวจ token ผ่าน gateway) | ≈ 1 ครั้ง/ผู้ใช้/5 นาที (cache 300 วินาที) | UrlFetch calls/day |
| อีเมล | 50 ต่อเช้า (สมมติฐานบัญชี 20%) | MailApp recipients/day |
| trigger runtime | 60 tick/ชม. | trigger total runtime/day |

## 5. วิธีวัดบน Apps Script จริง (ยังไม่ได้ทำ — ต้องใช้บัญชีโรงเรียน)

1. deployment STAGING ที่ติดตั้งตาม INSTALL_GAS_TH + `adminSeedDemo` ขนาดใกล้จริง (หรือข้อมูลนำเข้าที่ไม่ใช่ข้อมูลจริง)
2. อุปกรณ์จริง 5 เครื่องที่ประตู + ครู 10 คนเปิดแดชบอร์ด ในช่วงเวลาเดียวกัน; ใช้บัตร/รหัสทดสอบ
3. หลังจบ: หน้า "สถานะระบบ" → metrics (p50/p95 ต่อ operation, lock wait) จาก OperationMetrics; Apps Script Executions (เวลา/ข้อผิดพลาด); คิวแจ้งเตือน (queue age); บันทึกเวลาต่อคนด้วยนาฬิกาจับเวลา
4. เทียบเกณฑ์ใน CAPACITY.md ("เกณฑ์เริ่มย้ายไป REST backend") และบันทึกผลลงตาราง §2 ใหม่ แยกหัวข้อ "Apps Script จริง"

## 6. คำสั่ง

```bash
npm run load -- --target memory
npm run load -- --target gas-emulator                  # ต้อง npm run build ก่อน
CWK_PG_PORT=54329 node tools/pg-local.mjs start         # หรือ PostgreSQL ที่สร้าง/ลบฐานข้อมูลทดสอบได้
DATABASE_URL=postgres://cwk@127.0.0.1:54329/cwk_test npm run load -- --target rest
# ตัวเลือก: --students 1500 --stations 5 --dashboards 10 --mail-quota 1500 --json ผล.json
```
