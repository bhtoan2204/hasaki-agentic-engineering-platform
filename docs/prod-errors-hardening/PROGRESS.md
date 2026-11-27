# Tiến độ hardening luồng scan Production Errors

> **Trạng thái hiện tại:** **Phase 1 đã xong (1.0 → 1.8), chờ bạn duyệt trước khi qua Phase 2.** Mục 1.9 (quét thủ công im lặng trên môi trường thật) là việc vận hành, chưa làm được ở đây. Phase 2 chưa bắt đầu; Phase 3 không làm đợt này (Q-9). Mọi thay đổi uncommitted.

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

- [ ] 2.0 Test đỏ T14–T22
- [ ] 2.1 `severity.ts` (thuần) + `severity.go` + `severity-vectors.json`
- [ ] 2.2 `assess` theo `window_hours`, `first_seen_at` (`known`), bậc mãn tính; ngưỡng từ TS qua op `sources`
- [ ] 2.3 Chế độ shadow `severity_v2` và so sánh với `severity` trên dữ liệu thật
- [ ] 2.4 Radar dùng chung phân loại; điền giờ 0 (chỉ giờ được bao phủ đầy đủ)
- [ ] 2.5 SigNoz: đếm distinct/không trùng span con, loại 4xx kỳ vọng, mẫu trace khớp `status_message`
- [ ] 2.6 SigNoz: kiểm tra mapping namespace (chỉ cảnh báo)
- [ ] 2.7 Golden đồng bộ; đủ bộ kiểm thử; tài liệu

### Phase 3 — Tùy chọn (chỉ khi Q-9 = có)

- [ ] 3.0 Test đỏ T23–T25
- [ ] 3.1 `NORMALIZE_RULES` (một nguồn) → `signatureOf` + SPL; parity test
- [ ] 3.2 Migration 116 (alias, `norm_version`) + dual compute
- [ ] 3.3 Kế thừa trạng thái, chặn `new`, quét thủ công im lặng
- [ ] 3.4 Radar/analytics đọc alias; quyết định `shared_analyses` (Q-9)
- [ ] 3.5 Kế hoạch rollback đã kiểm

## Quyết định đang chờ

| #    | Câu hỏi                                                                                   | Đề xuất                                                | Quyết định |
| ---- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------- |
| Q-1  | Ngưỡng rate/giờ (`heavyRate`, `chronicHigh`, `spikeRatio`, `spikeMinRate`, `minNewCount`) | 40/h, 200/h, 3×, 6/h, 5                                | _chờ_      |
| Q-2  | Cửa sổ < 1h: chặn `new`/`spike` ở medium; `minWindowHours`, `minSampleCount`              | 1h, 20                                                 | _chờ_      |
| Q-3  | TTL `ignored` và ngưỡng đánh thức                                                         | 14 ngày; `≥ max(20/h, 5×ignored_rate)` và `today ≥ 50` | _chờ_      |
| Q-4  | Nhắc lại `critical` mãn tính                                                              | tắt                                                    | _chờ_      |
| Q-5  | Mã HTTP kỳ vọng loại khỏi SigNoz; span `CLIENT`                                           | 400, 404, 409, 422, 429; giữ `CLIENT`                  | _chờ_      |
| Q-6  | Khởi động `EXTRA_LEVELS` im lặng                                                          | im lặng                                                | _chờ_      |
| Q-7  | Carry-over khi `partial`                                                                  | hiển thị + nhãn stale                                  | _chờ_      |
| Q-8  | Auto-reopen ghi `lifecycle reopen`?                                                       | không (chỉ `audit`)                                    | _chờ_      |
| Q-9  | Làm Phase 3? `shared_analyses` miss hay alias resolver                                    | chưa; nếu có thì chấp nhận miss                        | _chờ_      |
| Q-10 | SigNoz `count_distinct(trace_id)` hay span gốc/SERVER                                     | distinct nếu live check đạt                            | _chờ_      |
| Q-11 | Remap namespace SigNoz đẩy sang Phase 3                                                   | đẩy sang Phase 3                                       | _chờ_      |
| Q-12 | Liên kết nhóm Splunk↔SigNoz                                                               | ngoài phạm vi                                          | _chờ_      |

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

| Ngày       | Nội dung                                                  |
| ---------- | --------------------------------------------------------- |
| 2026-11-27 | Audit hoàn tất; lập `PLAN.md` và `PROGRESS.md`; chờ duyệt |

## Kết quả kiểm thử

Chưa chạy (chưa có thay đổi code).

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
