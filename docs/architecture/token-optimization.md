# Tối ưu token: delta context, session có trạng thái, nén output tool

## Audit (trước thay đổi)

- **Workflow resume:** `buildResumeMessage` gửi lại **toàn bộ** context pack, khối code intelligence và developer decisions mỗi lần resume session. Không có bản ghi nào về việc đã gửi gì cho session nào.
- **Chat tool loop:** mỗi bước dựng lại và gửi lại toàn bộ prompt (policy, catalog, history, knowledge, memory, mọi tool result đã tích luỹ). Completion luôn stateless (`persistSession: false`, Codex `--ephemeral`).
- **Output tool vượt giới hạn bị cắt và mất bản gốc:** `call_tool` cắt ở 40k, chat ở 6k.
- **Telemetry:** usage thật từ provider đã có cho từng attempt (input/output/cache_read/cache_creation). Chat chưa ghi cache.
- **Telemetry thật 14 ngày** (`npm run bench:tokens -- telemetry`): với Claude, input không cache gần 0, còn **cache read ~300–415k/attempt** và cache creation ~80–110k. Chi phí nằm chủ yếu trong session của agent (mỗi lượt tool đọc lại cả hội thoại từ cache). Codex và Antigravity tốn hơn nhiều (1,6M–5,3M tổng input mỗi attempt).

## Đã làm

| # | Thay đổi | Ở đâu |
|---|---|---|
| 1 | **Context Delivery Manifest**: bảng `agent_context_deliveries` (migration 082) lưu hash từng entry đã gửi, kèm hash của system prompt và developer decisions, theo provider session. Khi resume chỉ gửi entry mới hoặc đã đổi, kèm danh sách entry không đổi (vẫn đọc lại được qua platform tools). Decisions chỉ gửi lại khi đã đổi; câu trả lời mới luôn được gửi. | `src/context/delivery.ts`, `stepPrompt.ts`, `harness/stages/execute.ts` |
| 1b | **Invalidation:** system prompt đổi (policy, tool, skill) → gửi đầy đủ. Một entry code, knowledge, repositories hay production đã gửi nay không còn (thu quyền, thu hẹp scope) → **không resume**, dựng session mới. Knowledge lên version → gửi bản mới. Đổi provider → session khác. | `planContextDelivery` |
| 2 | **Chat có session:** completion có thể giữ session của provider (Claude SDK `resume`, lưu trong `dataDir/completion-sessions`, tách khỏi session Claude Code của developer). Các bước sau chỉ gửi delta: tool result mới, catalog vừa mở (sau escalation), hoặc thông báo hết tool. Mất session thì gửi lại prompt đầy đủ, không làm fail turn. | `complete.ts`, `chat/runtime.ts`, `chat/context.ts` |
| 2b | **Chat stateless:** tool result của các bước trước được nén tất định (lỗi giữ nguyên), bước mới nhất giữ đầy đủ. Bản gốc lấy lại bằng tool `evidence.get {seq, offset}`. | `compactToolResults`, `chat/tools.ts` |
| 3 | **Đo lường:** chat ghi từng lời gọi provider (`metrics.steps`): full hay delta, ước tính độ dài prompt đã gửi, ước tính nếu gửi đầy đủ, và usage thật (input, output, cache_read, cache_creation). Usage của chat thêm cache. Workflow ghi `context_delivery` (gửi gì, ước tính message delta so với full). Số ước tính luôn ghi rõ `character_estimate_not_provider_usage`. | |
| 4 | **Nén output tool:** `call_tool` vượt 40k thì lưu bản đầy đủ (đã redact) thành artifact `log`, đọc được bằng `read_artifact`. Model nhận bản nén giữ phần đầu, phần cuối và mọi dòng có lỗi hoặc `file:line`. | `compressToolOutput` |
| 5 | **Catalog theo intent:** chat chỉ mô tả các nhóm tool hợp với route (knowledge, repository, database, plan). Quyền vẫn theo mode, `tools.search` vẫn tìm được mọi integration. Yêu cầu resume hoặc escalate thì dùng catalog đầy đủ. | `toolCatalog(mode, route)` |
| 7 | **Compaction session thích ứng:** xem mục bên dưới. | `src/context/compaction.ts` |
| — | **Công tắc** `agent.deltaContext` (mặc định `true`). `false` trả về hành vi cũ, vừa làm baseline cho A/B vừa để rollback. | |

Không thêm lời gọi LLM nào. Nén và lập kế hoạch đều tất định.

## Giữ nguyên

Ranh giới independent verification, evidence root-cause, developer decisions (gửi lại khi đổi), policy enforced và business invariant (system prompt đổi thì gửi lại toàn bộ) đều giữ nguyên. Quyền tool vẫn theo mode và registry. Verify bắt buộc không đổi.

## Đo lường

