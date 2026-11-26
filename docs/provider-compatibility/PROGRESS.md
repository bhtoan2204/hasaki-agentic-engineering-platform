# Provider Compatibility Standardization Progress

> **Trạng thái hiện tại:** Đã hoàn tất **Phase 1 (Bước 2–4 — Zero Behavior Change)** — **DỪNG** chờ duyệt để chuyển sang **Phase 2 (Bước 5–6)**. Toàn bộ thay đổi đang được giữ ở trạng thái uncommitted trong working tree (cùng các thay đổi Shared Results có sẵn).

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
- [ ] **Bước 5 — Vá Security & Policy** *(Phase 2)*
- [ ] **Bước 6 — Đồng bộ Reliability, Bridge timeout, Validation & External Skills** *(Phase 2)*
- [ ] **Bước 7 — Telemetry & Chat Completion parity** *(Phase 3)*
- [ ] **Bước 8 — Dọn Claude-isms (`metrics`, `report`, `builtin.ts` PR footer, `testFailure`, `web/` UI)** *(Phase 3)*
- [ ] **Bước 9 — Kiểm thử toàn diện cuối** *(Phase 3)*

## Kết quả kiểm thử kết thúc Phase 1

- `npm run typecheck`: pass
- `npm run lint`: pass (0 errors, 0 warnings)
- `npm run arch:check`: pass (`{"files":522,"edges":2985,"cycles":5,"violations":5}` — không phát sinh cycle/violation mới, giảm violations 6 → 5, thu gọn SCC lớn nhất 31 → 28 file)
- `npm test`: 1525/1525 tests pass (59 suites, 0 failed, 0 skipped)
- Targeted integration suites (22 suites gồm `agent-arch`, `agent-configuration`, `provider-handoff`, `provider`, `codex`, `antigravity`, `step-agent`, `chat-agentic`, `chat-streaming`, `adaptive-routing`, `recovery`, `replay`, `micro`, `self-development`, `harness`, `shared-*`): 274/274 tests pass (0 failed, 0 skipped)
- `npm run build`: pass
