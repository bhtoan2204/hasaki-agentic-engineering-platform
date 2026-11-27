# Tiến độ hardening luồng scan Production Errors

> **Trạng thái hiện tại:** **Phase 1 và Phase 2 đã hoàn tất.** Phase 1 đã được commit (`68d26a0`); Phase 2 đang uncommitted. **Phase 3 hoãn (Q-9)**: không làm trong đợt này; nếu làm sau thì chấp nhận miss `shared_analyses`. Còn lại là các việc kiểm chứng trên Splunk/SigNoz thật (cuối tài liệu).

## Checklist

### Chuẩn bị

- [x] Audit luồng scan và severity (Node + Go) — báo cáo đã trình
- [x] Viết `PLAN.md`, `PROGRESS.md`
- [x] **Bạn duyệt kế hoạch và chốt Open Questions Q-1 … Q-12**

### Phase 1 — An toàn, không đổi fingerprint

- [x] 1.0 Test đỏ T1–T13 (§7.2 của PLAN)
- [x] 1.1 Migration 114 + `RequiredSchemaVersion = 114` (Go)
- [x] 1.2 Scan `partial` + `sources` + carry-over trong `listGroups` + banner UI
- [x] 1.3 SPL: panic trước `head`, `truncated` qua gateway + schema TS/Go
- [x] 1.4 SPL: field level `severity/lvl/log.level` và log text thuần (flag `PROD_ERRORS_EXTRA_LEVELS`)
- [x] 1.5 Siết `CRASH`/`MONEY` (TS + Go + vector chung + golden)
- [x] 1.6 `notifyNew` theo tăng bậc (`notified_severity`) + backfill
- [x] 1.7 `ignored` TTL + `reopenIgnored` trong `finalizeScan`
- [x] 1.8 Golden TS↔Go đồng bộ; chạy đủ bộ kiểm thử (§11 của PLAN); cập nhật tài liệu
- [ ] 1.9 Quét thủ công im lặng trên môi trường thật trước khi bật `EXTRA_LEVELS`

### Phase 2 — Severity, Radar, SigNoz

- [x] 2.0 Test đỏ T14–T22
- [x] 2.1 `severity.ts` (thuần) + `severity.go` + `severity-vectors.json`
- [x] 2.2 `assess` theo `window_hours`, `first_seen_at` (`known`), bậc mãn tính; ngưỡng từ TS qua op `sources`
- [x] 2.3 Chế độ shadow `severity_v2` và so sánh với `severity` trên dữ liệu thật
- [x] 2.4 Radar dùng chung phân loại; điền giờ 0 (chỉ giờ được bao phủ đầy đủ)
- [x] 2.5 SigNoz: đếm distinct/không trùng span con, loại 4xx kỳ vọng, mẫu trace khớp `status_message`
- [x] 2.6 SigNoz: kiểm tra mapping namespace (chỉ cảnh báo)
- [x] 2.7 Golden đồng bộ; đủ bộ kiểm thử; tài liệu

### Phase 3 — Tùy chọn (chỉ khi Q-9 = có)

- [ ] 3.0 Test đỏ T23–T25 _(hoãn, Q-9)_
- [ ] 3.1 `NORMALIZE_RULES` (một nguồn) → `signatureOf` + SPL; parity test _(hoãn, Q-9)_
- [ ] 3.2 Migration 116 (alias, `norm_version`) + dual compute _(hoãn, Q-9)_
- [ ] 3.3 Kế thừa trạng thái, chặn `new`, quét thủ công im lặng _(hoãn, Q-9)_
- [ ] 3.4 Radar/analytics đọc alias; quyết định `shared_analyses` (Q-9) _(hoãn, Q-9)_
- [ ] 3.5 Kế hoạch rollback đã kiểm _(hoãn, Q-9)_

## Quyết định đã chốt (khớp `PLAN.md` §9)

