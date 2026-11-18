import { liveRuntime } from "../eval/liveRuntime.ts";

/**
 * Variables that move Claude onto pay-per-token billing: an API key, a gateway or a cloud provider. Claude runs only on
 * the worker's subscription login (claude /login, or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`).
 */
const PAID_CLAUDE_AUTH =
  /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_(BEDROCK|VERTEX|FOUNDRY)_[A-Z_]+|AWS_BEARER_TOKEN_BEDROCK|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY))$/;

/** The API-key source a Claude session reports at start when it would bill per token, else null. */
export function paidClaudeAuth(msg: unknown): string | null {
  const m = msg as { type?: string; subtype?: string; apiKeySource?: unknown } | null;
  if (m?.type !== "system" || m.subtype !== "init") return null;
  const source = typeof m.apiKeySource === "string" ? m.apiKeySource : "none";
  return source === "none" ? null : source;
}

export const paidClaudeAuthMessage = (source: string) =>
  `Claude would bill per token through ${source}; the platform only runs Claude on the subscription login. Remove the API key or apiKeyHelper from the worker and sign in with \`claude /login\` (or set CLAUDE_CODE_OAUTH_TOKEN from \`claude setup-token\`).`;
/** Child processes receive their configured provider authentication, never platform/application credentials. */
export function agentEnvironment(
  base: NodeJS.ProcessEnv,
  provider: "claude" | "codex" | "cursor" | "antigravity" | "copilot",
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const platform =
    /^(DATABASE_URL|AUTH_SECRET|PG[A-Z]*|PLATFORM_[A-Z_]*|NOTIFY_WEBHOOK|TELEGRAM_[A-Z_]*|BITBUCKET_[A-Z_]*|JIRA_[A-Z_]*|TEST_DATABASE_[A-Z_]*)$/;
  const providerKey =
    /^(OPENAI_API_KEY|CODEX_API_KEY|AZURE_OPENAI_API_KEY|ANTHROPIC_[A-Z_]*|CLAUDE_CODE_OAUTH_TOKEN|CURSOR_API_KEY)$/;
  const secret =
    /(SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|COOKIE|PRIVATE_KEY|_API_KEY|ACCESS_KEY_ID|CONNECTION_STRING)/i;
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || platform.test(key) || PAID_CLAUDE_AUTH.test(key)) continue;
    const ownAuth =
      (provider === "claude" && (/^(ANTHROPIC_)/.test(key) || key === "CLAUDE_CODE_OAUTH_TOKEN")) ||
      (provider === "cursor" && key === "CURSOR_API_KEY");
    if (ownAuth || (!providerKey.test(key) && !secret.test(key))) out[key] = value;
  }
  const runtime = liveRuntime.getStore();
  if (runtime) {
    out.TEST_DATABASE_URL = runtime.databaseUrl;
    delete out.NODE_OPTIONS;
    delete out.NODE_PATH;
    delete out.BASH_ENV;
    delete out.ENV;
  }
  return out;
}
