# คู่มือ gateway (LINE webhook + ตรวจ Firebase ID token) — CWK Smart Care

> สถานะ: โค้ดใน `gateway/` ใช้งานได้จริงเมื่อตั้งค่าครบ และผ่านการทดสอบอัตโนมัติด้วยตัวจำลอง
> (`tests/gateway/gateway.test.mjs`, `tests/gas/gas-runtime.test.mjs`) **แต่ยังไม่ได้ทดสอบกับ LINE, Firebase
> หรือ Cloud Run จริง** เพราะยังไม่มีบัญชีของโรงเรียน — ต้องทำตามรายการทดสอบ 🧪 ท้ายเอกสารก่อนเปิดใช้
>
> ห้ามใส่ค่าความลับจริงในเอกสาร แชต หรือ repository — ใส่ใน Secret Manager / Script Properties ตอนติดตั้งเท่านั้น

## 1. ทำไมต้องมี gateway

| งาน | เหตุผล (DECISIONS D-003, D-010) |
|---|---|
| ตรวจลายเซ็น LINE (`x-line-signature`) | เอกสาร Web Apps ของ Apps Script ไม่ได้ระบุว่า `doPost(e)` อ่าน request header ได้ จึงตรวจลายเซ็น LINE ใน GAS ไม่ได้ |
| ตรวจ Firebase ID token | ต้องใช้ Firebase Admin SDK `verifyIdToken(token, checkRevoked=true)` เพื่อตรวจลายเซ็น ผู้ออก ผู้รับ อายุ และสถานะถูกเพิกถอน/ระงับ — ห้าม decode JWT เองใน GAS |

ระบบหลัก (ในแอป + อีเมล) ใช้งานได้โดย**ไม่ต้องมี** LINE; ส่วน identity gateway จำเป็นเมื่อใช้ `CWK_AUTH_MODE=GATEWAY` (บังคับใน PROD)

## 2. เส้นทาง (routes)

| method/path | ผู้เรียก | การตรวจ | ผลลัพธ์ |
|---|---|---|---|
| `POST /line/webhook` | LINE Platform | HMAC-SHA256(channel secret, **raw body**) เทียบแบบ constant-time **ก่อน** parse JSON; จำกัด 1 MB | แยกทีละ event → envelope ที่ลงลายเซ็น → GAS `/exec`; ตอบ 200 **หลัง** GAS ตอบ `{ok:true, stored:true}` ครบทุก event; ไม่เช่นนั้นตอบ 503 ให้ LINE ส่งซ้ำ |
| `POST /v1/identity/verify` | GAS (UrlFetchApp) | `X-CWK-Key-Id`, `X-CWK-Timestamp` (±300 วินาที), `X-CWK-Nonce` (กันใช้ซ้ำ), `X-CWK-Signature` = HMAC ของ method/path/เวลา/nonce/SHA-256 ของ body | `verifyIdToken(token, true)`; คำตอบลงลายเซ็น `X-CWK-Signature` ผูกกับ nonce ของคำขอ |
| `POST /v1/identity/revoke` | GAS | เหมือนข้างบน (ลายเซ็นผูกกับ path — ใช้ข้าม route ไม่ได้) | `revokeRefreshTokens(uid)` |
| `GET /healthz` | Cloud Run | — | `{ok:true}` ไม่เปิดเผยค่าตั้ง |

รูปแบบสตริงที่ลงลายเซ็นอยู่ไฟล์เดียว `src/shared/gateway-protocol.js` (GAS และ gateway ใช้ร่วมกัน) — เปลี่ยนรูปแบบ = เปลี่ยนเวอร์ชันโปรโตคอล

Envelope ที่ส่งให้ GAS: `{v:1, kid, ts, nonce=webhookEventId, source:"LINE", payload:<JSON ของ event เดิม>, sig}`
GAS ตรวจ key id, เวลา, HMAC, schema แล้วบันทึกลง `WebhookInbox` (unique ตาม `source + webhook_event_id`) **ก่อน**ตอบ — การรู้ URL `/exec` ไม่ได้ให้สิทธิ์ใด ๆ

