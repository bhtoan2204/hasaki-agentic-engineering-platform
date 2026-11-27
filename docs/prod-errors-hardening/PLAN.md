# Kế hoạch hardening luồng scan Production Errors và severity

> **Trạng thái:** Bản kế hoạch, **chưa sửa code**. Chờ duyệt và chốt các Open Questions ở §9. Tiến độ ghi ở [`PROGRESS.md`](./PROGRESS.md).
> Nguồn: báo cáo audit "luồng scan Production Errors và logic severity" (Node + Go). Các số dòng dưới đây tính tại thời điểm audit (`main` ở commit `228b7a6` cộng thay đổi Phase 3 của provider-compatibility chưa commit; các file này không bị đụng bởi thay đổi đó).

## 1. Mục tiêu và ngoài phạm vi

**Mục tiêu:** giảm bỏ sót và chấm sai trong scan production errors mà vẫn bảo toàn lịch sử (fingerprint, `prod_error_groups`, `shared_analyses`).

**Ngoài phạm vi (cố ý):**

- Không đưa LLM/AI vào vòng scan hay tính severity. AI triage hậu kỳ nằm ngoài kế hoạch này.
- Không gộp nhóm Splunk với nhóm SigNoz của cùng một sự cố (khóa gộp hai nguồn gần như không bao giờ trùng, audit §3.12). Chỉ ghi nhận hạn chế; không đổi trong kế hoạch này.
- Không đổi chính sách intake (`src/workitems/intake.ts`); nó chỉ đọc `severity`.
- Không đổi luồng điều tra (`src/incidents/*`).

## 2. Nguyên tắc bắt buộc

| #   | Nguyên tắc                                                                                                                                                       | Hệ quả                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| P-1 | **Phase 1 và 2 không đổi công thức `fingerprint`** (`scan.ts:185-186`, `merge.go:47-50`) và không đổi `signature` sinh ra                                        | Lịch sử, `incident_investigations`, `shared_analyses.error_key` (`src/sharing/key.ts:75-78`) giữ nguyên     |
| P-2 | **Node ↔ Go đồng bộ 100%**: mọi thay đổi `assess`, `ToGroups`, `MergeSourceRows`, SQL publish đổi cả hai bên trong cùng một commit                               | Golden `go/internal/proderrors/testdata/golden.json` tái sinh bằng `--write`, cộng vector dùng chung (§7.1) |
| P-3 | Mỗi thay đổi hành vi phải sau **flag** hoặc có đường lùi rõ ràng; flag tắt thì kết quả y hệt trước                                                               | Xem §8                                                                                                      |
| P-4 | **TDD**: viết test đỏ trước khi sửa, ghi vào `PROGRESS.md`                                                                                                       | Bảng test §7                                                                                                |
| P-5 | Migration chỉ tiến, có checksum (`migrations/`, số tiếp theo là **114**); `RequiredSchemaVersion` của Go (`store.go:17`) tăng theo mỗi migration mà Go phụ thuộc | Go từ chối chạy nếu schema cũ                                                                               |
| P-6 | Một nguồn sự thật cho cấu hình ngưỡng: **TS** (`config.prodErrors`), Go nhận qua op `sources` của gateway (`gateway.ts:190-198`)                                 | Không có cấu hình ngưỡng thứ hai trong Go                                                                   |
| P-7 | Không phá `src/sharing/*`; `arch:check` không tăng (≤ 5 cycles, ≤ 5 violations)                                                                                  | Chạy sau mỗi bước                                                                                           |
| P-8 | Nhóm mới/quay lại do thay đổi quy tắc không được gây "bão" cảnh báo                                                                                              | Khởi động im lặng, §6.1                                                                                     |

## 3. Bản đồ phụ thuộc giữa các Phase

```
Phase 1 (độc lập, an toàn) ──► Phase 2 (dựa trên partial/truncated để Radar không coi "vắng mặt" là 0)
                         └────► Phase 3 (tùy chọn; chỉ làm sau khi 1–2 ổn định ≥ 1 tuần trên production)
```

Phase 1 và 2 có thể phát hành riêng. Phase 3 là cutover riêng và cần quyết định của bạn (Q-9).

---

## 4. Phase 1 — An toàn, không đổi fingerprint

### 4.1 Scan `partial`: không làm mất nhóm của nguồn lỗi

**Vấn đề (audit §3.4):** Splunk lỗi, SigNoz OK thì scan `ok=true` (`scan.go:234-239`). `listGroups` chỉ hiện nhóm của `last_scan_id` thuộc scan OK mới nhất (`scan.ts:803-805`), nên nhóm Splunk biến mất khỏi trang; panic trong log không còn được thấy.

**Thiết kế:**

- **Giữ `ok=true` và `status='succeeded'`** cho scan có ít nhất một nguồn thành công. Radar (`radar/scan.ts:107,128,155`), `listGroups` và `runScan` đều lọc theo `ok`/`succeeded`; đổi ý nghĩa của hai cột này làm vỡ chúng.
- Thêm trạng thái qua **cột mới** (migration 114):
  - `prod_error_scans.partial boolean NOT NULL DEFAULT false`
  - `prod_error_scans.sources jsonb NOT NULL DEFAULT '{}'`, dạng `{ "splunk": {"status":"ok|failed|skipped","error":"…","truncated":bool,"rows":n}, "signoz": {…} }`
