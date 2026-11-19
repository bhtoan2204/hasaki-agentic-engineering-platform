# Chat AUTO, admission health và UX tương tác

## Cơ chế lỗi gốc (trước khi sửa)

1. **Provider health bị bỏ qua**: `executeTurn` chỉ kiểm `enabled`, không gọi `probeAgentHealth` / `isUsableAgent` → request vào provider chết và treo lâu.
2. **Turn failed biến mất trên UI**: `chat.get` chỉ trả `active_turn`; sau khi failed, frontend không còn object để gắn lỗi với user message.
3. **Routing regex hẹp**: `CODE_SIGNAL` bỏ sót câu hỏi workspace kiểu “bao nhiêu payment provider”.

## Chiến lược

| Trục | Requested (conversation) | Effective (per turn) |
|---|---|---|
| Mode | AUTO / ASK / … | ASK / INVESTIGATE / PLAN / DELEGATE |
| Provider | strategy `auto` \| `manual` + preferred | provider thật sau admission |
| Model / effort | strategy + giá trị | validate theo provider đã chọn |
| Fallback | `fallback_enabled` | AUTO mặc định bật; manual pin mặc định tắt |

Tái sử dụng: `probeAgentHealth`, `nextHealthyProvider`, `isUsableAgent`, `completeForRun`, chat tool binding, SSE `chat_events`.

## Admission & fallback

```
phase validating_provider
  → admitProvider(strategy, preferred, health cache)
  → skip unhealthy (emit provider.skipped)
  → manual + !fallback → fail ngay (PROVIDER_UNAVAILABLE / AUTH / QUOTA)
  → auto → nextHealthyProvider
attempt loop (max 3)
  → inference / tools
  → on failure: classify; mayFallback? avoid provider; next admit
  → permission denial: không fallback
```

## Intent routing (không phụ thuộc model trả phí mỗi tin)

Lớp: explicit mode → mentions → multi-signal deterministic → follow-up context → default an toàn (tool bounded thay vì bịa workspace).

Ví dụ: “Hiện tại đang có bao nhiêu payment provider?” → `REPOSITORY_QUERY` / tools.

## Persistence (069)

Cột mới trên `chat_conversations` / `chat_turns`: strategies, effective_*, routing, phase, failure, attempts.

## UI

- Mode AUTO + provider AUTO độc lập.
- Composer gần controls; Enter gửi / Shift+Enter xuống dòng (IME-safe).
- Failed turn gắn dưới user message + Retry / Settings / Refresh health.
- SSE một subscription / conversation; tiến trình theo phase thật.

## Kiểm thử

- Unit: `test/chat.test.ts`, `test/chat-routing.test.ts`
- Integration: AUTO skip Claude→Codex; manual unhealthy fail có `failure` sau refresh

## Hạn chế

- Streaming: xem `interactive-agent-chat-streaming.md`.
- Screenshot dark/light: chạy thủ công `#/chat` sau build.