## 3. ค่าตั้ง (environment variables ของ gateway)

| ตัวแปร | ความลับ? | ใช้กับ | หมายเหตุ |
|---|---|---|---|
| `CWK_GATEWAY_KEY_ID` | ไม่ | identity | ต้องตรงกับ `CWK_GATEWAY_KEY_ID` ใน Script Properties |
| `CWK_GATEWAY_SECRET` | **ใช่** | identity | ค่าเดียวกับ `CWK_GATEWAY_SECRET` ของ GAS (สุ่ม ≥ 32 ไบต์) |
| `FIREBASE_PROJECT_ID` | ไม่ | identity | ต้องตรงกับ `CWK_FIREBASE_PROJECT_ID`; gateway ปฏิเสธคำขอที่ระบุโปรเจกต์อื่น |
| `FIREBASE_TENANT_ID` | ไม่ | identity | ว่างถ้าไม่ใช้ multi-tenancy |
| `LINE_CHANNEL_SECRET` | **ใช่** | LINE | Channel secret ของ Messaging API channel — เก็บที่ gateway **เท่านั้น** |
| `CWK_LINE_WEBHOOK_KEY_ID` | ไม่ | LINE | ต้องตรงกับ Script Property ชื่อเดียวกัน |
| `CWK_LINE_WEBHOOK_SECRET` | **ใช่** | LINE | HMAC ของ envelope (คนละค่ากับ channel secret และกับ identity secret) |
| `GAS_WEBAPP_URL` | ไม่ | LINE | ต้องเป็น URL รูปแบบ `https://script.google.com/macros/s/<id>/exec` (ระบบตรวจรูปแบบ) |
| `GAS_FORWARD_TIMEOUT_MS` | ไม่ | LINE | ค่าเริ่มต้น 25000 |

ถ้าตั้งไม่ครบ ฟีเจอร์นั้นปิดเอง (route ตอบ 404) ถ้าปิดทั้งสองอย่าง โปรแกรมไม่เริ่มทำงาน

สร้างค่าสุ่ม (ทำบนเครื่องผู้ดูแล แล้ววางลง Secret Manager โดยตรง ไม่ส่งต่อทางแชต): `openssl rand -base64 32`

Channel access token ของ LINE ใส่ใน Script Properties `CWK_LINE_CHANNEL_ACCESS_TOKEN` ของ GAS (GAS เป็นผู้ส่งข้อความ push/reply โดยตรง) — gateway ไม่ต้องรู้ค่านี้

## 4. Deploy บน Cloud Run (ตัวอย่าง — ตรวจคำสั่งกับเอกสาร Google Cloud ปัจจุบันก่อนใช้)

Dockerfile อยู่ที่ `gateway/Dockerfile` และต้อง build จาก **root ของ repository** (เพื่อรวม `src/shared/gateway-protocol.js`)

```bash
# 1) build + push image (Artifact Registry ของโปรเจกต์โรงเรียน)
IMAGE=asia-southeast1-docker.pkg.dev/<PROJECT>/cwk/cwk-gateway:0.4.0
gcloud builds submit . --config gateway/cloudbuild.yaml --substitutions=_IMAGE=$IMAGE

# 2) สร้าง secret (ครั้งแรก) — ค่าใส่ผ่าน stdin หรือ Console ไม่ใส่ใน shell history
gcloud secrets create cwk-gateway-secret --replication-policy=automatic
gcloud secrets versions add cwk-gateway-secret --data-file=-        # วางค่าแล้วกด Ctrl-D
# ทำเช่นเดียวกันกับ cwk-line-channel-secret และ cwk-line-envelope-secret

# 3) deploy
gcloud run deploy cwk-gateway --image=$IMAGE --region=asia-southeast1 \
  --service-account=cwk-gateway@<PROJECT>.iam.gserviceaccount.com \
  --allow-unauthenticated --max-instances=3 --concurrency=20 \
  --set-env-vars=CWK_GATEWAY_KEY_ID=gas-prod-1,FIREBASE_PROJECT_ID=<FIREBASE_PROJECT>,CWK_LINE_WEBHOOK_KEY_ID=line-prod-1,GAS_WEBAPP_URL=https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec \
  --set-secrets=CWK_GATEWAY_SECRET=cwk-gateway-secret:latest,LINE_CHANNEL_SECRET=cwk-line-channel-secret:latest,CWK_LINE_WEBHOOK_SECRET=cwk-line-envelope-secret:latest
```

