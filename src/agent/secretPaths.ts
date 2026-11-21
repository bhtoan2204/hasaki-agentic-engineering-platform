/** Secret files in a protected checkout stay unreadable. `.env.example` is source, not a secret. */
export function isSecretPath(path: string): boolean {
  const base = path.split(/[/\\]/).pop() ?? "";
  if (base === ".env.example" || base === ".env.sample") return false;
  if (base === ".env" || base.startsWith(".env.")) return true;
  return (
    /^(config\.json|credentials\.json|auth\.json|id_rsa|id_ed25519)$/i.test(base) ||
    /\.(pem|key)$/i.test(base)
  );
}
