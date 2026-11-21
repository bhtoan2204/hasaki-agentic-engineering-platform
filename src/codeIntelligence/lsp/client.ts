/**
 * Minimal LSP client (P1-B, ADR 0009): Content-Length framed JSON-RPC over a child's stdio — the same framing the MCP
 * stdio bridge uses — for the handful of requests semantic navigation needs. No dependency: the repository has no LSP
 * library and the subset is small (initialize, didOpen/didChange, definition, references, documentSymbol, diagnostics,
 * call hierarchy, shutdown). Requests carry a deadline and an AbortSignal; both send `$/cancelRequest`.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface LspCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  cleanup?: () => void;
}
export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}
export interface Location {
  uri: string;
  range: Range;
}
export interface Diagnostic {
  range: Range;
  severity?: number;
  message: string;
}

export class LspError extends Error {
  readonly kind: "timeout" | "canceled" | "crashed" | "failed";
  constructor(kind: LspError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class LspClient {
  private child: ChildProcess;
  private buffer = Buffer.alloc(0);
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private versions = new Map<string, number>();
  private published = new Map<string, { diagnostics: Diagnostic[]; at: number }>();
  private publishWaiters: Array<() => void> = [];
  private cleanup?: () => void;
  capabilities: Record<string, unknown> = {};
  alive = true;
  stderrTail = "";

  private constructor(cmd: LspCommand) {
    this.cleanup = cmd.cleanup;
    this.child = spawn(cmd.command, cmd.args, {
      cwd: cmd.cwd,
      env: cmd.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.child.stdout!.on("data", (b: Buffer) => this.onData(b));
    this.child.stderr!.on("data", (b: Buffer) => {
      this.stderrTail = (this.stderrTail + b.toString()).slice(-2000);
    });
    this.child.stdin!.on("error", () => {});
    const gone = (why: string) => {
      if (!this.alive) return;
      this.alive = false;
      for (const p of this.pending.values()) p.reject(new LspError("crashed", why));
      this.pending.clear();
      try {
        this.cleanup?.();
      } catch {
        /* private temp home */
      }
    };
    this.child.on("error", (e) => gone(`language server failed to start: ${e.message}`));
    this.child.on("exit", (code, signal) =>
      gone(
        `language server exited (${signal ?? code})${this.stderrTail ? `: ${this.stderrTail.trim().split("\n").slice(-2).join(" | ")}` : ""}`,
      ),
    );
  }

  get pid() {
    return this.child.pid;
  }

  static async start(cmd: LspCommand, rootUri: string, startupTimeoutMs: number) {
    const client = new LspClient(cmd);
    await client
      .request(
        "initialize",
        {
          processId: process.pid,
          rootUri,
          workspaceFolders: [{ uri: rootUri, name: "root" }],
          capabilities: {
            textDocument: {
              synchronization: { didSave: false },
              definition: { linkSupport: false },
              references: {},
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              publishDiagnostics: {},
              diagnostic: {},
              callHierarchy: {},
            },
            workspace: { workspaceFolders: true, configuration: true },
          },
        },
        { timeoutMs: startupTimeoutMs },
      )
      .then((r) => {
        client.capabilities = (r as { capabilities?: Record<string, unknown> })?.capabilities ?? {};
      });
    client.notify("initialized", {});
    return client;
  }

  private send(message: unknown) {
    if (!this.alive || !this.child.stdin!.writable) return;
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...(message as object) }));
    this.child.stdin!.write(
      Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]),
    );
  }

  notify(method: string, params: unknown) {
    this.send({ method, params });
  }

  request<T = unknown>(
    method: string,
    params: unknown,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<T> {
    if (!this.alive)
      return Promise.reject(new LspError("crashed", "language server is not running"));
    if (opts.signal?.aborted) return Promise.reject(new LspError("canceled", "request canceled"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      };
      const cancel = (e: LspError) => {
        if (!this.pending.delete(id)) return;
        done();
        this.notify("$/cancelRequest", { id });
        reject(e);
      };
      const onAbort = () => cancel(new LspError("canceled", "request canceled"));
      const timer = setTimeout(
        () => cancel(new LspError("timeout", `${method} exceeded ${opts.timeoutMs} ms`)),
        opts.timeoutMs,
      );
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => (done(), resolve(v as T)),
        reject: (e) => (done(), reject(e)),
      });
      this.send({ id, method, params });
    });
  }

  /** Make the server see exactly `text` for `uri` (open once, then full-text changes). */
  sync(uri: string, languageId: string, text: string) {
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.published.delete(uri);
    if (version === 1)
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } });
    else
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    this.versions.set(uri, version);
  }

  /** Pull diagnostics when the server supports them, otherwise the next publication for `uri` (bounded wait). */
  async diagnostics(
    uri: string,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<Diagnostic[]> {
    if (this.capabilities.diagnosticProvider) {
      const r = await this.request<{ items?: Diagnostic[] }>(
        "textDocument/diagnostic",
        { textDocument: { uri } },
        opts,
      );
      return r?.items ?? [];
    }
    const end = Date.now() + opts.timeoutMs;
    while (!this.published.has(uri)) {
      if (!this.alive) throw new LspError("crashed", "language server is not running");
      if (opts.signal?.aborted) throw new LspError("canceled", "request canceled");
      const left = end - Date.now();
      if (left <= 0) throw new LspError("timeout", "no diagnostics were published in time");
      await new Promise<void>((r) => {
        const t = setTimeout(r, Math.min(left, 250));
        this.publishWaiters.push(() => (clearTimeout(t), r()));
      });
    }
    return this.published.get(uri)!.diagnostics;
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const match = /Content-Length: *(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString());
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      if (length > 64 * 1024 * 1024) {
        this.kill();
        return;
      }
      if (this.buffer.length < headerEnd + 4 + length) return;
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString();
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      let m: {
        id?: number | string;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { message?: string };
      };
      try {
        m = JSON.parse(body);
      } catch {
        continue;
      }
      this.onMessage(m);
    }
  }

  private onMessage(m: {
    id?: number | string;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { message?: string };
  }) {
    if (m.method && m.id !== undefined) {
      // Server → client requests: answer neutrally so the server never blocks on us.
      const items = (m.params as { items?: unknown[] })?.items;
      this.send({
        id: m.id,
        result: m.method === "workspace/configuration" ? (items ?? []).map(() => null) : null,
      });
      return;
    }
    if (m.method === "textDocument/publishDiagnostics") {
      const p = m.params as { uri: string; diagnostics: Diagnostic[] };
      this.published.set(p.uri, { diagnostics: p.diagnostics ?? [], at: Date.now() });
      for (const w of this.publishWaiters.splice(0)) w();
      return;
    }
    if (typeof m.id === "number") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new LspError("failed", m.error.message ?? "request failed"));
      else p.resolve(m.result);
    }
  }

  kill() {
    try {
      if (this.child.pid) process.kill(-this.child.pid, "SIGKILL");
    } catch {
      this.child.kill("SIGKILL");
    }
  }

  async close() {
    if (this.alive) {
      await this.request("shutdown", null, { timeoutMs: 1000 }).catch(() => {});
      this.notify("exit", null);
    }
    const exited = new Promise<void>((r) => {
      if (!this.alive) return r();
      this.child.once("exit", () => r());
    });
    await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]);
    this.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]);
  }
}