- `--allow-unauthenticated` จำเป็นเพราะ LINE และ Apps Script เรียกโดยไม่มี Google identity token — ความปลอดภัยมาจากลายเซ็น LINE และ HMAC ทุกคำขอ
- service account ของ gateway ต้องมีสิทธิ์อ่านผู้ใช้และเพิกถอน refresh token ของ Firebase Authentication ในโปรเจกต์ Firebase (เช่นบทบาทผู้ดูแล Firebase Authentication — ตรวจชื่อบทบาทล่าสุดในเอกสาร IAM) และสิทธิ์อ่าน secret ที่ใช้
- Firebase Admin SDK ใช้ Application Default Credentials ของ service account (ไม่ต้องมีไฟล์ key)
- region `asia-southeast1` เป็นตัวอย่าง (ใกล้ประเทศไทย) — เลือกตามนโยบายข้อมูลของโรงเรียน
- log เป็น JSON บรรทัดเดียว ไม่มี body, token, ลายเซ็น หรือ LINE user ID

ทางเลือกที่ไม่ใช้ Cloud Run: โฮสต์ Node.js 22 ใดก็ได้ที่มี HTTPS (`npm ci --omit=dev && node src/server.mjs` ในโฟลเดอร์ `gateway/` พร้อมโฟลเดอร์ `src/shared/` ของ repo)

## 5. ตั้งค่า LINE Developers Console (Messaging API channel)

1. สร้าง LINE Official Account + Messaging API channel ของโรงเรียน (ไม่ใช้ LINE Notify ซึ่งยุติบริการแล้ว)
2. Webhook URL: `https://<cloud-run-url>/line/webhook` → กด **Verify** (gateway ตอบ 200 สำหรับ events ว่าง)
3. เปิด **Use webhook** และเปิด **Webhook redelivery** (ระบบพึ่งการส่งซ้ำเมื่อ GAS ชั่วคราวล่ม — ไม่มี queue เสริม)
4. ปิดข้อความตอบกลับอัตโนมัติของ OA ที่ซ้ำซ้อนกับระบบ (ตามความเหมาะสม)
5. ออก channel access token → ใส่ใน Script Properties `CWK_LINE_CHANNEL_ACCESS_TOKEN`
6. Script Properties อื่น: `CWK_LINE_ENABLED=true`, `CWK_LINE_WEBHOOK_KEY_ID`, `CWK_LINE_WEBHOOK_SECRET`, `CWK_LINE_ADD_FRIEND_URL` (ลิงก์เพิ่มเพื่อน), `CWK_WEBAPP_URL` (ใช้สร้างลิงก์เชื่อมบัญชี — ต้องเป็น https)

## 6. การเชื่อมบัญชี LINE กับบัญชีในระบบ (account link)

1. ผู้ใช้เพิ่มเพื่อน OA → LINE ส่ง event `follow` → GAS ขอ link token (`POST /v2/bot/user/{userId}/linkToken`) แล้วตอบกลับด้วยลิงก์ `…/exec?page=line-link&linkToken=…`
2. ผู้ใช้เปิดลิงก์และ**เข้าสู่ระบบ**ด้วยบัญชีของตน → ระบบสร้าง nonce สุ่ม (เก็บเฉพาะ SHA-256, อายุ 10 นาที, ใช้ครั้งเดียว) แล้วพาไปหน้ายืนยันของ LINE
3. LINE ส่ง event `accountLink` พร้อม nonce → GAS จับคู่ nonce → ผูก LINE user ID กับผู้ใช้ (`ChannelBindings` ACTIVE)