| #    | Quyết định                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q-1  | `heavyRate = 40/h`, `chronicHigh = 200/h`, `spikeRatio = 3`, `spikeMinRate = 6/h`, `minNewCount = 5` (cấu hình ở TS `config.prodErrors.severity`) |
| Q-2  | `minWindowHours = 1`, `minSampleCount = 20`                                                                                                       |
| Q-3  | TTL `ignored` 14 ngày; đánh thức khi `rate ≥ max(20/h, 5 × ignored_rate)` và `today ≥ 50`                                                         |
| Q-4  | Tắt nhắc lại `critical` mãn tính (`renotifyDays = 0`)                                                                                             |
| Q-5  | Loại mặc định `[400, 404, 409, 422]`, **không** loại 429; giữ span `CLIENT`                                                                       |
| Q-6  | Khởi động `EXTRA_LEVELS` bằng quét thủ công im lặng                                                                                               |
| Q-7  | Carry-over khi `partial`: hiển thị nhóm nguồn lỗi từ scan đầy đủ gần nhất + nhãn stale + banner                                                   |
| Q-8  | Auto-reopen không ghi `lifecycle 'reopen'`, chỉ `audit()`; reset `notified_severity = NULL` khi mở lại                                            |
| Q-9  | Chưa làm Phase 3; nếu làm sau thì chấp nhận miss `shared_analyses`                                                                                |
| Q-10 | Ưu tiên `count_distinct(trace_id)` nếu live check SigNoz đạt; giữ fallback span gốc/SERVER                                                        |
| Q-11 | Remap namespace SigNoz đẩy sang Phase 3                                                                                                           |
| Q-12 | Liên kết nhóm Splunk ↔ SigNoz ngoài phạm vi                                                                                                       |

## Ràng buộc đã ghi nhận (không đổi nếu không được duyệt lại)

- Phase 1 và 2 **không đổi** công thức `fingerprint` hay `signature`.
- Không đưa LLM/AI vào scan hay severity.
- Node và Go đồng bộ mọi thay đổi `assess`/`ToGroups`/`MergeSourceRows`/SQL publish, kèm golden và vector chung.
- Không đổi `src/sharing/*`; `arch:check` ≤ 5 cycles, ≤ 5 violations.
- Go dùng RE2: không dùng lookaround ở mọi regex dùng chung.

## Việc phải kiểm chứng trên môi trường thật (không làm được trong CI)

- [ ] Splunk: message auto-finalize/`max_time` thực tế (để `partial_reasons` bắt đúng)
- [ ] Splunk: tên trường level thực tế của từng service (`severity`, `lvl`, `log.level`) và dạng log text thuần của OMS
- [ ] Splunk: chạy vector chuẩn hóa bằng `| makeresults` (Phase 3)
- [ ] SigNoz: `count_distinct(trace_id)` có chạy với `query_range v5` của bản đang dùng không
- [ ] SigNoz: giá trị thực tế của `deployment.environment` so với k8s namespace
- [ ] So sánh `severity` và `severity_v2` trên ≥ 3 ngày dữ liệu thật (Phase 2)

## Nhật ký

| Ngày       | Nội dung                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 2026-11-27 | Audit hoàn tất; lập `PLAN.md` và `PROGRESS.md`; chờ duyệt                                                                      |
| 2026-11-27 | Duyệt kế hoạch, chốt 12 Open Questions (Q-9: hoãn Phase 3)                                                                     |
| 2026-11-27 | Phase 1 (1.0–1.8) hoàn tất; đã commit `68d26a0`. 1.9 (quét thủ công im lặng) chờ vận hành                                      |
| 2026-11-27 | Phase 2 (2.0–2.7) hoàn tất, uncommitted: severity v2 shadow, Radar giờ 0, SigNoz; chờ live-verify và xác nhận cách tách commit |

## Phase 1 — kết quả

### Trình tự TDD (đỏ → xanh)

Test viết và chạy **đỏ trước**, rồi mới implement. Kết quả đỏ thực tế:

| Test                                                       | Đỏ vì                                                                    | Xanh nhờ                                                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| T1 (log text thuần)                                        | SPL không có `rex`                                                       | `TEXT_LEVEL` + `rex field=msg` sau flag `PROD_ERRORS_EXTRA_LEVELS`                                                                     |
| T2 (`severity`/`lvl`/`log.level`)                          | chỉ `coalesce(level,LEVEL)`                                              | `coalesce(level,LEVEL,severity,lvl,'log.level')` sau flag                                                                              |
| T3 (SPL xếp crash trước, `head 301`)                       | SPL là `sort - today \| head 300`                                        | `max(crash) as is_crash`, `eval rank=is_crash*1000000000+today`, `head 301`                                                            |
| T3 (cap giữ crash count nhỏ)                               | `capSourceRows` chưa tồn tại; Go `capRows` chưa biên dịch được           | `capSourceRows`/`rowIsCrash` (TS) và `capRows`/`rowIsCrash` (Go); dùng ở gateway, `mergeSourceRows`, `MergeSourceRows`, `signozRows`   |
| T3/T4 (integration)                                        | `'one row more than the cap tells a cut'`: SPL vẫn `head 300`            | gateway xin 301 dòng, cắt về 300, trả `truncated`/`partial_reasons`; Go ghi `sources`                                                  |
| T5/T6 (partial, carry-over, không báo)                     | `column "partial" does not exist`                                        | migration 114, Go ghi `partial`/`sources`, `listGroups` carry-over + `stale_source`, `notifyNew` chỉ nhóm của scan hiện tại            |
| T7 (MySQL deadlock)                                        | `assess` coi là `critical` (regex `deadlock`)                            | `classify.ts`/`classify.go`: loại trừ deadlock DB                                                                                      |
| T8 (recovered panic)                                       | `assess` coi là `critical`                                               | loại trừ "recovered…panic"; level FATAL/PANIC và `panic: … [recovered]` vẫn critical                                                   |
| T9 (từ đơn `duplicate`/`double`/`callback`)                | `money` khớp từ đơn                                                      | từ chỉ tính khi có ngữ cảnh tiền hoặc cụm cố định                                                                                      |
| vector chung TS↔Go                                         | `classify.ts` chưa có; `go test` không biên dịch                         | `isCrash`/`isMoney` ở cả hai bên, 39 vector                                                                                            |
| golden                                                     | thêm ca "a crash group survives the per-source cap" ⇒ `golden.json` lệch | `prodErrorsGolden.ts --write`; diff chỉ **thêm** ca mới (không dòng nào bị xóa), Go `TestGolden` khớp                                  |
| T10 (không báo lặp theo ngày; tăng bậc báo lại)            | `expected: 1, actual: 3`                                                 | `notified_severity` + so bậc; tin nhắn "⬆️ tăng bậc (high → critical)"                                                                 |
| T11 (backfill)                                             | `ENOENT 114_prod_errors_hardening.sql`                                   | migration 114 có `UPDATE … notified_severity`                                                                                          |
| T12 (TTL, wake, reset thông báo, không lifecycle `reopen`) | `column "ignored_until" does not exist`                                  | `setIgnored` TTL 14 ngày + `ignored_rate`; `reopenIgnored` trong `finalizeScan`: mở lại, đặt `notified_severity = NULL`, ghi `audit()` |
| T13 (cờ tắt ⇒ xử lý level y hệt cũ)                        | xanh ngay từ đầu (test chốt hồi quy)                                     | giữ xanh                                                                                                                               |
| cờ cấu hình mặc định                                       | `config.prodErrors.extraLevels` chưa có                                  | thêm vào `config.ts`                                                                                                                   |

### Đã làm (theo mục)

- **1.1** `migrations/114_prod_errors_hardening.sql`: `prod_error_scans.partial/sources`; `prod_error_groups.notified_severity/notified_at/ignored_until/ignored_at/ignored_rate`; backfill `notified_severity`. Go `RequiredSchemaVersion = 114`.
- **1.2** Scan `partial`: `ok` vẫn `true`; `partial = true` khi một nguồn **lỗi** (kể cả phiên Splunk hết hạn) hoặc latency SigNoz lỗi; nguồn chưa từng kết nối là `skipped`, không phải partial. `listGroups` thêm nhóm của nguồn lỗi từ scan đầy đủ gần nhất (`stale_source`), trả `partial`/`sources`/`stale`. UI: banner partial, banner "bị cắt", nhãn stale, "bỏ qua đến …". Radar: `seriesCoverage` có `latest_scan_partial/truncated`.
- **1.3** SPL + gateway + schema TS/Go: `is_crash`, `head 301`, `truncated`, `partial_reasons` (Splunk), `truncated` (SigNoz); Go decode và ghi vào `sources`.
- **1.4** `PROD_ERRORS_EXTRA_LEVELS` (mặc định **tắt**): field level mở rộng và `rex` cho log text thuần.
- **1.5** `CRASH`/`MONEY` siết (RE2-tương thích, hai regex mỗi quy tắc), `classify.ts` ↔ `classify.go`, vector chung `testdata/classify-vectors.json`.
- **1.6** `notifyNew`: báo khi chưa báo hoặc bậc tăng; `renotifyDays = 0`; cờ `PROD_ERRORS_NOTIFY_ON_ESCALATION` (tắt ⇒ logic `notified_day` cũ).
- **1.7** `ignored` có TTL (cờ `PROD_ERRORS_IGNORE_TTL`), `reopenIgnored`; API `POST /api/prod-errors/:fp/ignore` nhận `days`.
- **1.8** Golden tái sinh; kiểm thử đầy đủ.