- **Tất định** (`test/token-delta.integration.ts`, provider giả mô phỏng session kiểu Claude): một turn chat 4 bước gửi ít hơn ≥ 30% **ký tự prompt thực gửi** so với baseline (`deltaContext=false`). Đây là số đo ký tự, không phải token provider; không dùng để tuyên bố tiết kiệm.
- **Usage thật:**
  - `npm run bench:tokens -- chat --live --owner <user> --budget-usd <N> [--repeat 3]`: chạy cùng workload chat với baseline và candidate trên provider thật, báo median tổng input (uncached + cache read + cache write), cache, output, tool calls, latency, tỉ lệ thành công. **Tốn quota, chỉ chạy khi được phép.**
  - `npm run bench:tokens -- telemetry --days N`: chỉ đọc, tổng hợp theo profile MICRO/FAST/STANDARD/DEEP và chat, tách attempt có hoặc không có delta. So sánh cửa sổ trước và sau khi bật.

## Hạn chế

- Delta workflow chỉ tác động lên **message resume** (sau ask_user hoặc reviewer feedback). Phần lớn chi phí workflow (cache read 300k+ mỗi attempt) là lịch sử *bên trong* một session agent, nằm ngoài phạm vi thay đổi này. Mục tiêu giảm 30% cho MICRO/FAST/STANDARD/DEEP **chưa được chứng minh**.
- Session có trạng thái cho chat mới có ở Claude. Codex, Cursor, Antigravity và Copilot vẫn stateless (dùng nén).
- File session completion của Claude nằm trong `dataDir/completion-sessions`, chưa có dọn dẹp tự động.

## Compaction session thích ứng (provider-neutral)

Dùng lại context pack, continuity record (`agent_context_continuity`), checkpoint và artifact. Không thêm framework.

- **Đo áp lực:** `metrics.context_window = {last_tokens, peak_tokens}`, tính từ usage của **từng lời gọi** ở session chính (input + cache read + cache write của lời gọi đó; bỏ qua subagent), không phải usage cộng dồn. Áp lực = occupancy / context window của model (`agent.contextWindowTokens`, mặc định 200k; override theo provider; Claude `[1m]` = 1M). Provider không báo usage theo lời gọi thì áp lực là *unknown* và không bao giờ kích hoạt compaction.
- **Ranh giới an toàn:**
  - Trước khi resume session (câu trả lời ask_user, reviewer feedback).
  - **Trước mỗi repair round sau khi verify fail.** Mỗi round đọc lại toàn bộ session, nên đây là chỗ tốn nhất.
  - Khi `pressure ≥ agent.compaction.pressure` (mặc định 0,6), session cũ bị đánh dấu không resume được và việc tiếp tục chạy trong **session mới dựng từ trạng thái platform**.
- **Session mới gồm:**
  - Context pack giữ nguyên văn: yêu cầu, invariant, developer decisions, scope đã duyệt, rule.
  - `sessionStateBlock`, dựng tất định, không phải model tóm tắt: trạng thái workspace hiện tại (commit, uncommitted, diff stat), trạng thái verify (repo, status, regression, excerpt có `file:line`), bản ghi continuity của attempt trước (outcome, câu hỏi chưa xong, verify/independent verify), progress notes, tham chiếu ID ổn định tới artifact log/report (`read_artifact`) và `run.step_history` của attempt.
  - Yêu cầu sửa hoặc tiếp tục.
- **Code cũ bị vô hiệu:** manifest delivery lưu fingerprint workspace (`$workspace`). Revision đổi thì các entry code được gửi lại. Khối trạng thái nhắc agent đọc lại các file nó sửa.
- **Compaction native** (`agent.compaction.mode = "native"`): Claude nhận `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, Codex nhận `model_auto_compact_token_limit`, để compaction của chính provider chạy sớm hơn *bên trong* một turn dài (nơi không có ranh giới). Dựng lại từ checkpoint vẫn là fallback ở các ranh giới. Sự kiện `compact_boundary` của Claude luôn được ghi (`metrics.compactions`, `native:auto|manual`).
- Mặc định `reconstruct`. Native không bật mặc định vì nó tự tốn một lời gọi LLM và chưa có số đo.
- **Ranh giới bảo mật:** session mới dùng cùng policy, quyền, sandbox và verify. Independent verification không bị đụng tới (step reviewer không có repair round). Không có lời gọi LLM nào để tóm tắt.

### Đo lường

`npm run bench:tokens -- telemetry` thêm các cột: occupancy đỉnh, số attempt có compaction, tỉ lệ thành công của attempt có compaction (để đo giữ context và độ tin cậy khi phục hồi), tổng input, cache, tool calls, latency, retry.

### Hạn chế

- Nhánh compaction trong repair round chưa có test end-to-end với session agent thật. Hàm quyết định, khối trạng thái và đo occupancy có unit test.
- Codex, Cursor, Antigravity, Copilot không báo occupancy theo lời gọi trong luồng hiện tại nên áp lực là unknown. Chỉ native mode của Codex áp dụng được cho họ.
- Biến `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` có trong tài liệu Claude Code. Việc SDK chuyển `env` xuống process con chưa được xác minh trên bản cài thật.
- Chưa có benchmark A/B bằng usage thật (cần chạy live).
