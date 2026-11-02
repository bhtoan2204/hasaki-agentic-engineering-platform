# Claude Task Platform

Nhận task Hasaki (JSON từ task API) → Claude Code (Agent SDK) tự tìm chỗ sửa → hỏi lại trên platform khi chưa rõ
→ code trên nhánh `<task code>` → push + mở PR Bitbucket vào `release/prod` → báo lên platform kèm các quyết định cần review.

## Chạy

```bash
npm install
cp config.example.json config.json   # sửa reposRoot, projects, bitbucket...
export BITBUCKET_USER=you@hasaki.vn BITBUCKET_TOKEN=...   # tuỳ chọn, thiếu thì platform trả link tạo PR
npm start                             # http://localhost:4545
```

Cần Node >= 22.18 (chạy thẳng `.ts`, dùng `node:sqlite`), `claude` đã login, SSH key push được Bitbucket.

## Luồng

| Trạng thái | Ý nghĩa |
|---|---|
| `queued` | chờ tới lượt (mặc định chạy 1 agent một lúc — `maxConcurrent`) |
| `running` | agent đang làm |
| `waiting_answer` | agent gọi `ask_user`, đã dừng; trả lời trên UI → resume đúng session |
| `review` | đã có PR; gửi feedback ở ô "Nhắn cho agent" → agent sửa, commit, cập nhật PR |
| `idle` / `failed` | agent dừng không có PR / lỗi — nhắn để chạy tiếp |

Agent có 4 tool riêng (`mcp__platform__*`): `prepare_branch`, `ask_user`, `post_update`, `create_pull_request`.

## API

- `POST /api/tasks` — body là nguyên response task API (`{data:{...}}`) hoặc chỉ `data`. Task mới sẽ chạy ngay; gửi lại cùng code chỉ cập nhật payload.
- `GET /api/tasks`, `GET /api/tasks/:code`
- `POST /api/tasks/:code/answers` — `{answers: {"<questionId>": "..."}}`
- `POST /api/tasks/:code/messages` — `{message: "..."}`
- `POST /api/tasks/:code/cancel`

Ví dụ đẩy task từ script/cron: `curl -XPOST localhost:4545/api/tasks -H 'content-type: application/json' -d @task.json`

## An toàn

- Agent chạy `bypassPermissions` (không ai bấm duyệt), nhưng bị chặn `git push`, `git reset --hard`, `git clean`, `rm -rf`;
  push chỉ đi qua `create_pull_request` (kiểm tra sạch + có commit trước khi push).
- Code được sửa trong git worktree riêng ở `~/.claude-task-platform/worktrees/<code>/<repo>` — checkout của bạn
  ở `~/src/<repo>` không bị đụng. Ngoại lệ: nếu bạn đang checkout đúng nhánh task trong repo chính, agent dùng luôn checkout đó.
- Platform không có auth — chỉ bind/dùng trên máy local.
