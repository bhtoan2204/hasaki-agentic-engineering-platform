# Chat streaming và suy luận mở rộng

## Luồng dữ liệu

`CompletionRunner` (src/agent/complete.ts) nhận thêm `onStream` (`src/agent/completionStream.ts`). Mỗi adapter chỉ báo những gì provider thật sự phát ra:

| Provider              | text                                    | reasoning                      | activity                                                          |
| --------------------- | --------------------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| Claude (Agent SDK)    | `includePartialMessages` → `text_delta` | `thinking_delta`               | — (completion không có tool)                                      |
| Codex (`exec --json`) | `agent_message` (cả message một lần)    | item `reasoning`               | `command_execution`, `mcp_tool_call`, `web_search`, `file_change` |
| Cursor                | `stream-json --stream-partial-output`   | `thinking`                     | `tool_call started`                                               |
| Antigravity / Copilot | delta text của CLI                      | `thinking` / `reasoning_delta` | tool event của CLI                                                |

`text` là toàn bộ câu trả lời tính đến lúc đó (provider có thể sửa lại). Provider không có reasoning thì panel chỉ hiện hoạt động thật (tool của platform, lệnh của provider); không tự sinh nội dung suy luận.

`TurnStream` (src/chat/streaming.ts) gom sự kiện của một turn:

- `response.delta {attempt, step, offset, text}`: tối đa một batch mỗi 200 ms, không phải một dòng mỗi token. `offset` là độ dài phần chung với lần gửi trước, nên provider sửa câu trả lời vẫn đúng.
- `reasoning.delta`, `provider.activity`.
- Ghi vào `chat_events` có sẵn, dùng lại SSE, `Last-Event-ID` replay và multi-instance qua NOTIFY. Không có transport thứ hai.
- Block `chat-tool` (yêu cầu tool gửi platform) không bao giờ được stream ra như câu trả lời; phần đầu có thể là fence sẽ được giữ lại.
- Draft và trace được checkpoint vào `chat_turns.draft/trace` (migration 077) tối đa mỗi giây; client kết nối lại lấy từ `GET /api/chat/conversations/:id` (`active_turn.draft/trace`). Delta đến trước checkpoint được giữ chờ rồi áp lại.
- Khi turn kết thúc: câu trả lời lưu trong `chat_messages` thay thế draft; các delta event của turn bị xóa; trace giữ lại cho panel của tin nhắn.

## Dừng, lỗi, provider không khỏe

- Stop (API cancel có sẵn) → abort → phần đã stream được lưu thành tin nhắn assistant của turn `canceled`; UI gắn nhãn "câu trả lời dở". Lỗi không fallback được cũng vậy (turn `failed`), kèm thẻ lỗi. Instance chết giữa chừng: lúc recover lấy draft checkpoint.
- Fallback (AUTO): draft của attempt lỗi không thành câu trả lời; attempt mới bắt đầu draft mới.
- Watchdog mỗi lần gọi provider: không có sự kiện nào trong `firstActivityMs` (60 s) → `FIRST_RESPONSE_TIMEOUT`; im lặng quá `streamIdleMs` (180 s) → `IDLE_TIMEOUT`. Cả hai được fallback như provider không khả dụng; chọn thủ công không fallback thì báo lỗi ngay. Health admission có sẵn vẫn chạy trước mỗi lần gọi.

## UI

Bubble đang chạy: panel "suy luận" gập mặc định, tiêu đề là trạng thái thật (Đang suy nghĩ / Đang đọc file / Đang chạy công cụ / Đang soạn câu trả lời, suy ra từ event), bên dưới là Markdown của draft. Tin nhắn đã xong có panel "Đã xử lý Ns · K bước" từ trace. Reducer phía client thuần, có test: `web/src/pages/chatStream.ts`.

## Kiểm thử

- Unit `test/chat-streaming.test.ts`: lọc tool block, watchdog, mapping Codex, reducer client (thứ tự, sửa, bước mới, mất event).
- Integration `test/chat-streaming.integration.ts` (provider giả): delta được gom, trace, xóa delta khi xong, không lộ tool block, stop giữ câu trả lời dở, fallback giữa chừng, lỗi thủ công giữ câu trả lời dở.

## Hạn chế

- Codex `exec --json` chỉ trả message hoàn chỉnh: câu trả lời hiện ra một lần, reasoning/hoạt động vẫn real-time.
- Claude completion không dùng tool nên không có activity; thinking chỉ có khi model/effort sinh ra.
- Mapping Claude/Cursor/Antigravity/Copilot chưa được test với CLI thật trong môi trường này (không dùng quota).