- Go `collectAndPublish` điền `sources` và `partial` trong transaction publish (`store.go:102-129`); `finish` giữ nguyên.
- `listGroups` (**carry-over**): khi scan OK mới nhất có `partial` và nguồn X lỗi, hiển thị thêm các nhóm có `detail.sources` chứa X từ **scan OK đầy đủ gần nhất** (`partial=false`), gắn nhãn `stale_source: "splunk"` và tuổi dữ liệu. Chỉ đọc; không ghi đè.
- Nhóm carry-over **không** được tính cho thông báo "mới" và không được chấm lại.
- UI: banner "Quét chưa đầy đủ: Splunk lỗi (…); đang hiển thị dữ liệu của lần quét lúc …" ở `web/src/pages/prodErrors/ProductionOverview.tsx` / `ProductionErrorsPage.tsx`, i18n vi/en.
- Radar: `seriesCoverage` thêm `partial`/`truncated`; một scan `partial` hoặc `truncated` **không** chứng minh "vắng mặt = 0" (xem 5.2).

**File:** `migrations/114_prod_errors_hardening.sql`; `go/internal/proderrors/{scan.go,store.go}`; `src/prodErrors/{scan.ts,gateway.ts,jobs.ts}`; `go/contracts/prod-errors-v1.schema.json`; `web/src/pages/prodErrors/*`; `shared/i18n/catalog/*`; `src/radar/scan.ts`.

### 4.2 SPL: panic không bị cắt, `truncated`, thêm level và log text thuần

Mọi thay đổi SPL giữ nguyên `sig` (chuỗi chuẩn hóa `scan.ts:123`) nên fingerprint không đổi cho nhóm đã có.

**(a) Bảo toàn crash trước `head 300`** (`scan.ts:127-130`)

- Thêm `is_crash` vào `stats` (`max(eval(if(match(...),1,0)))`) dùng đúng định nghĩa CRASH sau khi siết (§4.3), rồi `sort - is_crash - today | head 301`.
- Nếu số nhóm crash > 300 thì `truncated=true` và ghi chú; không bao giờ cắt crash để giữ nhóm thường.

**(b) `truncated` qua gateway** (`gateway.ts:199-221`, `splunk.ts:834`)

- Gateway yêu cầu 301 dòng; nếu nhận 301 thì cắt về 300 và `truncated: true`.
- Schema `SplunkResponse` (`prod-errors-v1.schema.json:68-75`) thêm `truncated: boolean` và `partial_reasons: string[]` (message auto-finalize/`max_time` của Splunk); `SignozErrorsResponse` thêm `truncated`. Go decode và ghi vào `prod_error_scans.sources` (§4.1).
- Truncated không làm scan lỗi; nó là cờ hiển thị và là đầu vào cho Radar.

**(c) Hỗ trợ field level khác** (`scan.ts:120-121`)

- `lv=upper(coalesce(level,LEVEL,severity,lvl,'log.level'))`; tên trường có dấu chấm cần dấu nháy đơn trong SPL.
- Chỉ giữ tập level hiện tại (`LEVELS`, `scan.ts:99`); `WARN` vẫn không vào.

**(d) Log text thuần**

- Khi `lv` rỗng sau `spath`, dùng `rex field=log`/`_raw` bắt level ở đầu dòng hoặc sau timestamp: `(?i)^\\S*\\s*\\[?(ERROR|FATAL|PANIC|CRITICAL)\\b`. Chỉ xét ~120 ký tự đầu để tránh khớp nhầm trong thân message.
- `msg` của dòng text là cả dòng (đã chuẩn hóa bởi `sig`). Các nhóm này **chưa từng tồn tại** nên có fingerprint mới. Hệ quả: lần quét đầu sau khi bật sẽ sinh nhiều nhóm `new`; xem **khởi động im lặng** §6.1.

**Flag:** `PROD_ERRORS_EXTRA_LEVELS` (field level + text thuần), mặc định **tắt**; (a) và (b) luôn bật (chỉ làm tăng độ phủ/độ đúng, không tạo nhóm mới).

**File:** `src/prodErrors/scan.ts` (`buildScanSpl`), `gateway.ts`, `go/internal/proderrors/scan.go` (struct response), schema JSON, `config.ts`.

### 4.3 Siết regex `CRASH` và `MONEY`

**Ràng buộc kỹ thuật:** Go dùng RE2, **không có lookahead/lookbehind**; TS dùng được nhưng phải giữ hai bên tương đương. Cả hai dùng cấu trúc "khớp mẫu dương **và không** khớp mẫu loại trừ" (2 regex), không dùng lookaround.

**CRASH** (`scan.ts:136-137`, `merge.go:96`):

| Mẫu dương                                                              | Loại trừ (không tính là crash)                                                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `^panic:`/`\\bpanic:`, `goroutine \\d+ \\[`, `fatal error:`            | `recover(ed                                                                                                                                               | y)\\b.*panic`, `panic.*recover(ed | y)`                                                                               |
| `nil pointer dereference`/`invalid memory address`                     | như trên (chỉ khi cùng dòng với "recovered")                                                                                                              |
| `all goroutines are asleep - deadlock`                                 | `deadlock found when trying to get lock`, `try restarting transaction`, `ER_LOCK_DEADLOCK`, `sqlstate 40001`, `40P01`, `deadlock detected` (DB retryable) |
| `OutOfMemoryError`, `oomkilled`, `fatal error: runtime: out of memory` |                                                                                                                                                           |
| `index out of range`                                                   | `recovered` như trên                                                                                                                                      |
| Level `FATAL                                                           | PANIC                                                                                                                                                     | DPANIC                            | CRITICAL` vẫn luôn là crash (`scan.ts:153`), **không** bị các loại trừ trên chặn. |

