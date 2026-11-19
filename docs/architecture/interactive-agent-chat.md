# Interactive Agent Chat — kiến trúc

## Mục tiêu

Chat tương tác với bộ nhớ phiên bền vững, tool calling đọc-only và uỷ thác workflow có xác nhận tường minh. Chat **không** giả danh workflow run để vượt authorization, **không** làm yếu `validateToolBinding`, và **không** tự thỏa mãn verification gate.

## Module tái sử dụng

| Thành phần | Vai trò trong chat |
|---|---|
| `completeForRun` / `CompletionRunner` | Completion không tool của provider (không import internals provider) |
| `loadAgentConfiguration` + `resolveStepAgent` | Model / effort / timeout theo Settings |
| `listAccessibleRepositories` / `requireRepositoryAccess` | Phạm vi repo theo user hiện tại |
| `searchSymbols` / `searchCodeExact` / `localScope` | Tìm và đọc source (provision=false) |
| `knowledge` + `visibleKnowledge` + `scoreKnowledge` | Knowledge theo quyền repo |
| `investigationSearch` / `searchLogs` | Splunk / SigNoz với credential của user |
| `databasesForRun` / `runQuery` / `assertReadOnlySql` | DB read-only, audit, mask cột nhạy cảm |
| `workItems.createManual` / `previewRun` / `startRun` | Uỷ thác → work item + run thật |
| `routeWorkflow` | Gợi ý workflow (user vẫn chọn) |

## Module mới (`src/chat/`)

| File | Trách nhiệm |
|---|---|
| `types.ts` | Mode, event kinds, rows |
| `repository.ts` | SQL owner-scoped (arch: chỉ phụ thuộc pool/types) |
| `policy.ts` | Allowlist tool theo mode, routing ASK direct/tools, system policy |
| `tools.ts` | Binding chat (owner + conversation + turn + mode + repo hiện tại) |
| `context.ts` | Mentions, compaction, build prompt theo thứ tự ưu tiên |
| `runtime.ts` | Fast path / tool loop, cancel, budget, usage null≠0 |
| `events.ts` | SSE `chat_events` riêng (không dùng fake run id) |
| `delegation.ts` | Preview hash + execute có confirm |
| `service.ts` | CRUD conversation, message, cancel/regenerate |

## Vòng đời một turn

```
POST /messages (client_message_id)
  → insert turn(queued) + user message (1 active turn / conversation)
  → scheduleTurn / claim(running)
  → route: ASK plain → direct completion; else tool loop
  → emit chat_events (started, tools, usage, completed|failed|canceled)
  → insert assistant message + citations
Stop → finishTurn(canceled) + abort AbortController (provider process khi CLI hỗ trợ)
Regenerate → supersede turn cũ + turn mới cùng user text
```

## Ma trận mode × capability

| | ASK | INVESTIGATE | PLAN | DELEGATE |
|---|---|---|---|---|
| Fast path (không tool) | có (câu hỏi thường) | không | không | không |
| Repo / knowledge / platform | có | có | có | có |
| Splunk / SigNoz / DB read | không | có | không | không |
| Sửa source / shell / push / DB write | **không bao giờ** | | | |
| Start workflow | chỉ qua preview + confirm | | | |

## Bảo mật (tóm tắt)

- Không bịa workflow execution identity.
- Mỗi tool call re-check owner, turn `running`, mode, quyền repo **hiện tại** (revocation có hiệu lực ngay).
- Nội dung tool / file / log nằm trong `<untrusted>` — không cấp quyền.
- Sau revoke repo: không tái phân phối kết quả tool / citation liên quan (withheld).
- Fallback provider: tắt → fail; không đổi billing / provider im lặng.
- Cost/token không biết → `null`, không ghi `0`.
- CI dùng `setChatProviders` (fake runner), không tiêu quota thật.

## API (POST cho mutation, theo convention nền tảng)

| Method | Path | Ghi chú |
|---|---|---|
| GET/POST | `/api/chat/conversations` | list / create |
| GET/POST | `/api/chat/conversations/:id` | get / patch |
| POST | `/api/chat/conversations/:id/delete` | xoá |
| POST | `/api/chat/conversations/:id/messages` | gửi (idempotent `client_message_id`) |
| GET | `/api/chat/conversations/:id/stream` | SSE |
| GET | `/api/chat/conversations/:id/events?after=` | poll fallback |
| POST | `/api/chat/turns/:id/cancel` | dừng |
| POST | `/api/chat/turns/:id/regenerate` | tạo lại |
| POST | `/api/chat/conversations/:id/delegation/preview` | xem trước |
| POST | `/api/chat/conversations/:id/delegation/execute` | `{ request, hash, confirmed: true }` |

## Dev local

1. Migration `068_chat.sql` (đã đánh số sau `067`).
2. `npm run build` rồi mở `#/chat`.
3. Test không quota: unit `test/chat.test.ts`; integration `test/chat.integration.ts` (fake providers).

## Hạn chế đã biết

- Streaming câu trả lời và phần suy luận: xem `interactive-agent-chat-streaming.md`.
- Compaction lịch sử là deterministic (không gọi model) — đủ cho quyết định/ràng buộc/evidence, có thể thiếu sắc thái văn phong.
- Chọn nhiều repo trên UI hiện là single-select; API/backend hỗ trợ mảng repositories.
- Screenshot dark/light: chạy thủ công trên `#/chat` sau khi đăng nhập (browser test có thể bổ sung sau).
