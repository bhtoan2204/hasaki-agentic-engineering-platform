# Provider Compatibility Standardization Progress

> **Trạng thái hiện tại:** Đã hoàn tất **Phase 2 (Bước 5–6)** — **DỪNG** chờ duyệt để chuyển sang **Phase 3 (Bước 7–9)**. Toàn bộ thay đổi vẫn ở trạng thái uncommitted trong working tree.

## Checklist

- [x] **Bước 1 — Khảo sát & Lập kế hoạch (`PLAN.md`, `PROGRESS.md`)**
  - Hoàn thành Compatibility Matrix 5 providers × 7 trục, bảng 14 Claude-isms ngoài `src/agent/`, đánh giá cấu trúc `src/agent/providers/<name>/`, thiết kế `ProviderCapabilities` & degradation rules, chốt 5 Open Questions tại [`PLAN.md`](file:///home/toan/hasaki-orbit/docs/provider-compatibility/PLAN.md#L284).
- [x] **Bước 2 — Tách shared helpers khỏi `src/agent/claude.ts`**
  - Tách [`src/agent/repoRanking.ts`](file:///home/toan/hasaki-orbit/src/agent/repoRanking.ts), [`src/agent/sessions.ts`](file:///home/toan/hasaki-orbit/src/agent/sessions.ts), chuyển `codexEnvironmentNotes` về Codex.
  - Cập nhật `src/workflow/executors/index.ts`, `src/agent/harness/*`, `src/workflow/replay.ts` và 6 file test; xóa violation `no-provider-from-core` của `executors/index.ts`.
- [x] **Bước 3 — Chuẩn hóa 5 provider về `src/agent/providers/<name>/` & cập nhật `arch:check`**
  - Chuẩn hóa 5 thư mục đối xứng dưới `src/agent/providers/{claude,codex,copilot,cursor,antigravity}/` (`index.ts`, `run.ts`, `complete.ts`, `capabilities.ts` + internal files); trích [`src/agent/completionTypes.ts`](file:///home/toan/hasaki-orbit/src/agent/completionTypes.ts) để tách vòng phụ thuộc.
  - Xóa hẳn `src/agent/claude.ts` và các thư mục provider cũ tại `src/agent/{codex,cursor,copilot,antigravity}`; cập nhật `src/workflow/replay.ts`, `src/architecture/check.ts` (bỏ `isClaudeModule`, gom cả 5 provider theo prefix `src/agent/providers/`), `test/architecture.test.ts` (10/10 pass) và toàn bộ test imports.
  - Thu nhỏ SCC lớn nhất trong [`architecture/baseline.json`](file:///home/toan/hasaki-orbit/architecture/baseline.json) từ 31 → 28 file và giảm violations từ 6 → 5.
- [x] **Bước 4 — Hợp nhất `ProviderCapabilities` & thay nhánh `provider !== "claude"` cứng**
  - Hợp nhất [`src/agent/providerCapabilities.ts`](file:///home/toan/hasaki-orbit/src/agent/providerCapabilities.ts) với `PROVIDER_CAPABILITIES: Record<AgentProvider, ProviderCapabilities>` + `providerCapabilities()` (là leaf module thuần chỉ phụ thuộc type từ `provider.ts`), đồng thời suy xuất nhất quán `providerControls`, `providerControlState`, `GUARANTEES`, `OS_ISOLATED_PROVIDERS`, `VISION_PROVIDERS`, `NATIVE_TOOL_PROVIDERS`, `guaranteeCheck`.
  - Tạo [`src/agent/providerProbes.ts`](file:///home/toan/hasaki-orbit/src/agent/providerProbes.ts) (`discoverProviderAdapter`, `probePreflightCapability`, `probeHandoffReadiness`) làm adapter probe registry thống nhất cho [`src/agent/providerStatus.ts`](file:///home/toan/hasaki-orbit/src/agent/providerStatus.ts), [`src/agent/handoff.ts`](file:///home/toan/hasaki-orbit/src/agent/handoff.ts) và [`src/agent/harness/stages/preflight.ts`](file:///home/toan/hasaki-orbit/src/agent/harness/stages/preflight.ts).
  - Thay các kiểm tra/label provider hardcode bằng `providerCapabilities()` tại [`configuration.ts`](file:///home/toan/hasaki-orbit/src/agent/configuration.ts), [`stepAgent.ts`](file:///home/toan/hasaki-orbit/src/agent/stepAgent.ts), [`complete.ts`](file:///home/toan/hasaki-orbit/src/agent/complete.ts), [`chat/runtime.ts`](file:///home/toan/hasaki-orbit/src/chat/runtime.ts), [`budget.ts`](file:///home/toan/hasaki-orbit/src/agent/harness/stages/budget.ts), [`context.ts`](file:///home/toan/hasaki-orbit/src/agent/harness/stages/context.ts), [`execute.ts`](file:///home/toan/hasaki-orbit/src/agent/harness/stages/execute.ts), [`output.ts`](file:///home/toan/hasaki-orbit/src/agent/harness/stages/output.ts), [`preflight.ts`](file:///home/toan/hasaki-orbit/src/agent/harness/stages/preflight.ts), [`workflow/engine/handoff.ts`](file:///home/toan/hasaki-orbit/src/workflow/engine/handoff.ts), [`eval/optimization.ts`](file:///home/toan/hasaki-orbit/src/eval/optimization.ts), [`workflow/profiles.ts`](file:///home/toan/hasaki-orbit/src/workflow/profiles.ts), [`workflow/recovery.ts`](file:///home/toan/hasaki-orbit/src/workflow/recovery.ts).
  - Cập nhật [`eslint.config.mjs`](file:///home/toan/hasaki-orbit/eslint.config.mjs) chuẩn hóa danh sách launcher/probe/bridge/hook theo `src/agent/providers/*/` và bổ sung unit test tại [`test/harness-guarantees.test.ts`](file:///home/toan/hasaki-orbit/test/harness-guarantees.test.ts).
- [x] **Bước 5 — Vá Security & Policy** _(Phase 2)_
  - Antigravity/Copilot: `write_file`/`edit_file` (và `create`/`edit` native của Copilot) đi qua `decide("Write"|"Edit", { file_path })`; `list_dir`/`glob`/`grep`/`search_files` đi qua [`nativeInspection.ts`](src/agent/nativeInspection.ts) → `decide("Read"|"Glob"|"Grep")` nên `secretPathViolation`, `toolBudget`, `ToolLoopDetector` có hiệu lực. Cả hai turn từ chối `policy.delegation` ngay đầu hàm (`POLICY_VIOLATION`).
  - Copilot: sửa hook thật sự (xem "Kiểm chứng CLI" bên dưới), `hookBypassDetection` kiểm tra MỌI tool, hạ `writeSandbox` về `false`, bỏ `void opts.sandbox` và `scratchDir/settings.json` mồ côi (cùng `copilotHeadlessSettings`).
  - `PROTECTED_IN_WORKTREE` thêm `.agents`, `.github/hooks` (export để test).
  - Cách ly token: Copilot (config MCP ở `scratchDir`, không chứa token), Cursor (`${env:…}`), Antigravity (file 0o600 + cleanup).
- [x] **Bước 6 — Đồng bộ Reliability, Bridge timeout, Validation & External Skills** _(Phase 2)_
  - Cursor bridge 65 s → 30 phút (+ `bridgeRpcTimeoutMs`); test khóa cả 4 bridge.
  - `cursor/copilot/antigravityComplete`: `timeoutMs` xuống `superviseSpawn` (bỏ `setTimeout` rời), lỗi mang `failure` (`completionFailure`), phân loại bằng `classifyCliError`/`normalizeProviderFailure`, lấy cả lỗi trong stream.
  - `INCOMPLETE_OUTPUT`: stream cụt có `fullText` nhưng không có result/idle không còn là success.
  - Efforts: `PROVIDER_CAPABILITIES` là nguồn duy nhất cho validate cấu hình và adapter (Copilot thêm `none`/`minimal` theo `copilot --help`).
  - External skills: `copilot: "supported"` trong manifest, doc/audit cập nhật.
  - Claude: `claudeCapabilities()` chuẩn hóa lỗi binary/auth, nối vào `providerProbes` (preflight + readiness).
- [ ] **Bước 7 — Telemetry & Chat Completion parity** _(Phase 3)_
- [ ] **Bước 8 — Dọn Claude-isms (`metrics`, `report`, `builtin.ts` PR footer, `testFailure`, `web/` UI)** _(Phase 3)_
- [ ] **Bước 9 — Kiểm thử toàn diện cuối** _(Phase 3)_

## Kết quả kiểm thử kết thúc Phase 1

- `npm run typecheck`: pass
- `npm run lint`: pass (0 errors, 0 warnings)
- `npm run arch:check`: pass (`{"files":522,"edges":2985,"cycles":5,"violations":5}` — không phát sinh cycle/violation mới, giảm violations 6 → 5, thu gọn SCC lớn nhất 31 → 28 file)
- `npm test`: 1525/1525 tests pass (59 suites, 0 failed, 0 skipped)
- Targeted integration suites (22 suites gồm `agent-arch`, `agent-configuration`, `provider-handoff`, `provider`, `codex`, `antigravity`, `step-agent`, `chat-agentic`, `chat-streaming`, `adaptive-routing`, `recovery`, `replay`, `micro`, `self-development`, `harness`, `shared-*`): 274/274 tests pass (0 failed, 0 skipped)
- `npm run build`: pass

## Phase 2 (Bước 5–6): kết quả

### Kiểm chứng CLI thực tế (máy này: Copilot 1.0.113, agy 1.5.18, Cursor agent 2026.11.13)

| Câu hỏi                                                 | Cách kiểm                                                                          | Kết quả                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Copilot có `--sandbox` thật không?                      | `copilot help sandbox`, `copilot --help`                                           | Có cơ chế MXC/bwrap nhưng chỉ cho **lệnh shell** ("built-in file edits aren't OS-sandboxed"), cần `slirp4netns`/netns (máy này thiếu `slirp4netns`), cờ `--sandbox` **không có trong `--help`**. Không kiểm chứng được tác dụng → **không hứa**.                                                                                                                         |
| Config MCP Copilot ngoài worktree?                      | `copilot -p … --additional-mcp-config @<scratch>/mcp_config.json` (gọi model thật) | Chạy được từ ngoài cwd; MCP server **kế thừa env của process CLI** (`CTP_PROBE_VAR` tới được server) ⇒ không cần token trong file.                                                                                                                                                                                                                                       |
| Hook `.github/hooks` của Copilot có chạy ở prompt mode? | hook ghi log + prompt "run ls"                                                     | **Không** nếu không có `--trust-folder`; và schema Claude-style (`PreToolUse[].hooks[]`) **không được nạp** dù có trust. Schema chạy được: `{"version":1,"hooks":{"preToolUse":[{"type":"command","bash":"…","timeoutSec":N}]}}` + `--trust-folder`. Payload camelCase (`toolName`, `toolArgs`). Hook thoát mã 2 ⇒ tool bị chặn ("Denied by preToolUse hook") — đã kiểm. |
| Sự kiện tool và hook ra cùng lúc?                       | so timestamp                                                                       | `tool.execution_start` và hook bắt đầu cùng mili-giây ⇒ kiểm `preToolUseCalls === 0` ngay khi nhận sự kiện sẽ báo sai; `hookRan()` chờ tối đa 3 s.                                                                                                                                                                                                                       |
| Copilot có `result` event?                              | đuôi stream của lần chạy thật                                                      | **Không**; kết thúc bằng `assistant.idle`. Nên `assistant.idle` được tính là hoàn tất (nếu bắt `result` thì mọi run thật đều lỗi).                                                                                                                                                                                                                                       |
| `--reasoning-effort`                                    | `copilot --help`                                                                   | `none, minimal, low, medium, high, xhigh, max`.                                                                                                                                                                                                                                                                                                                          |
| Cursor có nội suy env trong `.cursor/mcp.json`?         | chạy `agent --print` thật với `${env:CTP_PROBE_VAR}`                               | **Có** (`inline: "from-env"`) và MCP server **không** kế thừa env trực tiếp (`probe: null`) ⇒ chỉ cần tham chiếu `${env:…}`.                                                                                                                                                                                                                                             |
| Antigravity: config MCP / env?                          | `agy mcp list`, `agy -p`                                                           | **Chưa kiểm chứng**: `agy mcp list` không đọc `.agents/mcp_config.json` của workspace và máy này chưa đăng nhập (auth timeout). Giữ file trong `<cwd>/.agents`, chmod 0o600, dọn trong `finally`.                                                                                                                                                                        |

### Thay đổi `PROVIDER_CAPABILITIES`

- `copilot.guarantees.writeSandbox`: `true` → **`false`**. Hệ quả: `write_sandbox` không còn được quảng bá cho Copilot, `guaranteeCheck("copilot","coding")` vẫn không có `unmet` (không chặn step), và option `sandbox: false` không còn là "thiếu bảo đảm" của Copilot.
- `copilot.controls.efforts`: thêm `none`, `minimal` (theo CLI).
- `cursor.runtime.bridgeRpcTimeoutMs`: 65 000 → 1 800 000.
- Không đổi: `hookBypassDetection`/`preToolPolicy` của Copilot vẫn `true` — nay đúng thực tế vì hook thật sự được nạp và bypass được kiểm với mọi tool.

### Hạn chế & điểm chưa chắc

- **Copilot cần `--trust-folder`** để hook chạy; cờ này cũng nạp cấu hình của chính repo (`.github/hooks/*`, `.github/copilot/settings.json`, plugin/MCP của repo). `.github/hooks` và `.agents` đã vào `PROTECTED_IN_WORKTREE` (chỉ có tác dụng khi chạy trong sandbox) nhưng **repo độc hại có thể chạy hook của nó** ở chế độ không sandbox. Cần quyết định có chấp nhận không (xem câu hỏi bên dưới).
- Option `sandbox` của Copilot vẫn được chấp nhận trong cấu hình nhưng không còn tác dụng (xóa khỏi `controls.options` sẽ động tới UI/cấu hình đã lưu, ngoài phạm vi).
- Token Cursor nay nằm trong **env của process CLI** (shell tool của agent kế thừa được) thay vì file; hai cách lộ ra tương đương (agent đọc được cả hai), nhưng file không còn nằm trong worktree/git.
- Antigravity: token vẫn nằm trong `<cwd>/.agents/mcp_config.json` (0o600) trong thời gian turn — chưa xác minh được CLI có kế thừa env cho MCP server hay không.
- `fake-copilot.mjs` đã đổi để mô phỏng đúng CLI thật (chỉ nạp hook khi có `--trust-folder`, schema native, payload camelCase); `fake-agy.mjs` giờ phát `result` ở cuối. `agy` thật chưa kiểm chứng được là luôn phát `result` (theo `stream.ts`/protocol đã có).
- Claude: `preflightProbe` giữ `false` — bật sẽ chạy `claude auth status` cho mọi step và có thể chặn nhầm khi dùng binary bundle/`CLAUDE_CODE_OAUTH_TOKEN` (isolation enforce) hoặc CI không có binary. `claudeCapabilities()` đã sẵn sàng; bật là một dòng.
- Thứ tự TDD: test đỏ được xác nhận cho policy (Antigravity write/inspection, Copilot inspection); với các mục còn lại phần sửa được viết trước khi có test (test xanh được viết sau và đã kiểm chạy được).

### Test đã đổi vì hợp đồng đổi (không nới lỏng)

- `harness-guarantees`: ví dụ "sandbox tắt ⇒ thiếu write_sandbox" chuyển từ Copilot sang Antigravity; thêm khẳng định Copilot không quảng bá `write_sandbox`.
- `copilot.test.ts`: `validateAgentOptions` giờ chấp nhận `none`/`minimal` (đồng bộ với adapter và CLI), vẫn từ chối giá trị lạ; test workspace config/args cập nhật theo schema hook thật, config MCP ngoài worktree, `--trust-folder`.

### Kết quả kiểm thử

- `npm run typecheck`: pass; `npm run lint`: pass; `prettier --check .`: pass
- `npm run arch:check`: `{"files":524,"edges":2995,"cycles":5,"violations":5}` (không tăng)
- `npm test`: 1542/1542 pass
- Integration liên quan (33 suite: codex, antigravity, provider, provider-handoff, step-agent, agent-arch, agent-configuration, harness, shared-*, external-skills, ponytail, context-native, execution-contract-runtime, …): 430 pass, 0 fail, 2 skip
- `npm run build`: pass