**MONEY** (`scan.ts:134-135`, `merge.go:95`): bỏ từ đơn dễ khớp nhầm:

- `duplicate`, `double`, `callback`, `amount`, `charge`, `capture`, `settle` chỉ tính khi đi kèm ngữ cảnh tiền (`payment|order|transaction|wallet|refund|thanh toán|đơn hàng|zalopay|momo|vnpay`) **hoặc** thuộc cụm cố định: `duplicate (payment|transaction|order|charge|refund|callback)`, `double (charge|refund|payment|spend)`, `amount (mismatch|not match|invalid)`.
- Giữ nguyên các cụm đặc thù: `refund`, `hoàn tiền`, `reconcil*`, `sign(ature)? not match`, `invalid sign`, `checksum`, `\\bipn\\b`, `\\bcod\\b`, `webhook` (kèm ngữ cảnh).
- Nhãn `reasons` (`panic`, `money`) giữ nguyên để UI/Telegram không đổi.

**Hệ quả cần biết:** severity của nhóm hiện có có thể **giảm** ở lần quét sau khi triển khai. Điều này không phát sinh thông báo (chỉ tăng bậc mới báo, §4.4).

**Vector dùng chung:** `go/internal/proderrors/testdata/classify-vectors.json` (chuỗi → `crash`/`money` kỳ vọng); test TS và test Go cùng đọc file này (P-2).

**File:** `src/prodErrors/scan.ts`, `go/internal/proderrors/merge.go`, vector JSON, `test/prod-errors-golden.test.ts`, `go/internal/proderrors/merge_test.go`.

### 4.4 `notifyNew` chống spam, và đánh thức `ignored`

**Vấn đề (audit §3.18, §3.7):** `notifyNew` chọn mọi nhóm mở `critical/high` chưa có work item mà `notified_day IS DISTINCT FROM day` (`scan.ts:683-684`), nên lỗi mãn tính được báo lại mỗi ngày. `ignored` vĩnh viễn (`scan.ts:919-927`).

**Thông báo:**

- Thêm `prod_error_groups.notified_severity text`, `notified_at timestamptz` (migration 114). Backfill: `notified_severity = severity` cho hàng có `notified_day IS NOT NULL` để không có bão khi triển khai.
- Chọn nhóm mở `high|critical`, chưa có work item, và `notified_severity IS NULL` **hoặc** `rank(severity) > rank(notified_severity)`. Cập nhật cả `notified_severity`, `notified_at` và `notified_day` (giữ cột cũ cho tương thích).
- Tin nhắn phân biệt "🆕 mới" và "⬆️ tăng bậc (high → critical)" (`buildAlertMessage`, `scan.ts:621-654`).
- Nhắc lại lỗi mãn tính: `config.prodErrors.renotifyDays` (mặc định **0 = tắt**, Q-4).
- Scan `partial` không báo nhóm carry-over (§4.1).

**`ignored` có TTL và tự đánh thức:**

- `prod_error_groups.ignored_until timestamptz`, `ignored_at timestamptz`, `ignored_rate numeric` (sự kiện/giờ tại lúc ignore) — migration 114.
- `setIgnored(fp, true, { days })` đặt `ignored_until = now() + TTL` (mặc định theo Q-3) và `ignored_rate` lấy từ observation mới nhất.
- Bước **`reopenIgnored`** trong `finalizeScan` (TS, `scan.ts:592-602`; Go gọi qua op `finalize`, **Go không cần biết**): mở lại khi (i) `ignored_until < now()`, hoặc (ii) nhóm xuất hiện trong scan vừa xong với `rate ≥ max(wakeMinRate, wakeRatio × ignored_rate)` và `today ≥ wakeMinCount` (số cụ thể: Q-3).
- **Reset thông báo khi mở lại:** `reopenIgnored` đồng thời đặt `notified_severity = NULL` (và `notified_at = NULL`) để nhóm vừa mở lại mà vẫn `high`/`critical` được `notifyNew` báo lại, không bị điều kiện `rank(severity) > rank(notified_severity)` chặn.
- Mở lại ghi `audit()` (`prod_errors.group.auto_reopen`) và **không** ghi `prod_error_lifecycle_events.action='reopen'`: Radar dùng sự kiện đó để dựng "recurring_incident" (`radar/detect.ts:247`, `radar/scan.ts:152`); trộn tự động và thủ công làm sai tín hiệu (Q-8).
- `publishGroups`/`upsertGroups` **không** chạm cột `ignored_*` (`ON CONFLICT` ở `scan.ts:569-573`, `store.go:140-144` giữ nguyên danh sách cột) nên Go không cần đổi SQL.

**File:** migration 114; `src/prodErrors/scan.ts` (`notifyNew`, `setIgnored`, `finalizeScan`, `buildAlertMessage`); `src/api/routes/observability.ts:289-291` (nhận `days`); `web/src/pages/prodErrors/*` (nút ignore có TTL); i18n.

### 4.5 Phase 1: danh sách file và migration

