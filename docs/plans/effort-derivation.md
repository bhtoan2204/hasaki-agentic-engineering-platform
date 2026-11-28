# Kế hoạch kỹ thuật v2: Effort Derive Theo Ngữ Cảnh (`reasoning_effort`)

## 1. Tóm tắt & Thay đổi so với v1

### Tóm tắt

Tính năng bổ sung tầng derive `reasoning_effort` xác định (deterministic) dựa trên `(profile, role, provider)` khi step, profile/role và provider default đều chưa chỉ định effort. Giá trị tự derive bị chặn cứng bởi trần `AUTO_EFFORT_CEILING = "high"` (tuyệt đối không bao giờ sinh `"max"`), clamp **chỉ đi xuống** theo `providerCapabilities(provider).controls.efforts` (Cursor không hỗ trợ sẽ trả không derive, không throw), và với Codex sẽ clamp thêm theo catalog model trước khi persist `effective_agent`. Run cũ đã freeze `agent_configuration` giữ nguyên hành vi 100% do snapshot cũ không bật `effort_derivation`. Kế hoạch tách thành 3 PR độc lập (`PR0` sửa 3 bug/tiền đề tách commit, `PR1` thêm logic derive mặc định tắt cờ, `PR2` mở handoff/health-switch + UI + docs) và chỉ bật mặc định sau khi benchmark đạt ngưỡng.

### Thay đổi so với v1

- **Tối giản công tắc**: Bỏ `allowXhigh` và `effort_policy` trên `ProviderConfiguration`; chỉ giữ cờ env `EFFORT_DERIVATION_ENABLED` (đọc bằng `flag()` trong `src/config.ts`, mặc định `false`, không dùng `config.json`) làm công tắc rollout toàn cục lúc run-start và `agent_configuration.effort_derivation` (snapshot bất biến kèm `DEFAULT_EFFORT_MATRIX` trên run), dùng `defaults.reasoning_effort = null` tường minh làm cơ chế tắt derive per-provider.
- **Tách PR rõ ràng**: Tách `PR0` (3 commit sửa bug sẵn có ở `optimization.ts` và `complete.ts` kèm bảng audit 11 caller), `PR1` (derive core, flag TẮT), `PR2` (handoff/health-switch bỏ `reasoning_effort: null`, UI, docs).
- **Giải quyết dứt điểm 5 điểm mở v1**:
  1. Codex per-model clamp thực hiện trước khi `INSERT workflow_step_attempts` (probe ngoài `withTx` trong `beginAttempt` qua `providerProbes.ts` để tuân thủ `no-provider-from-core`).
  2. Ghim tường minh `"low"` tại các caller `completeForRun` ngắn/phụ trợ, kèm bảng audit đủ 11 caller.
  3. Handoff / health-switch bỏ hẳn key `reasoning_effort` (kể cả xóa tàn dư từ `step.agent_override`) để qua `changedProvider` và được derive lại cho provider mới.
  4. Bảng khởi điểm sửa `DEEP/agent` thành `"medium"`, giữ `DEEP/coding_agent = "high"` và `DEEP/verifier = "medium"`.
  5. Cập nhật `test/step-agent.integration.ts` (khi bật derive) sang kiểm tra `field_sources.reasoning_effort !== "step"`.
- **Bổ sung bảng chân trị** cho thứ tự ưu tiên và **bảng cổng bật mặc định** (không bịa ngưỡng số).

---

## 2. Hiện trạng

### Đã xác minh trực tiếp trong mã nguồn