### Điểm khác kế hoạch hoặc cần biết

- Quy tắc nằm ở `src/prodErrors/classify.ts` (module lá) thay vì trực tiếp trong `scan.ts`; Phase 2 sẽ gộp vào `severity.ts`.
- SPL dùng `eval rank=is_crash*1000000000+today | sort - rank` thay vì `sort - is_crash - today`: chỉ dùng cú pháp `sort - <một trường>` đã chạy ở production.
- `notifyNew` chỉ xét nhóm có `last_scan_id` là scan đang finalize: nhóm chỉ được carry-over không bao giờ bị báo là mới. Hệ quả: nhóm chưa được báo của scan trước (ví dụ gửi Telegram lỗi) không được thử lại ở scan sau cho tới khi nó xuất hiện lại.
- Nhóm đã `ignored` từ trước migration không có `ignored_until` (không hết hạn) nhưng vẫn được đánh thức bởi spike. Muốn có TTL cho chúng phải backfill thủ công.
- UI: nút "bỏ qua" dùng TTL mặc định (API đã nhận `days`, chưa có ô chọn số ngày).
- Radar: chỉ thêm cờ `latest_scan_partial/truncated` vào `seriesCoverage`; điền giờ 0 và dùng cờ này là Phase 2.
- Gặp và sửa một lỗi tự gây ra: `replaceAll` làm hỏng tag JSON `slow_threshold_ms` trong Go; test integration SigNoz đã bắt được (latency groups bị tắt), đã sửa.
- `go vet ./...` toàn repo báo lỗi UTF-8 cố ý trong `internal/codeintelligence/testdata` (có từ trước, không liên quan); `go vet` cho `proderrors` và `cmd/...` sạch.

### Kết quả kiểm thử Phase 1

| Lệnh                                                                                                                                                        | Kết quả                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `npm run typecheck` (root + web)                                                                                                                            | pass                                                                |
| `npm run lint`                                                                                                                                              | pass                                                                |
| `npx prettier --check .`                                                                                                                                    | pass                                                                |
| `npm run arch:check`                                                                                                                                        | `{"files":527,"edges":3006,"cycles":5,"violations":5}` (không tăng) |
| `npm test`                                                                                                                                                  | 1571/1571 pass                                                      |
| `go test ./internal/proderrors/... ./internal/worker/...`, `go vet ./internal/proderrors/ ./cmd/...`, `gofmt`                                               | pass                                                                |
| Integration toàn bộ `test/*.integration.ts` (gồm `prodErrors` 20, `prod-errors-go`, `radar*`, `shared-*`, `incident-*`, `unified-incident`, `production-*`) | 1289 tests: 1287 pass, 0 fail, 2 skip                               |
| `prod-errors-signoz.test.ts`, `prod-errors-golden.test.ts`, `prod-errors-hardening.test.ts`, `prod-errors-classify.test.ts`                                 | pass (nằm trong `npm test`)                                         |
| `npm run build`                                                                                                                                             | pass                                                                |
| Gitleaks 8.30.1 (cùng bản và checksum với CI) trên file đổi/mới và `testdata`                                                                               | 0 finding                                                           |

### Cần kiểm chứng trên Splunk/môi trường thật (không làm được trong CI)