| Loại      | File                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration | `migrations/114_prod_errors_hardening.sql` (cột `partial`, `sources` ở scans; `notified_severity`, `notified_at`, `ignored_until`, `ignored_at`, `ignored_rate` ở groups; backfill `notified_severity`) |
| Node      | `src/prodErrors/{scan.ts,gateway.ts,jobs.ts}`, `src/api/routes/observability.ts`, `src/radar/scan.ts`, `src/config.ts`                                                                                  |
| Go        | `go/internal/proderrors/{scan.go,merge.go,store.go}` (`RequiredSchemaVersion = 114`), `go/contracts/prod-errors-v1.schema.json`                                                                         |
| Web       | `web/src/pages/prodErrors/{ProductionOverview,ProductionErrorsPage}.tsx`, `shared/i18n/catalog/*`                                                                                                       |
| Test      | §7                                                                                                                                                                                                      |

---

## 5. Phase 2 — Chuẩn hóa severity, Radar và SigNoz

### 5.1 Ngưỡng theo tốc độ/giờ (`window_hours`), `first_seen_at` cho `new`, bậc cho lỗi mãn tính

**Đầu vào mới của `assess`** (cả TS `assess` `scan.ts:140` và Go `assess` `merge.go:103`):

- `windowHours = (end - start) / 3600` lấy từ request của scan (`jobs.ts:21-32`, `store.go:23-32`).
- `baselineHours` tương ứng (`window.ts:77-78`).
- `firstSeenAt` của fingerprint (hàng cũ trong `prod_error_groups`, nếu có).
- Ngưỡng từ cấu hình TS qua op `sources` (P-6); schema `SourcesResponse` (`prod-errors-v1.schema.json:34-49`) thêm `thresholds`.

**Công thức đề xuất** (số cụ thể cần bạn chốt ở Q-1; giá trị dưới là mặc định đề xuất):

```
rate      = today / max(windowHours, minWindowHours)           // minWindowHours = 1
baseRate  = yesterday / max(baselineHours, minWindowHours)
many      : rate >= heavyRate (40/h  ≈ 1000/ngày)  → s >= 2     // thay today>=1000 (scan.ts:151)
chronic   : không new, rate >= chronicHigh (200/h) → s >= 3     // lỗi mãn tính volume cao (audit §3.5)
spike     : rate >= spikeRatio (3) × baseRate  VÀ  rate >= spikeMinRate (6/h)  → s >= 3   // thay today>=50 & 3×
new       : yesterday == 0 VÀ (không có hàng trong 7 ngày trước, tức first_seen_at gần) VÀ today >= minNewCount (5)
returned  : yesterday == 0 VÀ first_seen_at cũ  → lý do "returned", s <= 2 (không bao giờ vượt medium nếu không crash/money)
```

- Cửa sổ < `minWindowHours` (ví dụ 00:30): vẫn chấm theo `rate` (chia cho 1h), nhưng `new`/`spike` bị **chặn ở medium** nếu `today < minSampleCount` (Q-2). Crash vẫn `critical` bất kể cửa sổ.
- `first_seen_at`: Go nạp `first_seen_at` của các fingerprint trong scan bằng **một** truy vấn trước `ToGroups` và truyền vào `ToGroups(rows, day, ctx)`; TS tương ứng `toGroups(rows, day, ctx)`. `ctx` chứa `{windowHours, baselineHours, known: Map<fp, Date>, thresholds}`. Đây là thay đổi chữ ký có chủ ý, đi kèm golden mới.
- `reasons` cũ (`new`, `up|r|y`, `down|y`, `many|n`, `panic`, `money`) giữ nguyên định dạng; thêm `returned`, `chronic|rate`. Telegram/UI đã lọc theo tiền tố, kiểm lại `buildAlertMessage` (`scan.ts:630`) với lý do mới.
- Flag `PROD_ERRORS_SEVERITY_V2` mặc định **tắt** cho tới khi chạy song song (shadow): scan ghi `severity_v2` vào `detail` (không đổi `severity`) để so sánh hai công thức trên dữ liệu thật trước khi chuyển.

### 5.2 Một nguồn sự thật cho CRASH/MONEY/severity; Radar điền giờ 0

**Hợp nhất:**

- Tạo `src/prodErrors/severity.ts` (thuần): `CRASH`, `MONEY`, `classifyText()`, `assess()`. `scan.ts` import từ đây; `src/radar/detect.ts` bỏ `severityOf`/`MONEY` riêng (`detect.ts:102-112`) và dùng `classifyText` + hàm ánh xạ tỷ lệ → bậc dùng chung. Radar **giữ** ngưỡng thống kê (`DEFAULT_THRESHOLDS`, `detect.ts:36-44`); chỉ phân loại nội dung và bảng bậc được dùng chung.
- Go: `go/internal/proderrors/severity.go` là bản port; vector chung `testdata/severity-vectors.json` do **cả hai** test đọc, nên lệch sẽ làm CI đỏ.
- Mục tiêu: cùng một chữ ký không thể `low` ở trang lỗi mà `high` ở Radar chỉ vì khác regex (audit §3.19).

**Radar điền giờ 0** (`radar/scan.ts:153-181`, `detect.ts:57`):

- Nay chuỗi chỉ có giờ có sự kiện nên median/MAD thiên cao với chuỗi thưa.
- Điền `0` cho mọi giờ **được bao phủ đầy đủ** bởi một scan OK, **không** `partial`, **không** `truncated` và có khung giờ chứa nhóm đó (nếu scan bị cắt, vắng mặt ≠ 0; phụ thuộc §4.1/§4.2).
- `ErrorSeries` thêm `coveredHours` hoặc điền sẵn `points`; `detectSeries` giữ chữ ký.

