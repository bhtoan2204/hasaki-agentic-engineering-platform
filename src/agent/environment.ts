/** Child processes receive their configured provider authentication, never platform/application credentials. */
export function agentEnvironment(base: NodeJS.ProcessEnv, provider: "claude" | "codex" | "cursor"): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const platform =
    /^(DATABASE_URL|AUTH_SECRET|PG[A-Z]*|PLATFORM_[A-Z_]*|NOTIFY_WEBHOOK|TELEGRAM_[A-Z_]*|BITBUCKET_[A-Z_]*|JIRA_[A-Z_]*|TEST_DATABASE_[A-Z_]*)$/;
  const providerKey =
    /^(OPENAI_API_KEY|CODEX_API_KEY|AZURE_OPENAI_API_KEY|ANTHROPIC_[A-Z_]*|CLAUDE_CODE_OAUTH_TOKEN|CURSOR_API_KEY)$/;
  const secret =
    /(SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|COOKIE|PRIVATE_KEY|_API_KEY|ACCESS_KEY_ID|CONNECTION_STRING)/i;
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || platform.test(key)) continue;
    const ownAuth =
      (provider === "claude" && (/^(ANTHROPIC_)/.test(key) || key === "CLAUDE_CODE_OAUTH_TOKEN")) ||
      (provider === "cursor" && key === "CURSOR_API_KEY");
    if (ownAuth || (!providerKey.test(key) && !secret.test(key))) out[key] = value;
  }
  return out;
}