- [ ] **Cú pháp SPL mới chạy được:** `rex field=msg "(?i)…(?<tl>…)"`, `eval txt=…`, `eval crash=if(lv IN (…) OR match(txt,"(?i)…") …,1,0)`, `max(crash) as is_crash`, `eval rank=…`, `sort - rank`, `head 301`.
- [ ] Quoting `'log.level'` trong `coalesce` và tên trường level thật của từng service (`severity`, `lvl`, `log.level`).
- [ ] Dạng log text thuần thật của OMS: `TEXT_LEVEL` bắt đúng, không bắt nhầm dòng INFO có chữ ERROR trong thân.
- [ ] Message thật khi Splunk auto-finalize ở `max_time` để `partial_reasons` bắt đúng (regex hiện dựa trên từ khóa `finaliz|time limit|max_time|truncat|incomplete|partial|exceed`).
- [ ] Chi phí thêm của 3 `eval` mới trên khối lượng thật.
- [ ] **1.9** Quét thủ công im lặng (quét thủ công không bao giờ gửi Telegram) trước khi bật `PROD_ERRORS_EXTRA_LEVELS`, rồi xem số nhóm `new` phát sinh.
- [ ] Sau triển khai: số nhóm hạ severity do regex siết; không có Telegram hàng loạt sau migration 114.

## Phase 2 — kết quả

### Trình tự TDD (đỏ → xanh)

| Test                                                 | Đỏ vì                                                                   | Xanh nhờ                                                                                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vector chung `severity-vectors.json` (22 ca) TS + Go | `severity.ts` chưa có; Go `assessV2`/`DefaultThresholds` chưa biên dịch | `assessV2` + `SeverityThresholds` ở `severity.ts`; `assessV2` + `Thresholds` ở `severity.go`                                                                        |
| T14 (cửa sổ 00:30)                                   | `toGroups` không nhận context                                           | `GroupContext`; mẫu < `minSampleCount` trong cửa sổ < 1h chặn ở medium (crash miễn)                                                                                 |
| T15 (cùng rate/giờ, cửa sổ 1h/4h/24h)                | công thức đếm tuyệt đối                                                 | rate = `today / max(windowHours, minWindowHours)`                                                                                                                   |
| T16 (mãn tính volume cao)                            | v1: 6000/ngày không đổi chỉ `medium`                                    | bậc `chronic` (≥ 200/h, không phải `new`) → `high`                                                                                                                  |
| T17 (`new` theo `first_seen_at`)                     | `yesterday == 0` luôn là `new`                                          | `known` + `newWithinHours = 24`: quá 24h là `returned` (≤ medium)                                                                                                   |
| T25 (cờ tắt = v1; shadow)                            | không có `detail.severity_v2`                                           | cờ tắt: `severity` là v1, `detail.severity_v2` đi kèm; cờ bật: v2 quyết định, `detail.severity_v1` đi kèm; không context ⇒ y hệt cũ                                 |
| T18 (Radar giờ 0)                                    | `radar/coverage.ts` chưa có                                             | `coveredHours` (loại scan partial/truncated/nguồn skipped/namespace khác, chỉ giờ trọn) + `zeroFill`; chuỗi thưa + burst chỉ phát hiện `error_spike` sau khi điền 0 |
| T19 (Radar ≡ scan về crash/money)                    | Radar có `MONEY` riêng, không xét crash                                 | `needsBump` dùng chung từ `severity.ts`; Radar đọc 39 vector `classify-vectors.json`                                                                                |
| T20 (SigNoz đếm)                                     | `errorSpanQuery` chưa có                                                | `off` = truy vấn cũ; `trace` = `count_distinct(trace_id)`; `root` = `parent_span_id = '' OR kind`; loại mã trạng thái                                               |
| T21 (mẫu trace khớp khóa nhóm)                       | khớp theo service+name                                                  | khớp thêm `status_message` + `response_status_code`; mẫu thiếu hai trường vẫn khớp kiểu cũ                                                                          |
| T22 (namespace)                                      | `namespaceMapping` chưa có                                              | cảnh báo + `sources.signoz.status = "degraded"`; giá trị namespace không đổi                                                                                        |
| Integration T15/T17 (Go thật)                        | `config.prodErrors.severity` chưa có                                    | ngưỡng từ TS tới Go qua op `sources`; shadow; `returned` sau khi lùi `first_seen_at` 10 ngày                                                                        |
| Integration T20/T22 (Go thật)                        | `config.prodErrors.signoz` chưa có                                      | cùng filter ở cửa sổ và baseline; `degraded`; `partial=false`                                                                                                       |
| Golden                                               | ca mới (v2 cạnh v1, v2 quyết định, cửa sổ 30 phút)                      | `prodErrorsGolden.ts --write`; diff chỉ **thêm** ca mới; Go `TestGolden` khớp                                                                                       |