### 5.3 SigNoz: giảm đếm trùng, mẫu trace khớp, rà mapping namespace

**(a) Đếm trùng và 4xx kỳ vọng** (`signoz.ts:1081-1089`, `1105-1135`)

- Thay `count()` theo mọi span `has_error=true` bằng `count_distinct(trace_id)` trên span lỗi; nếu truy vấn `query_range v5` không hỗ trợ trên bản SigNoz đang chạy thì dự phòng: `has_error = true AND (parent_span_id = '' OR kind = SERVER)`. **Cần kiểm chứng trên SigNoz thật** (Q-10, mục manual verify).
- Loại mã trạng thái kỳ vọng theo cấu hình `config.prodErrors.signoz.ignoreStatusCodes` (mặc định **400, 404, 409, 422**; không có 429 — Q-5 đã chốt), áp ở cả cửa sổ và baseline để so sánh công bằng.
- Phương pháp đếm giống nhau cho cửa sổ và baseline. **Không** đổi nhóm/khóa (ns, service, name, status, code) nên fingerprint không đổi; đếm thay đổi nên severity có thể đổi.

**(b) Mẫu trace khớp `status_message`** (`scan.ts:359-373`)

- Truy vấn mẫu lấy thêm `status_message`, `response_status_code`; khớp bằng đúng khóa nhóm (`signozRows.keyOf`, `scan.ts:317-322`) thay vì chỉ `service+name`.

**(c) Mapping namespace** (`signoz.ts:1081-1089`, `config.ts:803`)

- Thêm bước kiểm tra trước scan (trong op `signoz-errors`): so các giá trị của `namespaceKey` thấy trong baseline với `config.prodErrors.namespaces`; không khớp thì thêm ghi chú rõ ràng ("SigNoz: giá trị `deployment.environment` … không khớp namespace cấu hình") và đánh dấu nguồn `sources.signoz.status="degraded"`.
- **Chỉ cảnh báo, không remap giá trị.** `namespace` nằm trong fingerprint (`scan.ts:185`); remap sẽ đổi fingerprint của nhóm SigNoz. Việc remap thuộc cutover Phase 3 (Q-11).

### 5.4 Phase 2: danh sách file và migration

| Loại      | File                                                                                                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration | `115_prod_errors_severity_v2.sql` (tùy chọn): `prod_error_observations.window_hours numeric` để tái dựng tốc độ trong phân tích; không bắt buộc nếu `window` suy ra từ `prod_error_scans.window_start/end` |
| Node      | `src/prodErrors/{severity.ts(mới),scan.ts,gateway.ts,window.ts}`, `src/radar/{detect.ts,scan.ts}`, `src/integrations/signoz.ts`, `src/config.ts`                                                           |
| Go        | `go/internal/proderrors/{severity.go(mới),merge.go,scan.go,store.go}`, schema (`SourcesResponse.thresholds`), `testdata/{golden.json,severity-vectors.json}`                                               |
| Web       | hiển thị lý do mới (`returned`, `chronic`)                                                                                                                                                                 |

---

## 6. Phase 3 — Tùy chọn: thu hẹp `<n>` (cutover riêng)

**Không làm cho tới khi Q-9 được chốt.** Phase 3 là thay đổi duy nhất đổi fingerprint nên có quy trình riêng.

### 6.1 Thu hẹp chuẩn hóa chữ ký (`norm_version = 2`)

Hiện mọi token có chữ số thành `<n>` (`scan.ts:123,253`): gộp `[500]` và `[502]`, `s3`/`oms-v2`/`utf8` (audit §3.11).

Quy tắc v2 (định nghĩa **một lần** dưới dạng bảng quy tắc `NORMALIZE_RULES`, sinh ra cả `signatureOf` lẫn chuỗi `replace()` của SPL):

1. uuid, hex ≥ 16 ký tự, `0x…`, IPv4/IPv6, timestamp ISO → thay thế như cũ.
2. Số thuần → `<n>`, **trừ** số 100–599 đứng sau `status`, `code`, `http`, `[` (giữ mã HTTP để 500 ≠ 502).
3. Token trộn chữ+số **ngắn** (≤ 4 ký tự: `s3`, `v2`, `utf8`) giữ nguyên; chuỗi trộn dài ≥ 8 ký tự (id, token) → `<id>`.
4. Độ dài cắt: 400 trước, 200 sau (giữ).

**Parity TS ↔ SPL:** SPL không chạy được trong CI, nên:

- Bảng quy tắc là nguồn duy nhất; test đẩy vector qua cả hai biểu diễn (một bộ thông dịch nhỏ chạy chuỗi `replace()` được sinh cho SPL) và so với `signatureOf`.
- Live check tùy chọn `test/prod-errors-spl.live.ts` chạy `| makeresults` với vector trên Splunk thật (chạy tay khi có phiên).
- Go **không** bị ảnh hưởng (chữ ký đến Go dưới dạng đã chuẩn hóa).

### 6.2 Cutover tránh bão `new` và bảo toàn `shared_analyses`

Chữ ký đổi nên fingerprint đổi. Phương án (flag `PROD_ERRORS_NORMALIZE_V2`, mặc định tắt):