- **Cấu hình & phân giải agent** ([src/agent/configuration.ts](file:///home/toan/hasaki-orbit/src/agent/configuration.ts)):
  - `ROUTING_SCOPES = ["*", "MICRO", "FAST", "STANDARD", "DEEP"]` (dòng 8), `ROUTING_ROLES = ["agent", "coding_agent", "verifier"]` (dòng 9).
  - `AgentValues.shape.reasoning_effort` là `z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).nullable().optional()` (dòng 20-23).
  - `resolveAgentValues` (dòng 274-313) duyệt 4 layer: `step` → `profile ${scope}/${role}` → `profile */${role}` → `provider default`, chọn phần tử đầu tiên có `value?.[key] !== undefined` (nên `null` chặn kế thừa).
  - `legacyAgentConfiguration()` (dòng 150-271) chỉ map `{ model }` vào `profiles` (dòng 256-265), hardcode `claude.effort: ""` (dòng 157), và ghi `defaults.reasoning_effort: old.effort || null` (dòng 244) kèm `default_sources.reasoning_effort: "legacy provider default"` khi không có env.
  - `refreshEnvironmentDefaults()` (dòng 474-511) tự động xóa key trong `defaults` nếu `default_sources[key]` là `"legacy provider default"` hoặc `"environment ..."` và giá trị mới từ `legacyAgentConfiguration()` là `undefined` (dòng 480-489).
  - `AgentConfiguration` (dòng 60-69) có `.strict()` và `version: z.literal(1)`. DB có constraint `agent_configuration->>'version' = '1'` và trigger `workflow_runs_agent_configuration_immutable` ([migrations/061_agent_configuration.sql](file:///home/toan/hasaki-orbit/migrations/061_agent_configuration.sql#L3-L17)).
- **Step resolution & Attempt immutability**:
  - [src/agent/stepAgent.ts](file:///home/toan/hasaki-orbit/src/agent/stepAgent.ts): `resolveStepAgent` (dòng 215-278) xử lý `changedProvider` (dòng 229-237: xóa `model`, `reasoning_effort`, `max_turns`, `options` của `base` trước khi spread `override`), gán `profile` (`MICRO` hoặc `merged.execution_profile ?? run.profile ?? "STANDARD"`, dòng 243-244), `role` (`step.config.independent === true ? "verifier" : step.type`, dòng 256), rồi gọi `resolveAgentValues(snapshot, provider, profile, role, explicit)` (dòng 257).
  - [src/workflow/engine/attempts.ts](file:///home/toan/hasaki-orbit/src/workflow/engine/attempts.ts): `beginAttempt` (dòng 124-238) chạy `healthyProviderSwitch(job.id, preview)` ngoài transaction (dòng 129), vào `withTx` gọi `lockRun`, `applyHealthSwitch` (dòng 185), `await resolveEffectiveAgent(c, run, step)` (dòng 186, hàm ở dòng 393-408 là `async`), rồi `INSERT INTO workflow_step_attempts (..., effective_agent)` (dòng 199-216).
  - [migrations/032_step_agent_orchestration.sql](file:///home/toan/hasaki-orbit/migrations/032_step_agent_orchestration.sql#L6-L13): trigger `immutable_attempt_agent` cấm sửa `agent_provider`, `agent_model`, `effective_agent` sau khi insert.
  - [src/agent/harness/stages/preflight.ts](file:///home/toan/hasaki-orbit/src/agent/harness/stages/preflight.ts#L44) đọc `ctx.attempt?.effective_agent ?? resolveStepAgent(ctx.run, ctx.step)!`.
- **Profiles & Complexity** ([src/workflow/profiles.ts](file:///home/toan/hasaki-orbit/src/workflow/profiles.ts)):
  - `classifyProfile` (dòng 68-227) phân loại `MICRO/FAST/STANDARD/DEEP`. `classifyComplexity` (dòng 245-301) phân loại `TRIVIAL/STANDARD/COMPLEX/HIGH_RISK`, được gọi ở [src/workflow/engine/runCreation.ts](file:///home/toan/hasaki-orbit/src/workflow/engine/runCreation.ts#L257); `runCreation.ts` dòng 265-276 từ chối `FAST`/`MICRO` với `HIGH_RISK` và kéo về `STANDARD`.
- **Provider capabilities & Codex per-model check**:
  - [src/agent/providerCapabilities.ts](file:///home/toan/hasaki-orbit/src/agent/providerCapabilities.ts#L58-L253): `controls.efforts` của `claude` `["low","medium","high","xhigh","max"]`, `codex` `["none","minimal","low","medium","high","xhigh"]`, `copilot` `["none","minimal","low","medium","high","xhigh","max"]`, `antigravity` `["low","medium","high","xhigh","max"]`, `cursor` `[]`.
  - `validateConfigurationValues` ([configuration.ts:87-93](file:///home/toan/hasaki-orbit/src/agent/configuration.ts#L87-L93)) throw nếu `reasoning_effort` truthy mà không nằm trong `controls.efforts`.
  - [src/agent/providers/codex/run.ts](file:///home/toan/hasaki-orbit/src/agent/providers/codex/run.ts#L67-L94): `codexCapabilities` và `checkModel(cap.models, input.model ?? "", input.effort ?? "")` (dòng 86) chạy sau claim (bên trong turn, ngoài ra `preflightStage` dòng 202-206 cũng gọi `probePreflightCapability` → `codexCapabilities`), fail-closed nếu model không hỗ trợ effort. [test/fixtures/fake-codex.mjs](file:///home/toan/hasaki-orbit/test/fixtures/fake-codex.mjs#L40-L44) định nghĩa `gpt-test` chỉ hỗ trợ `["low", "high"]` (không có `"medium"`).
  - [src/architecture/check.ts](file:///home/toan/hasaki-orbit/src/architecture/check.ts#L39,L193-L200): rule `no-provider-from-core` cấm `src/workflow/` và `src/eval/` import trực tiếp `src/agent/providers/<provider>/...`; mọi giao tiếp probe phải đi qua [src/agent/providerProbes.ts](file:///home/toan/hasaki-orbit/src/agent/providerProbes.ts).
- **Adaptive routing & Optimization**:
  - [src/routing/adaptive.ts](file:///home/toan/hasaki-orbit/src/routing/adaptive.ts): `keyOf` (dòng 85-86) dùng `${provider}|${model ?? ""}|${effort ?? ""}`; `loadOutcomes` (dòng 126) đọc `a.effective_agent->>'reasoning_effort'`; `decideRoute` (dòng 405-415) yêu cầu incumbent có `n_verified >= minSamples` (mặc định `10`, dòng 506).
  - [src/eval/optimization.ts](file:///home/toan/hasaki-orbit/src/eval/optimization.ts): `applyOptimizationDefaults` (dòng 66) **không có** tham số `agent_configuration`, dù `runCreation.ts:347` đã load và gọi nó ở dòng 384 → `applyAdaptiveRouting` (dòng 218-221) gọi `resolveStepAgent` không có `agent_configuration`, rơi về `legacyAgentConfiguration()`. Bộ lọc ở dòng 202-205 dùng `!c.agent?.model && !c.agent?.reasoning_effort && !c.model && !c.codex_model` (bỏ sót `null` tường minh và legacy effort keys).
- **Completion callers & Handoff**:
  - [src/agent/complete.ts:47](file:///home/toan/hasaki-orbit/src/agent/complete.ts#L47): `completionAgent()` lọc `v != null`, xóa mất `null` tường minh. Có đúng **11 chỗ gọi** `completeForRun`/`completionAgent` trong `src/` ngoài `complete.ts` (xem bảng mục 4). [src/chat/runtime.ts:677](file:///home/toan/hasaki-orbit/src/chat/runtime.ts#L677) truyền `effort: null` khi fallback; dòng 701-703 tạo `run = { agent_configuration: cfg, profile, agent_provider: admission.provider }` với `profile = routing.path === "direct" ? "FAST" : "STANDARD"`.
  - [src/workflow/engine/handoff.ts:502,739,955](file:///home/toan/hasaki-orbit/src/workflow/engine/handoff.ts#L502) và [src/workflow/engine/attempts.ts:374](file:///home/toan/hasaki-orbit/src/workflow/engine/attempts.ts#L374) đều gán `reasoning_effort: null` vào `agent_override`, ép account default và chặn derive.
  - [test/step-agent.integration.ts:140-146](file:///home/toan/hasaki-orbit/test/step-agent.integration.ts#L140-L146): override từ Claude (`reasoning_effort: "high"`) sang Codex trên run `DEEP` rồi `assert.notEqual(overridden.reasoning_effort, "high")`.
  - Runtime đọc effort tại: [claude/run.ts:235-239](file:///home/toan/hasaki-orbit/src/agent/providers/claude/run.ts#L235-L239), [codex/args.ts:121](file:///home/toan/hasaki-orbit/src/agent/providers/codex/args.ts#L121), [copilot/args.ts:114](file:///home/toan/hasaki-orbit/src/agent/providers/copilot/args.ts#L114), [antigravity/args.ts:109](file:///home/toan/hasaki-orbit/src/agent/providers/antigravity/args.ts#L109).
- **UI & Env**:
  - [web/src/AgentValueFields.tsx:361](file:///home/toan/hasaki-orbit/web/src/AgentValueFields.tsx#L361) hiển thị `value.reasoning_effort === null ? "__account__" : ...`, khiến `null` từ `legacyAgentConfiguration()` trông như đã chọn `"Account default"` nên `changedDefaultFields` ([web/src/agentConfiguration.ts:17-24](file:///home/toan/hasaki-orbit/web/src/agentConfiguration.ts#L17-L24)) không phát hiện thay đổi khi người dùng muốn giữ account default.
  - UI i18n dùng `shared/i18n/catalog/*.ts` (vd [shared/i18n/catalog/set.ts](file:///home/toan/hasaki-orbit/shared/i18n/catalog/set.ts)). Biến env chuẩn khai báo trong [src/config.ts](file:///home/toan/hasaki-orbit/src/config.ts), [.env.example](file:///home/toan/hasaki-orbit/.env.example) và kiểm kê tại [docs/audits/env-inventory.md](file:///home/toan/hasaki-orbit/docs/audits/env-inventory.md) (chú thích dòng 3 chỉ liệt kê env đọc _ngoài_ `src/config.ts`).

### Chưa xác minh

- Số liệu production thực tế trong Postgres (`workflow_step_attempts`, phân bố `profile` và `reasoning_effort`, token/cost/verified baseline).
- Tập `supportedEffortLevels` / `supported_reasoning_levels` thực tế của các model production trên worker live (ngoài fixture `gpt-test` và static `providerCapabilities`).

---

## 3. Thiết kế

### Vị trí đặt layer và chữ ký hàm

- Tách module thuần mới `src/agent/effortDerivation.ts` (chỉ import leaf `provider.ts` và `providerCapabilities.ts` → không tạo cycle `no-circular`).
- Logic derive chạy **bên trong `resolveAgentValues`** ([configuration.ts](file:///home/toan/hasaki-orbit/src/agent/configuration.ts)) sau khi đã kiểm tra hết 4 layer tường minh (`step`, `profile scope/role`, `profile */role`, `provider default`), và **chỉ chạy** khi tất cả 4 layer đều `undefined` đồng thời `document.effort_derivation?.mode === "auto"`.
- Chữ ký chính (Phase 1 không thay đổi chữ ký công khai của `resolveStepAgent(run, step)`):
  - Trong `src/agent/effortDerivation.ts`:
    - `export const EFFORT_LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;`
    - `export const AUTO_EFFORT_CEILING = "high" as const;`
    - `export type DerivedEffort = "none" | "minimal" | "low" | "medium" | "high";` (type an toàn, không chứa `"xhigh"`/`"max"` ở đường mặc định)
    - `export type EffortMatrix = Partial<Record<RoutingScope, Partial<Record<RoutingRole, EffortValue>>>>;`
    - `export function deriveReasoningEffort(input: { provider: AgentProvider; scope: string; role: string; config?: EffortDerivationConfig; modelEfforts?: readonly string[] | null }): { value: EffortValue; source: string } | null`
  - Mở rộng tùy chọn tham số nội bộ cuối của `resolveAgentValues` và `resolveStepAgent` (default `undefined` để tương thích mọi caller hiện tại):
    - `resolveAgentValues(document, provider, scope, role, explicit = {}, opts?: { modelEfforts?: readonly string[] | null })`
    - `resolveStepAgent(run, step, opts?: { modelEfforts?: readonly string[] | null })`
  - Lưu ý quan trọng: vì `modelEfforts` chỉ biết **sau khi** đã phân giải `provider` và `model`, trong `resolveAgentValues` ta phân giải `model` trước trong vòng lặp, sau đó phân giải `reasoning_effort` (khi rơi vào nhánh derive thì truyền `opts?.modelEfforts` vào `deriveReasoningEffort`).

### Ma trận khởi điểm & Snapshot lúc Run-Start

Đặt duy nhất tại `DEFAULT_EFFORT_MATRIX` trong `src/agent/effortDerivation.ts` (không rải `if/else` ở nơi khác; `"*"` dùng mức tương đương `STANDARD` để preview tab `*` và fallback `scope` rỗng/lạ hoạt động nhất quán):

| Role \ Scope   | `*`      | `MICRO` | `FAST`   | `STANDARD` | `DEEP`   |
| -------------- | -------- | ------- | -------- | ---------- | -------- |
| `agent`        | `medium` | `low`   | `low`    | `medium`   | `medium` |
| `coding_agent` | `medium` | `low`   | `medium` | `medium`   | `high`   |
| `verifier`     | `medium` | `low`   | `low`    | `medium`   | `medium` |

- Cấu hình chỉ qua env (không dùng `config.json`): thêm `config.agent.effortDerivation: { enabled: boolean }` trong `src/config.ts`, đọc `EFFORT_DERIVATION_ENABLED` bằng helper `flag()` (cùng kiểu với `CODEACT_ENABLED`, `LSP_ENABLED`, mặc định `false`). Bỏ hoàn toàn việc override `matrix` qua config — operator muốn ép effort cho một profile dùng `AgentSettings` (layer `profile` luôn thắng derive). Khi tạo snapshot tại `startRun` / `loadAgentConfiguration()`, snapshot `DEFAULT_EFFORT_MATRIX` vào `agent_configuration.effort_derivation` (khi `enabled === true`), để việc đổi bảng mặc định ở lần deploy sau không làm run đang chạy đổi hành vi.

### Trần cứng & Quy tắc Clamp

1. **Trần cứng (`AUTO_EFFORT_CEILING = "high"`)**:
   - Mọi giá trị lấy từ `DEFAULT_EFFORT_MATRIX` (kể cả `matrix` trong snapshot `agent_configuration.effort_derivation`) đều đi qua `capToCeiling(effort)`: nếu `rank(effort) > rank("high")` thì hạ về `"high"`.
   - Post-condition check cuối hàm: `if (result === "max") result = AUTO_EFFORT_CEILING;` — bảo đảm không có bất kỳ nhánh code nào tự sinh `"max"`.
2. **Clamp theo `providerCapabilities(provider).controls.efforts`** (chỉ đi xuống, không nhảy lên):
   - Nếu `controls.efforts.length === 0` (Cursor) → trả `null` ngay, không gán `values.reasoning_effort`, không throw.
   - Nếu `controls.efforts.includes(capped)` → giữ `capped`.
   - Ngược lại, chọn phần tử có `rank` lớn nhất trong `controls.efforts` thỏa `rank < rank(capped)`. Nếu không có phần tử nào `<= rank(capped)` → trả `null` (không nhảy lên mức cao hơn), không throw.
3. **Clamp theo catalog model Codex trước khi persist `effective_agent`**:
   - Chỉ áp dụng khi nguồn effort là `auto:` (giá trị tường minh của user vẫn giữ nguyên để `checkModel` fail-closed như hiện nay).
   - Tại `beginAttempt` ([attempts.ts](file:///home/toan/hasaki-orbit/src/workflow/engine/attempts.ts)), ngay sau `healthyProviderSwitch` và **TRƯỚC `withTx`**:
     1. Preview cấu hình dự kiến từ `preview` (`applyHealthSwitch` nếu có).
     2. Nếu provider là `"codex"` và `preview.agent_configuration?.effort_derivation?.mode === "auto"`, gọi `await probeModelEfforts("codex", resolvedModel)` qua [providerProbes.ts](file:///home/toan/hasaki-orbit/src/agent/providerProbes.ts) (tận dụng cache 5 phút của `codexCapabilities` trong `codex/capabilities.ts`, không giữ lock Postgres khi spawn CLI).
     3. Truyền `modelEfforts` vào `resolveEffectiveAgent` → `resolveStepAgent(..., { modelEfforts })` bên trong `withTx` (không I/O trong transaction!).
     4. Trong `deriveReasoningEffort`: nếu `modelEfforts?.length` được cung cấp và không chứa giá trị đã clamp theo provider, clamp **đi xuống** một lần nữa theo `modelEfforts` (vd `gpt-test` chỉ có `["low","high"]` thì `"medium"` → `"low"`). Nếu không có mức nào `<=`, trả `null` (không set effort, để model dùng `default_reasoning_level`).
     5. Nếu `probeModelEfforts` không lấy được catalog (CLI lỗi/timeout), `modelEfforts` là `null` → chỉ clamp theo provider và giữ `checkModel` fail-closed ở preflight/turn như cũ.
   - Nhờ thực hiện trước `INSERT INTO workflow_step_attempts`, `effective_agent->>'reasoning_effort'` được persist chuẩn xác ngay từ đầu và khớp với trigger bất biến ở `migrations/032`.

### Ghi `field_sources.reasoning_effort`

- Giá trị tự derive ghi `` `auto: profile ${scope}/${role}` ``; nếu có hạ trần hoặc clamp theo provider/model ghi thêm chi tiết, vd: `` `auto: profile ${scope}/${role} (clamped to ${final})` ``.
- Khi Cursor hoặc không đủ mức thấp hơn để clamp: `values.reasoning_effort` không được gán (`undefined`), `sources.reasoning_effort` giữ `"account/CLI default (external)"`.

### Tối giản công tắc (mục 4c)

- **Giữ cờ env `EFFORT_DERIVATION_ENABLED`** (đọc bằng `flag("EFFORT_DERIVATION_ENABLED", false)` trong `src/config.ts`, chỉ cấu hình qua env, không dùng `config.json`, đọc lúc `run-start` và `loadAgentConfiguration()`): là kill-switch rollout ở cấp deployment, bật/tắt không cần sửa DB `settings`.
- **Giữ `agent_configuration.effort_derivation.mode`** (`"auto" | "off"` hoặc chỉ ghi object `{ mode: "auto", matrix }` với `DEFAULT_EFFORT_MATRIX` vào snapshot khi `enabled === true`): lưu trạng thái bất biến của cờ bật và bảng mặc định tại thời điểm tạo run. Nhờ vậy run tạo trước khi bật cờ (không có `effort_derivation`), run tạo khi tắt cờ, hay run đang chạy khi deploy thay đổi `DEFAULT_EFFORT_MATRIX` không bao giờ đổi hành vi giữa chừng.
- **Bỏ `allow_xhigh` ở Phase 1**: vì người dùng cần `xhigh` đã có thể cấu hình trực tiếp ở `profiles` trong `AgentSettings`; chưa cần thêm cờ opt-in khi ma trận mặc định chỉ dùng `low/medium/high` (có thể bổ sung ở Phase 2 nếu benchmark chứng minh cần).
- **Bỏ `effort_policy` trên `ProviderConfiguration`**: thừa vì theo bất biến bảng chân trị bên dưới, `defaults.reasoning_effort = null` (tường minh) đã giải quyết trọn vẹn nhu cầu "tắt derive riêng cho provider này, dùng account default". Việc bỏ `effort_policy` giúp tránh thêm field schema và thêm dropdown gây nhiễu trên UI `AgentSettings`.

### Bảng chân trị cho thứ tự ưu tiên (mục 4b)

_(Ghi chú: cột `policy` từ v1 đã hợp nhất vào trạng thái `provider default = null tường minh` theo quyết định tối giản ở mục 4c; `defaults.reasoning_effort` từ env `CODEX_REASONING_EFFORT` / `AGY_EFFORT` / `COPILOT_EFFORT` được coi là `provider default` có giá trị tường minh)._

| `step` (`explicit`) | `profile layer` (`scope/role` → `*/role`) | `provider default` (`entry.defaults`)  | `mode` (`effort_derivation`) | Provider có `efforts`? | Kết quả `values.reasoning_effort` | `field_sources.reasoning_effort`                               |
| ------------------- | ----------------------------------------- | -------------------------------------- | ---------------------------- | ---------------------- | --------------------------------- | -------------------------------------------------------------- |
| `V` (kể cả `null`)  | bất kỳ                                    | bất kỳ                                 | bất kỳ                       | Có (hoặc `null`)       | `V`                               | `"step"`                                                       |
| `undefined`         | `P` (kể cả `null`)                        | bất kỳ                                 | bất kỳ                       | Có (hoặc `null`)       | `P`                               | `"profile ${scope}/${role}"` hoặc `"profile */${role}"`        |
| `undefined`         | `undefined`                               | `D` (giá trị tường minh / env)         | bất kỳ                       | Có                     | `D`                               | `entry.default_sources.reasoning_effort ?? "provider default"` |
| `undefined`         | `undefined`                               | `null` tường minh (`provider default`) | bất kỳ                       | Có / Không             | `null`                            | `entry.default_sources.reasoning_effort ?? "provider default"` |
| `undefined`         | `undefined`                               | `undefined` (đã dọn `legacy null`)     | `"off"` / vắng (run cũ)      | Có / Không             | không gán (`undefined`)           | `"account/CLI default (external)"`                             |
| `undefined`         | `undefined`                               | `undefined`                            | `"auto"`                     | **Không** (Cursor)     | không gán (`undefined`)           | `"account/CLI default (external)"`                             |
| `undefined`         | `undefined`                               | `undefined`                            | `"auto"`                     | **Có**                 | `derived` (qua trần + clamp)      | `"auto: profile ${scope}/${role}"`                             |

_(Kiểm chứng bất biến: mọi giá trị tường minh kể cả `null` ở `step`, `profile`, `provider default` đều thắng derive; derive chỉ chạy khi cả 3 tầng trên đều `undefined` và `mode === "auto"`; provider không có `efforts` không bao giờ derive; `V`/`P`/`D` không hợp lệ trên Cursor vẫn fail-closed ở `validateConfigurationValues` trừ `null`)_

---

## 4. Quyết định thiết kế

### Quyết định A: Ngữ nghĩa của `null` vs `undefined`

- **Chọn (A3 rút gọn)**: Đổi `legacyAgentConfiguration()` ([configuration.ts:244](file:///home/toan/hasaki-orbit/src/agent/configuration.ts#L244)) chỉ ghi `defaults.reasoning_effort` khi `old.effort` khác rỗng (ngược lại để `undefined`, giữ `default_sources: "legacy provider default"`). Kết hợp `refreshEnvironmentDefaults()` (dòng 480-489) để tự động dọn `null` cũ chưa từng sửa trong `settings` thành `undefined`. Operator muốn ép account default cho cả provider chỉ cần chọn `"Model/Account default"` (`null`, ghi `default_sources: "provider default"`).
- **Đã loại**:
  - _A1 (chỉ suy luận từ chuỗi `default_sources === "legacy provider default"`)_: Loại vì dính bug UX ở `AgentValueFields.tsx:361` (hiển thị sẵn `"__account__"` nên người dùng không tạo được diff trong `changedDefaultFields`) và lệ thuộc chuỗi metadata thay vì cấu trúc dữ liệu.
  - _A2 mở rộng kèm `effort_policy` trên `ProviderConfiguration`_: Loại `effort_policy` vì trùng chức năng với `defaults.reasoning_effort = null` tường minh.

### Quyết định B: Tương tác với Adaptive Routing

- **Chấp nhận cold-start (không alias sang `effort = null`)**: Khi derive bật, `incumbent.effort` đổi từ `null` sang giá trị derive, nên các `coding_agent` route trên `adaptive.ts` sẽ trả `insufficient evidence; existing defaults kept` cho tới khi `(provider, model, derived_effort)` có đủ `min_samples` (mặc định 10).
- **Đã loại**: Proxy/gộp mẫu `effort = null` vào `derived_effort`. Lý do: thay đổi effort làm thay đổi chất lượng và chi phí thật; gộp mẫu cũ làm sai lệch kiểm định non-inferiority (`decideRoute` dòng 418-446), dễ switch nhầm về cấu hình kém hơn.
- **Sửa song song (PR0)**: Truyền `agent_configuration` từ `runCreation.ts:384` vào `applyOptimizationDefaults` → `applyAdaptiveRouting` (sửa bug incumbent bị tính từ `legacyAgentConfiguration()`) và sửa filter `optimization.ts:202-205` từ `!c.agent?.reasoning_effort` sang `=== undefined` + chặn legacy keys trên step.

### Quyết định 3.1: Codex theo từng model trước khi persist `effective_agent`

- **Chọn**: Probe `probeModelEfforts("codex", model)` ở `beginAttempt` **trước `withTx`** (cùng tầng `healthyProviderSwitch`), dùng cache 5 phút của `codexCapabilities`, rồi truyền `modelEfforts` vào `resolveEffectiveAgent` → `resolveStepAgent` để clamp xuống trước khi `INSERT workflow_step_attempts`.
- **Đã loại**: Clamp muộn ở `codex/run.ts` (vì trigger `immutable_attempt_agent` ở `migrations/032` cấm sửa `effective_agent` sau insert, làm sai telemetry của `adaptive.ts`); hoặc gọi CLI bên trong `withTx` của `resolveEffectiveAgent` (vì giữ `lockRun` trong khi chờ subprocess CLI tới 30s).

### Quyết định 3.2: Audit 11 caller của `completeForRun` / `completionAgent`

_(Ghi chú: ở `PR0 (iii)`, sửa `completionAgent()` trong [complete.ts:47](file:///home/toan/hasaki-orbit/src/agent/complete.ts#L47) từ `v != null` thành `v !== undefined` đồng thời cập nhật `chat/runtime.ts` và `chat/title.ts` để `null` chỉ gửi khi chủ ý ép account default; ở `PR1`, ghim effort bằng helper an toàn theo `providerCapabilities` để không throw với Cursor)._

| #   | Vị trí gọi (`file:line`)                                                                                                                  | Ngữ cảnh / Run truyền vào                                                                  | Quyết định cho PR1                                                                  | Lý do                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [runCreation.ts:254](file:///home/toan/hasaki-orbit/src/workflow/engine/runCreation.ts#L254) (`classifyWithFallback`)                     | `{ agent_provider }`, không `profile` (mặc định `STANDARD`), timeout `5000ms`              | **Ghim `"low"`** (nếu provider hỗ trợ)                                              | Tác vụ phân loại JSON nhỏ với timeout cứng 5s; tránh `medium` làm timeout                                                                                                                                                                 |
| 2   | [report/executor.ts:76](file:///home/toan/hasaki-orbit/src/report/executor.ts#L76) (`workflowReportReasoner`)                             | `ctx.run`, `ctx.signal`                                                                    | **Giữ derive** (theo `ctx.run.profile`)                                             | Tổng hợp evidence tới 120k ký tự; `FAST/MICRO=low`, `STANDARD/DEEP=medium` hợp lý                                                                                                                                                         |
| 3   | [testFailure.ts:335](file:///home/toan/hasaki-orbit/src/workflow/executors/testFailure.ts#L335) (`askProvider` cho `explain`/`interpret`) | `{ ...(ctx?.run ?? {}), agent_provider }` (`explain`/`interpret` truyền `ctx = undefined`) | **Ghim `"low"`** (nếu provider hỗ trợ)                                              | Giải thích/diễn giải ngắn gọn trong 5 câu hoặc 5 enum; tránh mặc định `STANDARD=medium`                                                                                                                                                   |
| 4   | [executors/index.ts:51](file:///home/toan/hasaki-orbit/src/workflow/executors/index.ts#L51) (`setFeedbackModel` → `reexecution.ts:340`)   | `run` từ `classifyRunFeedback`                                                             | **Ghim `"low"`** (nếu provider hỗ trợ)                                              | Chỉ phân loại 1 message feedback ngắn vào JSON route, có heuristic fallback                                                                                                                                                               |
| 5   | [executors/index.ts:52](file:///home/toan/hasaki-orbit/src/workflow/executors/index.ts#L52) (`setMergeModel` → `branchMerge.ts:309`)      | `ctx.run`, `ctx.signal`                                                                    | **Giữ derive** (theo `ctx.run.profile`)                                             | Giải xung đột Git merge thật trên mã nguồn; task `STANDARD/DEEP` cần `medium`                                                                                                                                                             |
| 6   | [learningModel.ts:16](file:///home/toan/hasaki-orbit/src/agent/learningModel.ts#L16) (`modelChangeAnalyzer` → `learning.ts:569`)          | `run` từ DB trong `detectKnowledgeChanges`                                                 | **Giữ derive theo `run.profile`**                                                   | Validator trong `knowledge/learning.ts` bắt trích dẫn bịa (precision) nhưng không bắt rule bị bỏ sót (recall); effort thấp làm hỏng recall im lặng. Khối lượng thấp (cần human source, qua cổng `config.learning.*`, benchmark không gọi) |
| 7   | [learningModel.ts:19](file:///home/toan/hasaki-orbit/src/agent/learningModel.ts#L19) (`modelSkillDrafter` → `learning.ts:762`)            | `run` từ `source_run_id`                                                                   | **Giữ derive theo `run.profile`**                                                   | Tương tự `modelChangeAnalyzer`: effort thấp làm hỏng recall im lặng (`validateSkillUpdate` không bắt thiếu ý); khối lượng thấp nên chi phí nhỏ                                                                                            |
| 8   | [repoRanking.ts:48](file:///home/toan/hasaki-orbit/src/agent/repoRanking.ts#L48) (`rankRepositories`)                                     | `ctx.run`, `ctx.signal`                                                                    | **Ghim `"low"`** (nếu provider hỗ trợ)                                              | Chỉ chạy ở `DEEP` (`use_ai=true`) để chấm điểm 0–10 danh sách repo từ metadata                                                                                                                                                            |
| 9   | [chat/title.ts:109](file:///home/toan/hasaki-orbit/src/chat/title.ts#L109) (`runTitleCompletion`)                                         | `null`, `{ provider, model, reasoning_effort: opts.effort ?? "low" }`                      | **Giữ ghim `"low"`** (+ sửa `model: opts.model ?? undefined`, bỏ effort nếu Cursor) | Sinh tiêu đề 3–7 từ, đã ghim `"low"`; vá lỗi `model: null` khi giữ `null` ở `complete.ts`                                                                                                                                                 |
| 10  | [chat/runtime.ts:703](file:///home/toan/hasaki-orbit/src/chat/runtime.ts#L703) (`completionAgent`)                                        | `{ agent_configuration: cfg, profile: FAST\|STANDARD, agent_provider }`                    | **Giữ derive khi `effort_strategy === "auto"`**                                     | Tính cấu hình thực thi/hiển thị cho chat turn (`direct→FAST`, `tools→STANDARD`)                                                                                                                                                           |
| 11  | [chat/runtime.ts:907](file:///home/toan/hasaki-orbit/src/chat/runtime.ts#L907) (`completeForRun`)                                         | Cùng `run` và `agent` với #10                                                              | **Giữ derive khi `effort_strategy === "auto"`**                                     | Thực thi turn chat đồng bộ với #10; chỉ truyền `null` khi `effort_strategy === "provider_default"`                                                                                                                                        |

### Quyết định 3.3: Handoff & Health-switch

- **Chọn**: Ở cả 4 chỗ ([handoff.ts:502,739,955](file:///home/toan/hasaki-orbit/src/workflow/engine/handoff.ts#L502) và [attempts.ts:374](file:///home/toan/hasaki-orbit/src/workflow/engine/attempts.ts#L374)), **bỏ hẳn key `reasoning_effort`** (destructure loại bỏ `reasoning_effort` cũ khỏi `step.agent_override` trước khi lưu, không gán `null`).
- **Đường đi qua `changedProvider` trong [stepAgent.ts:229-237](file:///home/toan/hasaki-orbit/src/agent/stepAgent.ts#L229-L237)**:
  - Khi `override.provider` khác `base.provider ?? agentProvider(run)`, `changedProvider` là `true` → `{ model: undefined, reasoning_effort: undefined, max_turns: undefined, options: undefined }` xóa `reasoning_effort` ở `base` (`step.config.agent`).
  - Sau đó spread `...override`: vì `override` đã xóa `reasoning_effort`, `merged.reasoning_effort` vẫn là `undefined` (không bị tàn dư của provider cũ từ `step.agent_override` đè lên) → `resolveAgentValues` đi vào tầng `profile` / `[derived]` và tự clamp theo capability của provider mới.
  - Khi fallback ngược về đúng `base.provider` ban đầu (`changedProvider === false`), `base.reasoning_effort` vốn cấu hình cho provider gốc được khôi phục hợp lệ.
  - Lưu ý `handoff.ts:743`: `resumeProviderHandoff` (dòng 498) và `assertAgentUnchanged` (dòng 735) phải dựng cùng một object `override` y hệt nhau để `JSON.stringify(effective) === JSON.stringify(candidate)`.
- **Đã loại**: Giữ `reasoning_effort: null` (vì chặn derive khiến mọi step sau handoff rơi về account default).

### Quyết định 3.4: Bảng khởi điểm

- **Chọn**: `DEEP/agent = "medium"`, `DEEP/coding_agent = "high"`, `DEEP/verifier = "medium"`, các ô còn lại theo bảng v1. Đây là **giả thuyết khởi điểm**, chưa bật mặc định cho tới khi benchmark kiểm chứng (xem mục 7).
- **Đã loại**: Đặt `DEEP/agent = "high"` (tốn token/latency cho cả bước đọc/tổng hợp) hoặc đặt `"xhigh"` mặc định.

### Quyết định 3.5: Test `test/step-agent.integration.ts:140-146`

- **Chọn**: Khi cờ derive TẮT (`PR1`), giữ nguyên test hiện tại (`assert.notEqual(overridden.reasoning_effort, "high")`). Khi cờ derive BẬT, đổi assertion sang `assert.notEqual(overridden.field_sources?.reasoning_effort, "step")` (và kiểm tra `overridden.field_sources?.reasoning_effort` bắt đầu bằng `"auto:"` hoặc là provider/account default), giữ đúng mục đích test là chứng minh effort tường minh của Claude không rò sang Codex.

---

## 5. Phân PR

Mỗi PR dưới đây có thể review và `git revert` độc lập:

### PR0 — Tiền đề & sửa bug sẵn có (3 commit tách biệt, mỗi commit có unit/integration test)

1. **Commit 1 (`(i)` Truyền `agent_configuration` vào optimization/adaptive routing)**:
   - _Files_: [src/workflow/engine/runCreation.ts](file:///home/toan/hasaki-orbit/src/workflow/engine/runCreation.ts), [src/eval/optimization.ts](file:///home/toan/hasaki-orbit/src/eval/optimization.ts).
   - _Thay đổi_: Thêm tham số `agentConfiguration?: AgentConfiguration` vào `applyOptimizationDefaults` → `applyAdaptiveRouting`, truyền `agent_configuration` từ `runCreation.ts:384`, và truyền vào 3 chỗ gọi `resolveStepAgent` trong `optimization.ts` (dòng 144, 218, 260).
   - _Tác động production khi merge_: **CÓ THỂ ĐỔI hành vi production ngay khi merge** với owner đã bật Adaptive Routing và có cấu hình `AgentSettings` khác mặc định legacy (vì `incumbent` trong `decideRoute` sẽ lấy đúng model/effort từ DB snapshot thay vì `legacyAgentConfiguration()`).
   - _Test_: Thêm test trong `test/adaptive-routing.test.ts` / `test/agent-configuration.integration.ts` chứng minh `applyAdaptiveRouting` dùng `agent_configuration` thay vì legacy.
2. **Commit 2 (`(ii)` Vá filter trong `applyAdaptiveRouting`)**:
   - _File_: [src/eval/optimization.ts](file:///home/toan/hasaki-orbit/src/eval/optimization.ts#L196-L209).
   - _Thay đổi_: Đổi `!c.agent?.model && !c.agent?.reasoning_effort` thành `c.agent?.model === undefined && c.agent?.reasoning_effort === undefined`, đồng thời loại step có bất kỳ legacy key nào (`c.model`, `c.codex_model`, `c.cursor_model`, `c.antigravity_model`, `c.copilot_model`, `c.codex_reasoning_effort`, `c.copilot_effort`, `c.antigravity_effort`, `c.effort`).
   - _Tác động production khi merge_: **CÓ THỂ ĐỔI hành vi production ngay khi merge** chỉ đối với workflow definition có ghi tường minh `agent: { model: null }` / `agent: { reasoning_effort: null }` hoặc dùng legacy effort key trên step (đúng thiết kế: không bị adaptive routing ghi đè). Workflow thường không đổi.
   - _Test_: Unit test kiểm tra filter giữ step `{}` và loại step `{ reasoning_effort: null }` / `{ codex_reasoning_effort: "low" }`.
3. **Commit 3 (`(iii)` `completionAgent` bảo toàn `null` & tách strategy của chat/title)**:
   - _Files_: [src/agent/complete.ts](file:///home/toan/hasaki-orbit/src/agent/complete.ts#L47), [src/chat/runtime.ts](file:///home/toan/hasaki-orbit/src/chat/runtime.ts#L696-L703), [src/chat/title.ts](file:///home/toan/hasaki-orbit/src/chat/title.ts#L109-L113), [test/agent-configuration.test.ts](file:///home/toan/hasaki-orbit/test/agent-configuration.test.ts).
   - _Thay đổi_: `completionAgent` lọc `v !== undefined` thay vì `v != null`. Cập nhật `chat/runtime.ts` truyền `model: admission.model ?? undefined` (trừ khi `conversation.model_strategy === "provider_default"` giữ `null`) và `reasoning_effort`: nếu `admission.effort != null` thì dùng giá trị đó, nếu `conversation.effort_strategy === "provider_default"` truyền `null`, ngược lại truyền `undefined`; cập nhật `chat/title.ts` truyền `model: opts.model ?? undefined`. (Ghi chú: 8 caller workflow còn lại truyền `agent = {}` mặc định nên không bị ảnh hưởng).
   - _Tác động production khi merge_: **ĐỔI nhẹ ở Chat khi user chọn `effort_strategy === "provider_default"` hoặc `model_strategy === "provider_default"`** (từ chỗ bị strip `null` sang giữ đúng `null` ép account default); các caller workflow và chat `auto`/`manual` **KHÔNG ĐỔI** hành vi.
   - _Test_: Unit test `completionAgent` giữ `{ reasoning_effort: null }` (không bị xóa) và test chat `provider_default` vs `auto`.

- _Revert PR0_: `git revert` từng commit hoặc cả 3 commit không ảnh hưởng schema DB hay API contract.

### PR1 — Tính năng Effort Derive (mặc định cờ TẮT)

- _Files_:
  - `src/agent/effortDerivation.ts` (mới): `EFFORT_LADDER`, `AUTO_EFFORT_CEILING = "high"`, `DEFAULT_EFFORT_MATRIX`, `deriveReasoningEffort`, `pinEffortIfSupported`.
  - [src/config.ts](file:///home/toan/hasaki-orbit/src/config.ts): thêm `config.agent.effortDerivation` (`enabled: flag("EFFORT_DERIVATION_ENABLED", false)`, chỉ đọc qua env, không dùng `config.json` hay override `matrix`).
  - [.env.example](file:///home/toan/hasaki-orbit/.env.example): thêm 1 dòng comment ghi nhận `EFFORT_DERIVATION_ENABLED` (mặc định `false`). **Không sửa** `docs/audits/env-inventory.md` vì file đó chỉ kiểm kê biến env đọc ngoài `src/config.ts`.
  - [src/agent/configuration.ts](file:///home/toan/hasaki-orbit/src/agent/configuration.ts): thêm `effort_derivation` optional trên `AgentConfiguration` (giữ `version: 1`), bỏ `old.effort || null` khi rỗng trong `legacyAgentConfiguration()`, tích hợp `deriveReasoningEffort` và `field_sources` trong `resolveAgentValues`.
  - [src/agent/configurationStore.ts](file:///home/toan/hasaki-orbit/src/agent/configurationStore.ts): đồng bộ `effort_derivation` (`{ mode: "auto", matrix: DEFAULT_EFFORT_MATRIX }` khi `enabled === true`) vào `loadAgentConfiguration()` cho cấu hình hiện hành (không sửa snapshot run cũ).
  - [src/agent/stepAgent.ts](file:///home/toan/hasaki-orbit/src/agent/stepAgent.ts): truyền `opts?.modelEfforts` xuống `resolveAgentValues`.
  - [src/agent/providerProbes.ts](file:///home/toan/hasaki-orbit/src/agent/providerProbes.ts) & [src/agent/providers/codex/capabilities.ts](file:///home/toan/hasaki-orbit/src/agent/providers/codex/capabilities.ts): thêm `probeModelEfforts(provider, model)` đọc/chia sẻ cache catalog 5 phút.
  - [src/workflow/engine/attempts.ts](file:///home/toan/hasaki-orbit/src/workflow/engine/attempts.ts): gọi `probeModelEfforts` ngoài `withTx` trong `beginAttempt` rồi truyền vào `resolveEffectiveAgent` → `resolveStepAgent`.
  - [src/workflow/engine/runCreation.ts](file:///home/toan/hasaki-orbit/src/workflow/engine/runCreation.ts) & [src/workflow/engine/decisions.ts](file:///home/toan/hasaki-orbit/src/workflow/engine/decisions.ts): chụp `effort_derivation` (khi `enabled === true`, gồm `DEFAULT_EFFORT_MATRIX`) lúc `run-start` và `authorized-recovery`; ghim `"low"` cho `classifyWithFallback` qua `pinEffortIfSupported`.
  - Các caller ghim `"low"` theo bảng audit mục 3.2: [testFailure.ts](file:///home/toan/hasaki-orbit/src/workflow/executors/testFailure.ts), [executors/index.ts](file:///home/toan/hasaki-orbit/src/workflow/executors/index.ts) (`setFeedbackModel`), [repoRanking.ts](file:///home/toan/hasaki-orbit/src/agent/repoRanking.ts), [chat/title.ts](file:///home/toan/hasaki-orbit/src/chat/title.ts) (guard Cursor). (Lưu ý: [learningModel.ts](file:///home/toan/hasaki-orbit/src/agent/learningModel.ts) giữ derive theo `run.profile`).
- _Test_: Unit + Integration toàn bộ mục 6 (chạy cả chế độ cờ tắt mặc định và cờ bật trong test).
- _Rủi ro & Revert_: Cờ mặc định `false` nên merge vào `main` an toàn tuyệt đối (kể cả `legacyAgentConfiguration()` bỏ `null` khi rỗng: với `mode` vắng/off, `defaults.reasoning_effort = undefined` cho kết quả external CLI default giống `null`, trừ khi có caller test cũ inspect trực tiếp field `defaults.reasoning_effort === null` — đã kiểm tra `test/agent-configuration.test.ts` chỉ kiểm tra `null` khi gán tay). Revert PR1 hoặc set `EFFORT_DERIVATION_ENABLED=0` trả hệ thống về nguyên trạng.

### PR2 — Handoff / Health-switch, UI `AgentSettings` & Tài liệu

- _Files_:
  - [src/workflow/engine/handoff.ts](file:///home/toan/hasaki-orbit/src/workflow/engine/handoff.ts#L498-L504,L735-L744,L953-L956) & [src/workflow/engine/attempts.ts:370-375](file:///home/toan/hasaki-orbit/src/workflow/engine/attempts.ts#L370-L375): bỏ gán `reasoning_effort: null` và xóa tàn dư `reasoning_effort` từ `step.agent_override` khi chuyển provider.
  - [web/src/pages/AgentSettings.tsx](file:///home/toan/hasaki-orbit/web/src/pages/AgentSettings.tsx) & [shared/i18n/catalog/set.ts](file:///home/toan/hasaki-orbit/shared/i18n/catalog/set.ts) (cả `vi` và `en`): hiển thị pill/nhãn phân biệt giá trị tự derive (`auto: profile ...`) với `CLI default only`, cập nhật mô tả `set.modelRoutingLead` phản ánh tầng auto-derive khi bật.
  - [test/step-agent.integration.ts](file:///home/toan/hasaki-orbit/test/step-agent.integration.ts) & [test/provider-handoff.integration.ts](file:///home/toan/hasaki-orbit/test/provider-handoff.integration.ts): test handoff/health-switch nhận derived effort theo provider mới và sửa assert dòng 146 khi bật cờ derive.
- _Rủi ro & Revert_: Nếu provider đích khi handoff không tương thích effort tự derive (vd model hiếm không nằm trong cache), preflight fail-closed. Revert PR2 độc lập chỉ khôi phục lại hành vi ép `null` lúc handoff và nhãn UI cũ.

---

## 6. Kế hoạch test

- **Unit tests** (`test/agent-configuration.test.ts` và `test/effort-derivation.test.ts` mới):
  1. **Trần cứng không bao giờ sinh `max`**: mọi tổ hợp `(scope × role × provider)` với `DEFAULT_EFFORT_MATRIX` và với tham số `matrix` giả lập cố đặt `"max"` hoặc `"xhigh"` đều bị ép về tối đa `"high"`; kiểm tra trực tiếp không có code path nào trả `"max"`.
  2. **Clamp theo `providerCapabilities(provider).controls.efforts`**: kiểm tra 5 provider thật (`claude`, `codex`, `copilot`, `antigravity`, `cursor`) và test case tập hỗ trợ có khoảng trống (vd `["low", "high"]` với desired `"medium"` → `"low"`, không bao giờ nhảy lên `"high"`; tập `["high"]` với desired `"low"` → `null`/bỏ qua).
  3. **Cursor không throw**: `resolveAgentValues(doc, "cursor", "DEEP", "coding_agent")` khi `effort_derivation.mode = "auto"` không throw, không gán `reasoning_effort`, nguồn `"account/CLI default (external)"`; vẫn throw nếu user truyền tường minh ở step.
  4. **Thứ tự ưu tiên khớp bảng chân trị**: kiểm thử đủ các hàng bảng chân trị (`step > profile[scope][role] > profile[*][role] > provider default tường minh > [derived] > account default`), kể cả trường hợp `null` tường minh ở mỗi tầng luôn chặn derive.
  5. **Codex model-level clamp**: truyền `modelEfforts = ["low", "high"]` (giả lập `gpt-test`) với desired `"medium"` → trả `"low"` và `field_sources.reasoning_effort` ghi rõ clamped; nếu user set tường minh `"medium"` thì không clamp (giữ nguyên để fail-closed).
  6. **Architecture check**: `npm run arch:check` pass không thêm violation vào `architecture/baseline.json`.
- **Integration tests**:
  1. [test/agent-configuration.integration.ts](file:///home/toan/hasaki-orbit/test/agent-configuration.integration.ts):
     - **Run đã freeze không đổi hành vi**: tạo `first` khi `effort_derivation` tắt (hoặc snapshot không có `effort_derivation`), bật cờ `EFFORT_DERIVATION_ENABLED` và đổi snapshot `matrix` giả lập, tạo `second` → `resolveStepAgent(first, ...)` giữ nguyên `null`/`undefined` cũ, `resolveStepAgent(second, ...)` nhận derived effort mới. Đổi `EFFORT_DERIVATION_ENABLED` sau `startRun` không đổi các step tiếp theo của `second`.
     - Preview API (`/api/settings/agents/preview`) khớp với `resolveStepAgent` cả giá trị lẫn `field_sources`.
     - Dòng `settings` cũ có `defaults.reasoning_effort: null` + `"legacy provider default"` được `loadAgentConfiguration()` dọn sạch khi nạp, còn `"provider default": null` được giữ nguyên.
  2. [test/step-agent.integration.ts](file:///home/toan/hasaki-orbit/test/step-agent.integration.ts):
     - `beginAttempt()` lưu `effective_agent.reasoning_effort` và `effective_agent.field_sources.reasoning_effort` vào DB, truyền tới `codexArgs` (`model_reasoning_effort`).
     - Chạy với Codex `gpt-test` (`fake-codex.mjs`) ở profile `STANDARD` → pre-persist model clamp hạ `"medium"` xuống `"low"` trước insert `effective_agent`, `lifecycle-characterization` không gãy.
     - Cập nhật test dòng 140-146 (PR2/cờ bật): kiểm `field_sources.reasoning_effort !== "step"` thay vì `!=="high"`.

---

## 7. Rollout và cổng bật mặc định

- **Trạng thái khi merge PR1**: `config.agent.effortDerivation.enabled` (đọc từ `EFFORT_DERIVATION_ENABLED` qua `flag()`) **MẶC ĐỊNH TẮT (`false`)** trong `src/config.ts`.
- **Kiểm chứng trước khi bật mặc định**: Chạy A/B benchmark qua [src/eval/](file:///home/toan/hasaki-orbit/src/eval/analytics.ts) (`mode: "live"`, `provider_sequence` trong [eval/configuration.ts](file:///home/toan/hasaki-orbit/src/eval/configuration.ts)) so sánh arm effort cố định/account default với arm theo bảng khởi điểm (`FAST/coding_agent=medium`, `DEEP/agent=medium`, `DEEP/coding_agent=high`, `DEEP/verifier=medium`), và đối chiếu shadow trên dữ liệu production.
- **Bảng điều kiện để bật mặc định** (so sánh arm derive với arm baseline, theo từng ô `profile × step_type`; dữ liệu đối chiếu từ `verification_result->>'passed'`, `workflow_steps.output->>'verdict'`, `wall_duration_ms`, token/cost trên `execution_attempt_telemetry`):

| Metric                                                       | Điều kiện đạt                                                                                                                              | Nguồn ngưỡng                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Verified rate (`coding_agent`)                               | Cận dưới khoảng tin cậy 95% của (derive − baseline) > −0.05                                                                                | `NON_INFERIORITY_MARGIN` trong `src/routing/adaptive.ts`; dùng lại hàm tính khoảng có sẵn |
| Independent review PASS                                      | Không tệ hơn: diff ≥ −0.05 và cận trên ≥ 0                                                                                                 | tiêu chí `noHarm` trong `adaptive.ts`                                                     |
| Rework (`generation > 1`) và retries                         | Tỉ lệ không tăng quá 0.05 so với baseline                                                                                                  | đề xuất chính sách                                                                        |
| Latency p95 `wall_duration_ms`                               | ≤ 1.25 × baseline; tỉ lệ `EXECUTION_TIMEOUT` không tăng quá 1 điểm %                                                                       | đề xuất chính sách                                                                        |
| Token trên mỗi verified success (input + output + reasoning) | FAST/STANDARD: ≤ baseline. DEEP: cho phép ≤ 1.2 × baseline chỉ khi verified rate cao hơn có ý nghĩa (cận dưới > 0)                         | đề xuất chính sách                                                                        |
| `classifyWithFallback` (timeout 5s)                          | Tỉ lệ fallback/timeout không tăng so với baseline                                                                                          | đề xuất chính sách                                                                        |
| Cỡ mẫu tối thiểu mỗi ô                                       | ≥ 30 mẫu verified (= 3 × `min_samples` mặc định 10, đúng mức "confidence high" của adaptive routing). Ô thiếu mẫu = chưa kết luận, giữ tắt | `adaptive.ts`                                                                             |

Quy tắc: còn ô nào chưa đạt thì chưa bật cờ. Sửa ô tương ứng trong `DEFAULT_EFFORT_MATRIX` rồi đo lại.

- **Rollback**:
  - Đặt `EFFORT_DERIVATION_ENABLED=0` (hoặc gỡ biến env, vì mặc định `false`) và restart: dừng derive ngay cho mọi run mới mà không cần sửa DB.
  - Nếu chỉ muốn tắt riêng một provider (vd Codex): vào `AgentSettings` → Provider defaults chọn `"Model/Account default"` (`null` tường minh).

---

## 8. Phase 2 (`complexity` / risk — mô tả hướng)

- Nguồn dữ liệu đã có sẵn: `classifyComplexity()` ([src/workflow/profiles.ts:245](file:///home/toan/hasaki-orbit/src/workflow/profiles.ts#L245)) tính `TRIVIAL | STANDARD | COMPLEX | HIGH_RISK` lúc `resolveRunGraph()` ([runCreation.ts:257](file:///home/toan/hasaki-orbit/src/workflow/engine/runCreation.ts#L257)) và lưu vào `workflow_runs.profile_decision`.
- Đường truyền tới `resolveStepAgent`:
  1. Truyền `complexity = run.profile_decision?.complexity?.class` (bổ sung `r.profile_decision` vào `JobPreview` ở `attempts.ts:76` và kiểu `RunRow` đã có sẵn `profile_decision` ở `src/workflow/types.ts:179`).
  2. Trong `effortDerivation.ts`, áp dụng rule điều chỉnh theo `complexity` (vẫn qua `AUTO_EFFORT_CEILING = "high"` và clamp provider/model): đặc biệt khi `profile === "STANDARD"` nhưng `complexity === "HIGH_RISK"` (trường hợp `runCreation.ts:266` chặn `FAST`/`MICRO` kéo về `STANDARD` cho tác vụ thanh toán/auth/migration) → nâng `coding_agent` và `verifier` từ `medium` lên `high`; hoặc `STANDARD + TRIVIAL` → hạ về `low`.

---

## 9. Rủi ro và ghi chú chính sách

### Rủi ro kỹ thuật còn lại

- **Model Catalog miss lúc claim time**: Nếu `probeModelEfforts("codex", model)` lỗi hoặc hết cache khi daemon CLI tạm treo, `resolveStepAgent` rơi về clamp theo provider (`controls.efforts`) và `checkModel()` ở preflight sẽ fail-closed như hiện nay nếu model đó không hỗ trợ mức derive.
- **Cold-start Adaptive Routing**: Các workflow đang hưởng lợi từ adaptive routing trên `effort = null` sẽ quay về incumbent với derived effort trong thời gian tích đủ `min_samples` (mặc định 10) sample verified mới.
- **Caller phân mảnh của `completeForRun`**: Nếu trong tương lai thêm caller `completeForRun(ctx.run, ...)` mới mà quên ghim `"low"` cho tác vụ ngắn, nó sẽ thừa hưởng `DEEP/agent = medium` hoặc `STANDARD/agent = medium`.

### Ghi chú về các quyết định đã chốt & ngưỡng chính sách

- Các câu hỏi mở từ v2 đã được chốt: (1) cấu hình chỉ dùng biến env `EFFORT_DERIVATION_ENABLED` qua `flag()` (không dùng `config.json`, không override `matrix` qua config, không sửa `docs/audits/env-inventory.md`, vẫn snapshot `DEFAULT_EFFORT_MATRIX` lúc run-start); (2) `modelChangeAnalyzer` và `modelSkillDrafter` ([learningModel.ts](file:///home/toan/hasaki-orbit/src/agent/learningModel.ts)) giữ derive theo `run.profile` để bảo toàn recall; (3) các ngưỡng cổng bật mặc định theo bảng ở Mục 7.
- Lưu ý: các ngưỡng ở Mục 7 (ngoài ngưỡng tái sử dụng từ `src/routing/adaptive.ts`) là **đề xuất chính sách** ban đầu và cần hiệu chỉnh lại sau khi có số liệu baseline thực tế.
