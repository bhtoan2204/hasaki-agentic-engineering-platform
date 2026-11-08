import { useI18n } from "./i18n/index.tsx";
import { useApi } from "./api.ts";
import { Field } from "./ui.tsx";

/** Shared configuration form; the server validates inherited providers and CLI capabilities. */
export function StepAgentFields({
  value = {},
  onChange,
  allowVerification = true,
}: {
  allowVerification?: boolean;
  value?: Record<string, any>;
  onChange: (v: Record<string, any>) => void;
}) {
  const { locale } = useI18n();
  const { data: providers } = useApi<Array<{ id: string; models?: string[] }>>("/api/agent-providers");
  const en = locale === "en";
  const set = (key: string, val: unknown) => {
    const next = { ...value };
    if (val === undefined) delete next[key];
    else next[key] = val;
    onChange(next);
  };
  const provider = value.provider;
  return (
    <>
      {allowVerification && <details><summary>{en?"Provider fallback policy":"Chính sách agent dự phòng"}</summary>
        <Field label={en?"Fallback mode":"Chế độ dự phòng"}><select value={value.fallback?.mode??"manual"} onChange={e=>set("fallback",{...value.fallback,mode:e.target.value})}>{["disabled","manual","automatic"].map(m=><option key={m}>{m}</option>)}</select></Field>
        <Field label={en?"Fallback provider order":"Thứ tự agent dự phòng"}><input value={(value.fallback?.providers??["claude","codex","cursor"]).join(", ")} onChange={e=>set("fallback",{...value.fallback,providers:e.target.value.split(",").map(v=>v.trim()).filter(Boolean)})}/></Field>
        <Field label={en?"Maximum switches":"Số lần chuyển tối đa"}><input type="number" min={0} max={10} value={value.fallback?.max_switches??2} onChange={e=>set("fallback",{...value.fallback,max_switches:Number(e.target.value)})}/></Field>
        <label><input type="checkbox" checked={value.fallback?.allow_unknown_cost??false} onChange={e=>set("fallback",{...value.fallback,allow_unknown_cost:e.target.checked})}/>{en?"Allow automatic continuation when cost is unknown":"Cho phép tự động tiếp tục khi chưa rõ chi phí"}</label>
        <label><input type="checkbox" checked={value.fallback?.allow_budget_failure??false} onChange={e=>set("fallback",{...value.fallback,allow_budget_failure:e.target.checked})}/>{en?"Allow automatic continuation after a budget/billing failure":"Cho phép tự động tiếp tục sau lỗi ngân sách/thanh toán"}</label>
      </details>}

      <div className="grid2">
        <Field label={en ? "Agent provider" : "Nhà cung cấp agent"}>
          <select
            aria-label={en ? "Agent provider" : "Nhà cung cấp agent"}
            value={provider ?? ""}
            onChange={(e) =>
              onChange({ ...value, provider: e.target.value || undefined, model: null, reasoning_effort: null })
            }
          >
            <option value="">{en ? "Inherit run default" : "Theo mặc định lượt chạy"}</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
            <option value="cursor">Cursor</option>
          </select>
        </Field>
        <Field
          label={en ? "Provider model" : "Mô hình của nhà cung cấp"}
          hint={
            en
              ? "Empty: provider routing/account default. Use a model identifier supported by the selected provider."
              : "Để trống: định tuyến/mặc định tài khoản. Dùng mã mô hình được nhà cung cấp hỗ trợ."
          }
        >
          <input
            aria-label={en ? "Provider model" : "Mô hình của nhà cung cấp"}
            list={`agent-models-${provider ?? "inherit"}`}
            value={value.model ?? ""}
            onChange={(e) => set("model", e.target.value || null)}
          />
          <datalist id={`agent-models-${provider ?? "inherit"}`}>
            {(provider === "claude"
              ? ["sonnet", "opus", "haiku"]
              : provider === "cursor"
                ? ["auto"]
                : (providers?.find((p) => p.id === provider)?.models ?? [])
            ).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
        <Field label={en ? "Execution profile" : "Hồ sơ thực thi"}>
          <select
            value={value.execution_profile ?? ""}
            onChange={(e) => set("execution_profile", e.target.value || undefined)}
          >
            <option value="">{en ? "Run default" : "Mặc định lượt chạy"}</option>
            {["FAST", "STANDARD", "DEEP"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </Field>
        <Field label={en ? "Reasoning effort" : "Mức suy luận"}>
          <select
            disabled={provider === "cursor"}
            value={value.reasoning_effort ?? ""}
            onChange={(e) => set("reasoning_effort", e.target.value || null)}
          >
            <option value="">{en ? "Provider default" : "Mặc định nhà cung cấp"}</option>
            {(provider === "codex"
              ? ["none", "minimal", "low", "medium", "high", "xhigh"]
              : ["low", "medium", "high", "xhigh", "max"]
            ).map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </Field>
        <Field label={en ? "Timeout (ms)" : "Thời gian tối đa (ms)"}>
          <input
            type="number"
            min={1000}
            max={86400000}
            value={value.timeout_ms ?? ""}
            onChange={(e) => set("timeout_ms", e.target.value ? Number(e.target.value) : undefined)}
          />
        </Field>
        <Field label={en ? "Context token budget" : "Ngân sách token ngữ cảnh"}>
          <input
            type="number"
            min={2000}
            max={64000}
            value={value.context_tokens ?? ""}
            onChange={(e) => set("context_tokens", e.target.value ? Number(e.target.value) : undefined)}
          />
        </Field>
        <Field label={en ? "Retry attempts" : "Số lần thử tối đa"}>
          <input
            type="number"
            min={1}
            max={10}
            value={value.retry?.max_attempts ?? ""}
            onChange={(e) =>
              set("retry", e.target.value ? { ...value.retry, max_attempts: Number(e.target.value) } : undefined)
            }
          />
        </Field>
        <Field label={en ? "Retry backoff (s)" : "Thời gian chờ thử lại (giây)"}>
          <input
            type="number"
            min={0}
            max={3600}
            disabled={!value.retry}
            value={value.retry?.backoff_seconds ?? ""}
            onChange={(e) => set("retry", { ...value.retry, backoff_seconds: Number(e.target.value) })}
          />
        </Field>
      </div>
      {allowVerification && (
        <Field
          label={en ? "Verification command" : "Lệnh xác minh"}
          hint={
            en
              ? "Trusted workflow command; empty uses the existing verification policy."
              : "Lệnh của workflow đáng tin cậy; để trống dùng chính sách xác minh hiện có."
          }
        >
          <input
            value={value.verification?.command ?? ""}
            onChange={(e) =>
              set("verification", e.target.value ? { ...value.verification, command: e.target.value } : undefined)
            }
          />
        </Field>
      )}
      <Field
        label={en ? "Allowed tools" : "Công cụ được phép"}
        hint={
          provider === "cursor"
            ? en
              ? "Cursor cannot enforce custom native allowlists; platform baseline applies."
              : "Cursor chưa hỗ trợ danh sách công cụ tùy chỉnh; áp dụng quyền nền tảng hiện có."
            : en
              ? "Comma separated: Read, Bash, platform.search_code, integration:name. Empty inherits baseline. Completion and clarification controls remain available."
              : "Phân cách dấu phẩy: Read, Bash, platform.search_code, integration:name. Để trống dùng quyền cơ sở. Luôn có công cụ hoàn tất và yêu cầu làm rõ."
        }
      >
        <input
          disabled={provider === "cursor"}
          value={value.allowed_tools?.join(", ") ?? ""}
          onChange={(e) =>
            set(
              "allowed_tools",
              e.target.value.trim()
                ? e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean)
                : null,
            )
          }
        />
      </Field>
    </>
  );
}