- เบราว์เซอร์**ไม่เคย**ส่ง LINE user ID ให้ระบบเชื่อถือ
- การเชื่อม LINE ≠ การยืนยันความสัมพันธ์ผู้ปกครอง-นักเรียน (โรงเรียนยืนยันแยกต่างหาก) ข้อความเรื่องนักเรียนส่งถึงผู้ที่มีความสัมพันธ์ที่ยืนยันและมีสิทธิ์ `RECEIVE_NOTIFICATIONS` เท่านั้น และตรวจซ้ำทุกครั้งก่อนส่ง
- หนึ่งบัญชี LINE ผูกกับผู้ใช้ได้หนึ่งคน; ผูกใหม่ = ยกเลิกของเดิม; `unfollow` = ยกเลิกการผูก; ผู้ใช้ยกเลิกเองได้ในหน้า "การแจ้งเตือน"; เจ้าหน้าที่ยกเลิกให้ได้ (`channel.revokeForUser`)
- ปุ่ม "รับทราบ / ขอให้ครูติดต่อกลับ" ใน LINE เป็น postback ที่ระบบตรวจว่า LINE user นั้นผูกกับ**ผู้รับคนนั้นจริง** — ไม่มี URL อนุมัติที่เดาได้; การอนุมัติใบลาทำในหน้าเว็บที่ตรวจสิทธิ์เท่านั้น
- ข้อความตัวอักษรจากผู้ปกครองที่ผูกบัญชีแล้ว → รายการ "ติดต่อเข้า" ในหน้างานติดตามของครูที่ปรึกษาของบุตรหลานทุกคนที่เชื่อมโยง; ไม่ดาวน์โหลดรูป/ไฟล์; ไม่ประมวลผลข้อความในกลุ่ม/ห้องแชต

## 7. การส่งข้อความและการส่งซ้ำ (outbox)

- GAS ส่ง push ด้วย header `X-Line-Retry-Key` ค่าเดิมทุกครั้งที่ retry รายการเดิม; HTTP 409 = LINE เคยรับคำขอนี้แล้ว → บันทึกเป็น "ผู้ให้บริการรับคำขอแล้ว" ไม่ส่งซ้ำ
- ถ้า worker หยุดหลัง LINE รับแล้วแต่ก่อนบันทึกผล รอบถัดไปส่งซ้ำด้วย key เดิม (ปลอดภัย); อีเมลไม่มีกลไกนี้ → สถานะ "ส่งไม่สำเร็จ / ไม่ทราบผล" และ**ไม่ส่งซ้ำเอง** เจ้าหน้าที่ตัดสินใจกด "ส่งใหม่" ในหน้า "ติดตามการส่งแจ้งเตือน"
- อายุที่ยอมใช้ retry key เดิม: `CWK_LINE_RETRY_WINDOW_HOURS` (ค่าเริ่มต้น 12 ชั่วโมง) — **ยังไม่ได้ยืนยันอายุ key จากหน้าเอกสาร LINE โดยตรง** ให้ผู้ติดตั้งตรวจแล้วปรับ (DECISIONS D-011)
- "ผู้ให้บริการรับคำขอแล้ว" ไม่ใช่ "ผู้ปกครองอ่านแล้ว" — การรับทราบเก็บแยกเมื่อผู้รับกดเอง
- DEV/STAGING ส่งออกเฉพาะผู้รับใน `CWK_NOTIFY_ALLOWLIST` (อีเมลหรือ LINE user ID ของผู้ทดสอบ); รายการว่าง = ไม่ส่งออกเลย; PROD ต้องว่าง

