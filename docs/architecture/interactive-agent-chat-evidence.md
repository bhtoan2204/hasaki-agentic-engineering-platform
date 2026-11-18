# Bằng chứng kiểm thử — Interactive Agent Chat

Ngày: 2026-11-19

## Lệnh đã chạy

| Kiểm tra | Kết quả |
|---|---|
| `npm run typecheck` | pass |
| `npm run arch:check` | pass (baseline: 5 cycles / 6 violations — không tăng) |
| `node --import ./test/env.ts --test test/chat.test.ts` | 14/14 pass |
| `node --import ./test/setup.ts --test test/chat.integration.ts` | 4/4 pass |
| `npm run build` | pass |
| CI model quota | **không** tiêu — integration dùng `setChatProviders` fake runner |

## Kịch bản regression đã cover (unit + integration)

1. ASK câu hỏi thường → direct, không tool call  
2. ASK có tín hiệu code / mention → route tools  
3. Idempotent `client_message_id`  
4. Ownership: user khác → 404  
5. Một turn active; POST song song → 409  
6. Cancel → status canceled, không orphan active turn  
7. Regenerate supersede  
8. Cost/token unknown → `null`  
9. Withhold citation sau revoke repo (unit)  
10. Parse tool fence / strip / acceptance criteria / risk  

## Chưa tự động trong PR này

- Browser screenshot dark/light (cần phiên đăng nhập + Chromium sandbox)  
- End-to-end Splunk/SigNoz/DB tool (cần credential tích hợp; primitive đã nối qua binding chat)  
- Đo latency before/after trên môi trường production-like  

## Độ lệch so với spec

- Mutation dùng POST (không PATCH/DELETE HTTP) — theo convention hiện tại của `app.ts` / client `api()`.  
- SSE chat riêng trên `/api/chat/conversations/:id/stream`, không đi qua `workflow_events`.  
