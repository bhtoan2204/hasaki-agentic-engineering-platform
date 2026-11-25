/**
 * Environment for a child process that is not a platform component: the platform's own secrets are removed, everything
 * else (PATH, proxies, provider keys the child may need) is kept. A launcher that does need one of them (platform-go
 * needs DATABASE_URL and the internal token) passes it explicitly. This file reads the process environment on purpose:
 * it is the one place that decides what a child inherits (eslint.config.mjs allows it).
 */
const PLATFORM_SECRETS =
  /^(AUTH_SECRET(?:_PREVIOUS)?|AUTH_CIPHERTEXT_FORMAT|DATABASE_URL|RETRIEVAL_INTERNAL_TOKEN|PLATFORM_GIT_(?:USER|TOKEN)|TEST_DATABASE_[A-Z_]*|BENCH_DATABASE_ADMIN_URL|ADMIN_PASSWORD)$/;

export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base))
    if (!PLATFORM_SECRETS.test(key)) out[key] = value;
  return out;
}
