import type { ExecutionContext, StepExecutor } from "../../src/workflow/executors/registry.ts";

export async function characterize(executor: StepExecutor, ctx: ExecutionContext) {
  const events: string[] = [];
  const artifacts: Array<{ kind: string; name: string }> = [];
  const originalLog = ctx.log.bind(ctx);
  const originalArtifact = ctx.artifact.bind(ctx);
  ctx.log = async (kind, content, data) => {
    events.push(kind);
    await originalLog(kind, content, data);
  };
  ctx.artifact = async (kind, name, content, data) => {
    artifacts.push({ kind, name });
    return originalArtifact(kind, name, content, data);
  };
  const result = await executor.execute(ctx);
  const normalize = (value: unknown): unknown => {
    if (typeof value === "string")
      return value
        .replaceAll(process.env.TEST_ROOT!, "<test-root>")
        .replace(
          /\/worktrees\/[0-9a-f]+\/\d+\/agent-\d+/g,
          "/worktrees/<run>/<step>/agent-<attempt>",
        )
        .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, "<timestamp>");
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
    return value;
  };
  return JSON.parse(
    JSON.stringify({ result: normalize(result), artifacts, eventKinds: [...new Set(events)] }),
  );
}