Ghi chú: lần chạy integration đỏ đầu tiên bị treo vì `finally` của test ném lỗi trước khi đóng server SigNoz giả; đã đổi thứ tự (đóng server trước). Test integration SigNoz lúc đầu đếm cả truy vấn latency; đã lọc theo `parent_span_id`.

### Đã làm (theo mục)

- **2.1** `src/prodErrors/severity.ts` (thuần) gộp `classify.ts` + `assess` cũ + `assessV2`; `go/internal/proderrors/severity.go` là bản port (`classify.go` đã xóa). `scan.ts` re-export `assess`.
- **2.2** `assessV2` theo rate/giờ, `first_seen_at`, `chronic`, `returned`; ngưỡng ở `config.prodErrors.severity`, truyền sang Go qua op `sources` (`severity_v2`, `thresholds`; schema cập nhật). Go nạp `first_seen_at` của các fingerprint bằng **một** truy vấn trước `ToGroups`; `windowHours` suy ra từ `Request.Start/End` nên **không cần migration 115**.
- **2.3** Shadow: cờ `PROD_ERRORS_SEVERITY_V2` (mặc định tắt). Tắt: `severity/score/reasons` là v1, `detail.severity_v2 = {severity, score, reasons}`. Bật: v2 là chính, `detail.severity_v1` đi kèm. UI và Telegram có lý do `returned`, `chronic` (vi/en).
- **2.4** Radar: `severityOf` dùng `needsBump` chung (bỏ `MONEY` riêng); `loadErrorSeries` điền giờ 0 chỉ cho giờ trọn vẹn của scan OK **không** `partial`, **không** `truncated`, đúng nguồn của nhóm và đúng namespace.
- **2.5** SigNoz: `PROD_ERRORS_SIGNOZ_DISTINCT = off | trace | root` (mặc định `off` = truy vấn cũ, giống hệt); `PROD_ERRORS_SIGNOZ_IGNORE_STATUS` (mặc định `400,404,409,422`); `serverKind` cấu hình được. Mẫu trace lấy thêm `selectFields` (`status_message`, `response_status_code`).
- **2.6** Namespace: `namespaceMapping` + ghi chú + `sources.signoz.status = "degraded"` (Go ghi); không remap.
- **2.7** Golden tái sinh, kiểm thử đầy đủ.

### Khác kế hoạch hoặc cần biết

- Nếu `PROD_ERRORS_SIGNOZ_DISTINCT = off`, **cả** việc loại mã trạng thái cũng tắt (toàn bộ thay đổi đếm nằm sau một cờ, để cờ tắt = y hệt trước). Chỉ sửa mẫu trace (2.5b) và cảnh báo namespace (2.6) luôn bật.
- Cú pháp lọc mã trạng thái dùng `NOT (response_status_code = '400' OR …)` và `kind_string = 'Server'`: **chưa kiểm chứng** trên SigNoz thật (xem danh sách bên dưới).
- Lý do "cửa sổ ngắn" không có khóa riêng trong `reasons` (chỉ chặn bậc), để không thêm chuỗi UI; có thể thêm sau nếu cần giải thích.
- Radar: điền 0 làm `rate` và median baseline chính xác hơn, nên một số chuỗi thưa sẽ được phát hiện `error_spike` mà trước đây không (đúng mục tiêu). `minBaseline` (12 giờ) nay đếm cả giờ 0.
- Phase 1 đã commit; vì vậy đề xuất commit bên dưới chỉ gồm Phase 2.

### Kết quả kiểm thử Phase 2

