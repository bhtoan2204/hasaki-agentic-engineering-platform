# Lưu trữ evaluation tập trung (PostgreSQL)

## Hiện trạng trước thay đổi

| Nguồn                                                        | Trước                                                                                                  | Sau                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Benchmark framework (`/api/evaluation-runs`, `npm run eval`) | `evaluation_runs` / `evaluation_case_runs` / `eval_results` / `evaluation_comparisons`, chỉ owner thấy | Như cũ, thêm visibility `private\|team`              |
| Bench (`npm run bench`)                                      | `eval_results` (không owner, ai cũng thấy) + `bench-results.json`                                      | Như cũ; file nhập được bằng `eval:import`            |
| Autonomy suite (`npm run eval:autonomy`)                     | chỉ file `.eval/*.json\|md`                                                                            | Lưu vào DB theo mặc định; file chỉ còn là bản export |
| Performance baseline (`benchPerformance`)                    | chỉ file JSON (chạy trên cluster test riêng)                                                           | File nhập được bằng `eval:import`                    |
| Report benchmark/so sánh (`report.json`)                     | chỉ file                                                                                               | Nhập được bằng `eval:import`                         |

## Mô hình (migration 080, chỉ thêm)

- **`evaluation_reports`**: header của report sinh ngoài benchmark framework.
  - Các field: `kind` (autonomy, performance, bench, benchmark), `suite`, `suite_version`, `manifest_hash`, `commit_sha`, `provider`, `model`, `configuration`, `metrics`, `gate`, `provenance`, `source` (cli, import, api), `generated_at`.
  - `content_hash` là hash canonical của report; `UNIQUE(owner_id, content_hash)` để lưu lại hoặc import lại không tạo bản trùng.
- Dữ liệu từng case/episode lưu vào **`eval_results`** có sẵn (`report_id`), không lập bảng song song.
- **`visibility`** (`private` mặc định, `team`) có trên `evaluation_runs`, `eval_results` và `evaluation_reports`.
- Row `eval_results` cũ không có owner vẫn hiện cho mọi người như trước.

## Quyền truy cập

- Owner: đọc và đổi visibility.
- `team`: mọi thành viên đã đăng nhập của instance được **đọc**. Platform chưa có khái niệm nhóm con, nên "team" = toàn bộ tổ chức trên instance.
- Chỉ owner được sửa, chia sẻ, start hay cancel; người khác nhận 404.
- Admin chỉ thấy report private của người khác khi gọi với `scope=all` (support).
- Run benchmark được share sẽ đi vào analytics và evidence recommendation (`evaluation_analytics_samples`) của đồng đội. Vì vậy routing provider/model và agent optimization dùng chung được kết quả đã share. Kết quả private vẫn chỉ owner dùng.

## Cách dùng

```sh
npm run eval:autonomy -- --owner <username> [--share]          # lưu DB + export .eval/autonomy/*.json|md
npm run eval:autonomy:ci -- --out .eval/autonomy                # CI: không có DB (--no-db)
npm run eval:import -- --owner <username> [--share] [--suite bench-v2] FILE...
```

Exit code của `eval:autonomy`:

- `1`: gate fail;
- `3`: không lưu được vào DB (ví dụ thiếu `--owner`, DB không truy cập được);
- `--no-db`: chỉ ghi file.

API:

- `GET /api/evaluation-reports?kind=`
- `GET /api/evaluation-reports/:id` (header + rows)
- `POST /api/evaluation-reports` `{report, visibility?, suite?}` (import JSON từ bất kỳ máy nào)
- `POST /api/evaluation-reports/:id/visibility`
- `POST /api/evaluation-runs/:id/visibility`

UI: Insights → Autonomy → "Báo cáo đã lưu" (của bạn và của team, kèm nút chia sẻ hoặc thu hồi).

## Kiểm thử

- Unit `test/evaluation-reports.test.ts`: nhận dạng từng loại report kèm version, manifest, commit, provenance; mỗi episode thành một row; file lạ bị từ chối; hash không phụ thuộc thứ tự key.
- Integration `test/evaluation-reports.integration.ts`:
  - lưu một lần (lưu lại hoặc import file export không tạo trùng, row không nhân đôi);
  - private mặc định; share chỉ cho đọc; chỉ owner đổi được; admin cần support scope; bỏ share có hiệu lực ngay;
  - run benchmark share: đồng đội đọc được và thấy trong analytics, nhưng không cancel được;
  - dữ liệu legacy giữ nguyên; giá trị mặc định của migration;
  - CLI `eval:import` thật: import một lần, file lạ báo lỗi, import có share thì đồng đội thấy.

## Hạn chế

- Report performance và bench vẫn sinh ra ở database hoặc cluster riêng, nên phải nhập bằng `eval:import`. CLI chưa ghi thẳng vào DB chính.
- Visibility `team` là toàn instance, chưa có phân nhóm.
- So sánh (`evaluation_comparisons`) vẫn chỉ owner; chỉ các run được share mới dùng chung.