1. **Bảng alias** (migration 116): `prod_error_fingerprint_alias(old_fp, new_fp, norm_version, created_at, PRIMARY KEY(old_fp,new_fp))`; `prod_error_groups.norm_version smallint NOT NULL DEFAULT 1`.
2. **Dual compute:** scan chuyển tiếp tính cả `fp_v1` và `fp_v2` cho mỗi nhóm; ghi nhóm v2 kèm alias tới v1 tương ứng.
3. **Kế thừa trạng thái:** nhóm v2 thừa kế `status`, `ignored_*`, `work_item_id`, `notified_severity`, `first_seen_at` từ nhóm v1 có số lượng lớn nhất (tách một thành nhiều: mỗi nhóm v2 thừa kế từ cùng một v1; gộp nhiều thành một: lấy v1 có `today_count` lớn nhất).
4. **Không báo `new` cho nhóm đã có alias** (coi như đã biết, `first_seen_at` thừa kế); chạy **quét thủ công im lặng** trước khi bật lịch (quét thủ công không bao giờ gửi Telegram, `scan.ts:598`).
5. **`shared_analyses` (`src/sharing/*` không đổi trong kế hoạch này):** `error_key` = fingerprint nên kết quả cũ sẽ miss. Mặc định: **chấp nhận miss** (sẽ chạy lại phân tích). Tùy chọn (cần review riêng): resolver alias read-only nhãn "chữ ký đã đổi". (Q-9)
6. **Radar:** chuỗi theo fingerprint v1 cần được nối với v2 qua alias để không mất baseline; nếu không, ba ngày đầu `new_signature` bị kích hoạt giả. Gộp theo alias trong `loadErrorSeries`.
7. **Phân tích/lịch sử** (`src/eval/analytics.ts`, `getIncidentDetail` `scan.ts:852-907`): drilldown theo fingerprint cần đọc cả alias.
8. **Rollback:** tắt flag; nhóm v1 vẫn còn nguyên (không xóa); dữ liệu v2 chỉ thêm.

---

## 7. Kiểm thử (TDD, red trước green)

### 7.1 Quy trình đồng bộ Node ↔ Go

- Golden hiện có: `test/prod-errors-golden.test.ts` + `test/fixtures/prodErrorsGolden.ts` ↔ `go/internal/proderrors/testdata/golden.json`; tái sinh: `node --import ./test/env.ts test/fixtures/prodErrorsGolden.ts --write` và Go `TestGolden` (`merge_test.go:12`).
- Thêm **vector dùng chung** đọc bởi cả hai bên: `classify-vectors.json` (P1), `severity-vectors.json` (P2), `normalize-vectors.json` (P3).
- Mỗi commit đổi `assess`/`ToGroups`/`MergeSourceRows`/SQL publish phải đổi cả TS và Go, và golden cùng commit.

### 7.2 Danh sách test

