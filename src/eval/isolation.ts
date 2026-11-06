import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, realpathSync } from "node:fs";
import { config } from "../config.ts";
import { randomUUID, createHash } from "node:crypto";
const exec = promisify(execFile);
export class IsolationUnavailable extends Error {}
let closure: Promise<string[]> | undefined;
async function nodeClosure() {
  if (!closure)
    closure = (async () => {
      const root = realpathSync(process.execPath).match(
        /^(\/nix\/store\/[^/]+)\//,
      )?.[1];
      if (!root)
        throw new IsolationUnavailable(
          "A pinned Nix Node runtime is required by this sandbox adapter",
        );
      const paths = (
        await exec("nix-store", ["--query", "--requisites", root], {
          timeout: 5000,
          maxBuffer: 64 * 1024,
        })
      ).stdout
        .trim()
        .split("\n")
        .sort();
      if (
        !paths.length ||
        paths.some((p) => !/^\/nix\/store\/[a-z0-9]{32}-[^/,]+$/.test(p))
      )
        throw new IsolationUnavailable("Invalid Node runtime closure");
      return paths;
    })().catch((e) => {
      closure = undefined;
      throw e;
    });
  return closure;
}
export async function sandboxIdentity() {
  try {
    const image =
      "sha256:" +
      (
        await exec(
          "docker",
          [
            "image",
            "inspect",
            config.evaluation.sandboxImage,
            "--format",
            "{{.Id}}",
          ],
          { timeout: 5000, maxBuffer: 8192 },
        )
      ).stdout
        .trim()
        .replace(/^sha256:/, "");
    if (!/^sha256:[a-f0-9]{64}$/.test(image))
      throw new Error("Missing immutable image identity");
    const probe = await containerRun(
      image,
      [],
      [
        "-e",
        'const fs=require("fs"); console.log(JSON.stringify({isolated:require("os").networkInterfaces(),secret:!!process.env.DATABASE_URL,memory:fs.readFileSync("/sys/fs/cgroup/memory.max","utf8").trim(),pids:fs.readFileSync("/sys/fs/cgroup/pids.max","utf8").trim()}))',
      ],
      5000,
    );
    const parsed = JSON.parse(probe.stdout.trim());
    if (
      parsed.secret ||
      !(Number(parsed.memory) > 0 && Number(parsed.memory) <= 268435456) ||
      !(Number(parsed.pids) > 0 && Number(parsed.pids) <= 64) ||
      Object.keys(parsed.isolated).some((x) => x !== "lo")
    )
      throw new Error("Isolation probe failed");
    return {
      image,
      runtime_hash: createHash("sha256")
        .update((await nodeClosure()).join("\n"))
        .digest("hex"),
      node: realpathSync(process.execPath),
      network: "none",
      memory_bytes: 268435456,
      pids: 64,
      cpu: 1,
      version: "container-v1",
    };
  } catch {
    throw new IsolationUnavailable(
      "Networkless, resource-limited validation container is unavailable; install/configure a supported local runtime and pre-load an image. No image is pulled automatically.",
    );
  }
}
export async function containerRun(
  image: string,
  mounts: Array<{ source: string; target: string }>,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image))
    throw new IsolationUnavailable("Unpinned sandbox image");
  if (!existsSync("/nix/store"))
    throw new IsolationUnavailable(
      "This sandbox adapter requires a locally installed Nix Node closure; unsupported workers are blocked",
    );
  const name = `hasaki-eval-${randomUUID()}`;
  const flags = [
    "run",
    "--rm",
    "--timeout",
    String(
      Math.ceil(
        Math.min(timeoutMs, config.evaluation.maxCaseSeconds * 1000) / 1000,
      ),
    ),
    "--name",
    name,
    "--pull=never",
    "--network",
    "none",
    "--memory",
    "256m",
    "--memory-swap",
    "256m",
    "--pids-limit",
    "64",
    "--cpus",
    "1",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=32m",
    "--env",
    "HOME=/tmp",
    "--env",
    "NODE_OPTIONS=",
    "--entrypoint",
    realpathSync(process.execPath),
  ];
  for (const path of await nodeClosure())
    flags.push("--mount", `type=bind,src=${path},dst=${path},readonly`);
  for (const m of mounts) {
    if (!m.target.startsWith("/") || m.source.includes(","))
      throw new Error("Invalid sandbox mount");
    flags.push(
      "--mount",
      `type=bind,src=${realpathSync(m.source)},dst=${m.target},readonly`,
    );
  }
  try {
    return await exec(
      "docker",
      [
        ...flags,
        image.replace(/^sha256:/, ""),
        "--disable-warning=ExperimentalWarning",
        "--max-old-space-size=128",
        ...args,
      ],
      {
        timeout: Math.min(timeoutMs, config.evaluation.maxCaseSeconds * 1000),
        signal,
        maxBuffer: 64 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
          DOCKER_HOST: process.env.DOCKER_HOST,
          CONTAINER_HOST: process.env.CONTAINER_HOST,
        },
      },
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || Number(code) === 125)
      throw new IsolationUnavailable(
        "Validation runtime failed before the candidate process could execute",
      );
    throw error;
  } finally {
    await exec("docker", ["rm", "--force", name], {
      timeout: 5000,
      maxBuffer: 8192,
    }).catch(() => {});
  }
}
