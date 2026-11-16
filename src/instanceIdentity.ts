import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

export function validateInstanceId(id: string): string {
  if (!id || id.length > 200 || /[:\s\x00-\x1f]/.test(id))
    throw new Error(
      "Instance identity must be 1–200 characters without whitespace or colons; set PLATFORM_INSTANCE explicitly.",
    );
  return id;
}

/** Exclusive creation handles concurrent first starts. Identity files must live outside any Git checkout. */
export function persistentInstanceId(dataDir: string, explicit?: string): string {
  if (explicit?.trim()) return validateInstanceId(explicit.trim());
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let dir = realpathSync(dataDir);
  for (;;) {
    if (existsSync(join(dir, ".git")))
      throw new Error("dataDir must be outside the Git repository to persist instance identity.");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const file = join(resolve(dataDir), "instance-id");
  try {
    writeFileSync(file, randomUUID() + "\n", { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return validateInstanceId(readFileSync(file, "utf8").trim());
}