## 8. ข้อจำกัดที่ทราบ (ต้องทดสอบในสภาพจริง)

- **เวลาตอบของ webhook**: gateway ตอบ LINE หลัง GAS บันทึกเสร็จ ถ้า GAS ช้ากว่าที่ LINE รอ LINE จะถือว่าล้มเหลวและส่งซ้ำ (ระบบ dedupe ด้วย webhookEventId จึงไม่บันทึกซ้ำ แต่ reply token อาจหมดอายุ) — ยังไม่ได้วัดกับ LINE จริง
- **นโยบาย Workspace**: gateway เรียก `/exec` แบบไม่ลงชื่อ Google จึงต้อง deploy เว็บแอปแบบ "Anyone" (appsscript.json ตั้ง `ANYONE_ANONYMOUS`) ถ้านโยบายองค์กรไม่อนุญาต ให้ผู้ดูแลองค์กรเลือกช่องทางที่อนุญาต (เช่น ย้าย backend เป็น REST ตามเส้นทางอัปเกรด) — **ยังไม่มีโหมดที่ GAS ดึง event จาก gateway (pull) ในชุดนี้** และห้ามเลี่ยงด้วยการปิดการตรวจสอบ
- **กันคำขอซ้ำ (nonce)** ของ identity endpoint เก็บในหน่วยความจำของแต่ละ instance; คำขอยังหมดอายุใน ±300 วินาที และการเล่นซ้ำคำขอ verify/revoke ไม่ให้สิทธิ์เพิ่ม
- ไม่มี queue เสริม — พึ่ง LINE redelivery (ต้องเปิดใน console)
- SMS ไม่มีผู้ให้บริการ — ปิดไว้ (ไม่อ้างว่าใช้ได้)

## 9. รายการทดสอบก่อนเปิดใช้ 🧪

| # | ทดสอบ | ผลที่ต้องได้ |
|---|---|---|
| 1 | `curl https://<gateway>/healthz` | `{"ok":true}` |
| 2 | LINE console → Verify | สำเร็จ (200) |
| 3 | ส่ง POST ไป `/line/webhook` โดยไม่มีลายเซ็น | 401 และไม่มีแถวใหม่ใน WebhookInbox |
| 4 | เพิ่มเพื่อน OA ด้วยบัญชีทดสอบ | ได้ลิงก์เชื่อมบัญชีในแชต |
| 5 | เปิดลิงก์ → เข้าสู่ระบบ → ยืนยันที่ LINE | หน้า "การแจ้งเตือน" แสดง "เชื่อม LINE แล้ว" |
| 6 | ใส่ LINE user ID ทดสอบใน `CWK_NOTIFY_ALLOWLIST` แล้วยืนยันขาดของนักเรียนทดสอบ | ได้ข้อความ LINE + ปุ่มรับทราบ; กดแล้วสถานะรับทราบเปลี่ยนในระบบ |
| 7 | ปิด GAS ชั่วคราว (เช่น ตั้ง `CWK_LINE_ENABLED=false`) แล้วส่งข้อความหา OA | gateway ตอบ 503; เปิดกลับแล้ว LINE ส่งซ้ำและระบบบันทึกครั้งเดียว |
| 8 | GAS เรียก identity verify ด้วย token จริง (ล็อกอินเว็บ) | เข้าสู่ระบบได้; ระงับผู้ใช้ใน Firebase แล้ว token เดิมถูกปฏิเสธภายในเวลาที่ cache กำหนด (≤ 300 วินาที) |
| 9 | ตรวจ log ของ Cloud Run | ไม่มี token, ลายเซ็น, ข้อความผู้ปกครอง หรือ LINE user ID |
| 10 | ตรวจว่าโรงเรียนเรียก `/exec` จาก gateway ได้ตามนโยบาย Workspace | ได้ `{"ok":true,"stored":true}`; ถ้าไม่ได้ บันทึกข้อจำกัดและเลือกช่องทางตามข้อ 8 |