| #   | Phase | Test                                                                                                                                                   | Mức                                                 | Đỏ trước khi sửa vì                         |
| --- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------- |
| T1  | 1     | **Log text thuần** `2026-11-27 10:00:01 ERROR order failed id=123` (không phải JSON) được SPL/giả lập bắt; ngoài ra dòng `WARN` không                  | unit (`buildScanSpl` + hàm tham chiếu `levelOf`)    | hiện bị loại ở `scan.ts:121`                |
| T2  | 1     | Trường `severity`/`lvl`/`log.level` được nhận                                                                                                          | unit                                                | chỉ `level`/`LEVEL` (`scan.ts:120`)         |
| T3  | 1     | **>300 nhóm có panic:** 400 nhóm thường + 1 panic (count 1) → panic còn trong 300, `truncated=true`                                                    | unit trên hàm cắt + gateway                         | cắt theo `today` (`scan.ts:129`)            |
| T4  | 1     | `truncated` đi qua gateway → schema → Go → `sources`                                                                                                   | integration `prod-errors-go.integration.ts`         | field không tồn tại                         |
| T5  | 1     | **Partial scan:** Splunk lỗi, SigNoz OK → scan `ok=true`, `partial=true`; `listGroups` vẫn trả nhóm Splunk từ scan đầy đủ trước, nhãn `stale_source`   | integration `prodErrors.integration.ts`             | nhóm biến mất (`scan.ts:803`)               |
| T6  | 1     | Carry-over không kích hoạt thông báo "mới" và không bị chấm lại                                                                                        | integration                                         | —                                           |
| T7  | 1     | **MySQL deadlock** `Deadlock found when trying to get lock; try restarting transaction` mức ERROR → không `panic`, severity không critical             | vector + golden                                     | khớp `deadlock` (`scan.ts:136`)             |
| T8  | 1     | **Recovered panic** `recovered from panic: nil pointer` mức ERROR → không critical; cùng chuỗi mức PANIC/FATAL → vẫn critical                          | vector + golden                                     | khớp `panic`                                |
| T9  | 1     | `duplicate key`, `double click`, `callback timeout` (không ngữ cảnh) → không `money`; `duplicate payment`, `double charge`, `sign not match` → `money` | vector + golden                                     | từ đơn                                      |
| T10 | 1     | **Notify không lặp theo ngày:** nhóm critical chạy 3 ngày liên tiếp → báo 1 lần; tăng high→critical → báo lại                                          | integration                                         | `notified_day` đổi mỗi ngày (`scan.ts:684`) |
| T11 | 1     | Backfill migration không gây bão báo sau triển khai                                                                                                    | migration test                                      | —                                           |
| T12 | 1     | `ignored` hết `ignored_until` → mở lại; spike ≥ ngưỡng wake → mở lại; dưới ngưỡng → giữ ignored; không ghi `lifecycle reopen`                          | integration                                         | không có cơ chế                             |
| T13 | 1     | Flag `PROD_ERRORS_EXTRA_LEVELS` tắt → SPL và kết quả y hệt cũ (so chuỗi SPL)                                                                           | unit                                                | —                                           |
| T14 | 2     | **Cửa sổ 00:30:** 30 phút, `today=8`, `yesterday=0` → không `high`; có panic → vẫn critical                                                            | vector + golden                                     | `today>=5 → 3` (`scan.ts:162`)              |
| T15 | 2     | Cùng tốc độ/giờ cho cửa sổ 1h, 4h, 24h cho cùng severity                                                                                               | vector + golden                                     | ngưỡng tuyệt đối (`scan.ts:151,164`)        |
| T16 | 2     | **Mãn tính volume cao:** 999 vs 1000 hôm qua, rate ≥ `chronicHigh` → `chronic`, `high`                                                                 | vector + golden                                     | `low` (`scan.ts:151`)                       |
| T17 | 2     | `new` dùng `first_seen_at`: hàng cũ + `yesterday=0` → `returned` ≤ medium; hàng chưa có → `new`                                                        | golden (có `known`)                                 | `yesterday==0` (`scan.ts:160`)              |
| T18 | 2     | **Radar giờ 0:** chuỗi thưa (1 sự kiện/giờ lẻ) rồi spike → phát hiện `error_spike`; chuỗi từ scan `truncated` không điền 0                             | unit `radar-detect` + integration `loadErrorSeries` | median thiên cao (`radar/scan.ts:153-181`)  |
| T19 | 2     | `severity` scan ≡ `classifyText` Radar trên vector chung (MONEY/CRASH)                                                                                 | unit + Go                                           | hai regex khác nhau                         |
| T20 | 2     | SigNoz: một request lỗi đi qua 3 span lỗi → đếm 1; 4xx kỳ vọng không đếm; baseline cùng phương pháp                                                    | unit `prod-errors-signoz.test.ts`                   | `count()` (`signoz.ts:1107`)                |
| T21 | 2     | SigNoz: hai nhóm cùng `service+name` khác `status_message` → mẫu trace gắn đúng nhóm                                                                   | unit                                                | gắn nhóm đầu tiên (`scan.ts:359`)           |
| T22 | 2     | Namespace SigNoz không khớp cấu hình → ghi chú + `degraded`, **fingerprint không đổi**                                                                 | unit                                                | —                                           |
| T23 | 3     | Vector chuẩn hóa v2: `[500]` ≠ `[502]`, `s3` giữ, uuid/hex/IP → thay; bảng quy tắc ≡ chuỗi SPL sinh ra                                                 | unit                                                | `<n>` rộng                                  |
| T24 | 3     | Cutover: alias được ghi, trạng thái thừa kế, **không** báo `new`, `shared_analyses` miss có chủ ý                                                      | integration                                         | —                                           |
| T25 | all   | Flag tắt ⇒ golden và SPL y hệt trước (hồi quy)                                                                                                         | golden                                              | —                                           |

---

## 8. Triển khai, flag và đường lùi

| Flag                                             | Phase | Mặc định                        | Tắt thì                                    |
| ------------------------------------------------ | ----- | ------------------------------- | ------------------------------------------ |
| (không flag) partial/`truncated`/panic-trước-cắt | 1     | bật                             | cột mới bị bỏ qua; SPL chỉ thêm `is_crash` |
| `PROD_ERRORS_EXTRA_LEVELS`                       | 1     | tắt                             | SPL y hệt cũ                               |
| `PROD_ERRORS_NOTIFY_ON_ESCALATION`               | 1     | bật sau backfill                | quay lại `notified_day`                    |
| `PROD_ERRORS_IGNORE_TTL`                         | 1     | bật                             | ignore vĩnh viễn như cũ                    |
| `PROD_ERRORS_SEVERITY_V2`                        | 2     | tắt (shadow)                    | công thức cũ                               |
| `PROD_ERRORS_SIGNOZ_DISTINCT`                    | 2     | tắt cho tới khi live check xong | `count()` cũ                               |
| `PROD_ERRORS_NORMALIZE_V2`                       | 3     | tắt                             | chuẩn hóa cũ                               |

Thứ tự: merge Phase 1 → chạy quét thủ công im lặng → bật `EXTRA_LEVELS` → quan sát 3 ngày → Phase 2 shadow → so `severity_v2` với `severity` → bật → (tùy chọn) Phase 3.

## 9. Open Questions — ĐÃ CHỐT

> Kế hoạch đã được duyệt. Quyết định cuối cùng (khác đề xuất ở Q-5 và Q-9, còn lại giữ đề xuất):

