/**
 * Top-level keys of a step's prose output contract, e.g. "{ goal, requirements: string[], risks }" → goal, requirements,
 * risks. Dynamic keys ("[repo]") are skipped. Used to refuse a Codex step that ends without a result matching it.
 */
export function contractKeys(contract: unknown): string[] {
  const s = typeof contract === "string" ? contract.trim() : "";
  if (!s.startsWith("{") || !s.endsWith("}")) return [];
  const body = s.slice(1, -1);
  const keys: string[] = [];
  let depth = 0;
  let cur = "";
  const flush = () => {
    const m = cur.trim().match(/^([A-Za-z_][\w]*)\??\s*(:|$)/);
    if (m) keys.push(m[1]);
    cur = "";
  };
  for (const ch of body) {
    if ("{[(<".includes(ch)) depth++;
    else if ("}])>".includes(ch)) depth--;
    if (ch === "," && depth === 0) flush();
    else cur += ch;
  }
  flush();
  return keys;
}

export function missingContractKeys(contract: unknown, output: Record<string, unknown>): string[] {
  return contractKeys(contract).filter((k) => !(k in output));
}