| Lệnh                                                                                                                                                        | Kết quả                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `npm run typecheck` (root + web)                                                                                                                            | pass                                                                |
| `npm run lint`                                                                                                                                              | pass                                                                |
| `npx prettier --check .`                                                                                                                                    | pass                                                                |
| `npm run arch:check`                                                                                                                                        | `{"files":528,"edges":3008,"cycles":5,"violations":5}` (không tăng) |
| `npm test`                                                                                                                                                  | 1585/1585 pass                                                      |
| `go test ./internal/proderrors/... ./internal/worker/...`, `go vet ./internal/proderrors/ ./cmd/...`, `gofmt`                                               | pass                                                                |
| Integration toàn bộ `test/*.integration.ts` (gồm `prodErrors` 22, `prod-errors-go`, `radar*`, `shared-*`, `incident-*`, `unified-incident`, `production-*`) | 1291 tests: 1289 pass, 0 fail, 2 skip                               |
| `npm run build`                                                                                                                                             | pass                                                                |
| Gitleaks 8.30.1 (cùng bản và checksum với CI) trên file đổi/mới và `testdata`                                                                               | 0 finding                                                           |

### Cần kiểm chứng trên Splunk/SigNoz thật

- [ ] **SigNoz `query_range v5`:** `count_distinct(trace_id)` có chạy với `requestType = scalar` và `time_series`; nếu không, dùng `PROD_ERRORS_SIGNOZ_DISTINCT=root`.
- [ ] **SigNoz:** cú pháp `NOT (response_status_code = '400' OR …)` (span không có thuộc tính này có bị loại nhầm không) và kiểu dữ liệu của `response_status_code` (chuỗi hay số).
- [ ] **SigNoz:** tên trường loại span (`kind_string = 'Server'`?) cho chế độ `root`; chỉnh `config.prodErrors.signoz.serverKind` nếu khác.
- [ ] **SigNoz:** `selectFields` của truy vấn mẫu trả đúng `status_message`/`response_status_code` (nếu thiếu, mẫu trace quay về khớp theo service+name).
- [ ] **SigNoz:** giá trị thật của `deployment.environment` so với namespace k8s đã cấu hình (ghi chú/`degraded` có xuất hiện không).
- [ ] So sánh `severity` với `detail.severity_v2` trên ≥ 3 ngày dữ liệu thật trước khi bật `PROD_ERRORS_SEVERITY_V2`; xem phân bố `returned`, `chronic`.
- [ ] Radar: số `error_spike` mới sau khi điền giờ 0 (kỳ vọng tăng ở chuỗi thưa).
- [ ] Các mục Splunk của Phase 1 (cú pháp SPL mới, `partial_reasons`, quét im lặng 1.9) vẫn còn mở.

### Đề xuất tách commit cho Phase 2 (chưa chạy)

Phase 1 đã nằm trong `68d26a0`. Phase 2 nên tách thành 5 commit:

1. `refactor(prod-errors): one severity module for the scan, the Go port and Radar` — `severity.ts`, `severity.go`, xóa `classify.ts/.go`, `merge.go` (chuyển `assess`), `radar/detect.ts` (`needsBump`), `severity-vectors.json`, các test `prod-errors-severity`, `prod-errors-classify`, `severity_test.go`.
2. `feat(prod-errors): severity v2 by rate per hour, shadowed beside v1` — `config.ts`, `scan.ts` (`GroupContext`, `toGroups`, `severityThresholds`), `gateway.ts`, Go (`ToGroups` context, `store.firstSeen`, `scan.go`), schema, `golden.json` + fixture, UI/i18n lý do mới, test `prod-errors-phase2` (T14–T17, T25), integration T15/T17.
3. `fix(radar): count the hours a complete scan saw nothing, and share the crash/money rules` — `radar/coverage.ts`, `radar/scan.ts`, test T18/T19.
4. `feat(signoz): count distinct traces behind a flag, match trace samples exactly, warn on namespace mismatch` — `integrations/signoz.ts`, `scan.ts` (`signozRows`, `namespaceMapping`), `gateway.ts` (`degraded`), Go `degraded`, test T20–T22, integration T20/T22.
5. `docs(prod-errors): record phase 2 results` — `docs/prod-errors-hardening/*`.

Commit `feat`/`refactor`/`fix` cần footer `func:` — mình cần mã function từ bạn.