| #    | Quyết định                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q-1  | `heavyRate = 40/h`, `chronicHigh = 200/h`, `spikeRatio = 3`, `spikeMinRate = 6/h`, `minNewCount = 5`; cấu hình ở TS `config.prodErrors` (áp dụng từ Phase 2) |
| Q-2  | `minWindowHours = 1`, `minSampleCount = 20` (Phase 2)                                                                                                        |
| Q-3  | TTL `ignored` = **14 ngày**; đánh thức khi `rate >= max(20/h, 5 × ignored_rate)` và `today >= 50`                                                            |
| Q-4  | Tắt nhắc lại `critical` mãn tính (`renotifyDays = 0`)                                                                                                        |
| Q-5  | **Điều chỉnh:** loại mặc định `[400, 404, 409, 422]`, **không loại 429** (không bỏ sót lỗi rate-limit); **giữ** span `CLIENT` (Phase 2)                      |
| Q-6  | Khởi động `EXTRA_LEVELS` bằng **quét thủ công im lặng** trước                                                                                                |
| Q-7  | Carry-over khi `partial`: hiển thị nhóm của nguồn lỗi từ scan đầy đủ gần nhất, nhãn stale **và** banner UI                                                   |
| Q-8  | Auto-reopen **không** ghi `lifecycle 'reopen'`, chỉ `audit()`                                                                                                |
| Q-9  | **Chưa làm Phase 3 trong đợt này.** Nếu làm sau: chấp nhận miss `shared_analyses`                                                                            |
| Q-10 | Ưu tiên `count_distinct(trace_id)` nếu live check SigNoz đạt, giữ fallback span gốc/SERVER (Phase 2)                                                         |
| Q-11 | Remap namespace SigNoz đẩy sang Phase 3                                                                                                                      |
| Q-12 | Liên kết nhóm Splunk ↔ SigNoz ngoài phạm vi                                                                                                                  |

### Câu hỏi gốc (để tham chiếu)

| #    | Câu hỏi                                                                                              | Đề xuất mặc định                                                |
| ---- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Q-1  | Ngưỡng tốc độ/giờ: `heavyRate`, `chronicHigh`, `spikeRatio`, `spikeMinRate`, `minNewCount`?          | 40/h, 200/h, 3×, 6/h, 5 (suy từ ngưỡng hiện tại cho cửa sổ 24h) |
| Q-2  | Cửa sổ rất ngắn (< 1h): chặn `new`/`spike` ở medium nếu mẫu nhỏ? `minWindowHours`, `minSampleCount`? | 1h, 20                                                          |
| Q-3  | `ignored`: TTL mặc định và ngưỡng đánh thức (`wakeRatio`, `wakeMinRate`, `wakeMinCount`)?            | TTL 14 ngày; `rate ≥ max(20/h, 5×ignored_rate)` và `today ≥ 50` |
| Q-4  | Nhắc lại lỗi mãn tính `critical` chưa có work item: tắt, mỗi 3 ngày, hay digest hằng ngày?           | tắt                                                             |
| Q-5  | Danh sách mã HTTP kỳ vọng loại khỏi SigNoz; có loại span `CLIENT` không?                             | 400, 404, 409, 422, 429; giữ `CLIENT`                           |
| Q-6  | Bật `EXTRA_LEVELS`: khởi động im lặng (quét thủ công trước) hay chấp nhận một đợt `new`?             | im lặng                                                         |
| Q-7  | Carry-over khi `partial`: hiển thị nhóm cũ (nhãn stale) hay chỉ banner?                              | hiển thị + nhãn                                                 |
| Q-8  | Auto-reopen `ignored` có ghi `lifecycle 'reopen'` (ảnh hưởng Radar `recurring`) không?               | không, chỉ `audit`                                              |
| Q-9  | **Có làm Phase 3 không?** Nếu có, `shared_analyses` miss chấp nhận hay cần resolver alias?           | chưa làm; nếu làm thì chấp nhận miss                            |
| Q-10 | SigNoz đếm bằng `count_distinct(trace_id)` (cần kiểm chứng) hay span gốc/SERVER?                     | distinct nếu live check đạt                                     |
| Q-11 | Remap giá trị namespace SigNoz (`deployment.environment` → k8s namespace): đẩy sang Phase 3?         | đẩy sang Phase 3                                                |
| Q-12 | Nhóm Splunk và SigNoz của cùng sự cố: giữ ngoài phạm vi (nay) hay thêm một task liên kết riêng sau?  | ngoài phạm vi                                                   |

## 10. Rủi ro

| Rủi ro                                               | Giảm thiểu                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| Siết regex làm một số nhóm giảm severity             | Chấp nhận; chỉ tăng bậc mới báo; golden + vector ghi lại               |
| `EXTRA_LEVELS` tạo nhiều nhóm `new`                  | Q-6, quét im lặng, flag                                                |
| RE2 không có lookaround                              | Hai regex (dương + loại trừ); test vector chung                        |
| `sources`/`partial` thêm cột nên Go cũ ghi thiếu     | `RequiredSchemaVersion` 114; Go từ chối chạy schema cũ                 |
| `count_distinct` SigNoz không khả dụng               | Live check trước; có phương án dự phòng                                |
| Radar điền 0 khi scan bị cắt gây `new_signature` giả | Chỉ điền cho giờ được bao phủ đầy đủ, scan không `truncated`/`partial` |
| Auto-reopen làm nhiễu Radar                          | Không ghi `lifecycle reopen` (Q-8)                                     |
| Phase 3 đổi fingerprint                              | Cutover riêng, alias, quét im lặng, rollback bằng flag                 |

## 11. Định nghĩa hoàn thành (mỗi Phase)

`npm run typecheck`, `npm run lint`, `npx prettier --check .`, `npm run arch:check` (≤ 5 / ≤ 5), `npm test`, `go test ./go/internal/proderrors/...`, integration `prodErrors`, `prod-errors-go`, `prod-errors-signoz`, `radar*`, `shared-*`, `incident-*`, `unified-incident`, và `npm run build`; golden đồng bộ; `PROGRESS.md` cập nhật; danh sách manual verify (Splunk/SigNoz thật) ghi rõ.
