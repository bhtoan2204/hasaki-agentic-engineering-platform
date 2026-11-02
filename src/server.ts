import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { events, inbox, migrate, prs, questions, tasks } from "./db.ts";
import { fetchTaskList, pickTask, startPolling } from "./work.ts";
import { authStatus, closeLoginWindow, loadToken, openLoginWindow, setToken } from "./hasakiAuth.ts";
import { cancel, enqueue, isRunning } from "./agent.ts";
import { normalizeTask } from "./prompt.ts";

const indexHtml = join(import.meta.dirname, "..", "public", "index.html");

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

async function mustTask(code: string) {
  const t = await tasks.get(code);
  if (!t) throw new HttpError(404, "task not found");
  return t;
}

type Handler = (p: { code: string; body: any; url: URL }) => unknown;
const routes: Array<[method: string, pattern: RegExp, handler: Handler]> = [
  // Import a task: body is the raw task API response ({message,status,data:{...}}) or just its data.
  [
    "POST",
    /^\/api\/tasks$/,
    async ({ body }) => {
      const t = normalizeTask(body);
      const existing = await tasks.get(t.code);
      await tasks.upsert(t.code, t.workId, t.name, t.project, t.data);
      if (!existing) await enqueue(t.code);
      return { code: t.code, started: !existing };
    },
  ],
  ["GET", /^\/api\/tasks$/, () => tasks.list()],
  [
    "GET",
    /^\/api\/tasks\/([^/]+)$/,
    async ({ code, url }) => {
      const t = await mustTask(code);
      return {
        ...t,
        running: isRunning(code),
        questions: await questions.list(code),
        prs: await prs.list(code),
        events: await events.list(code, Number(url.searchParams.get("after") ?? 0)),
      };
    },
  ],
  // Answer open questions: {answers: {[questionId]: "..."}}. Resumes the agent once nothing is left open.
  [
    "POST",
    /^\/api\/tasks\/([^/]+)\/answers$/,
    async ({ code, body }) => {
      await mustTask(code);
      const answers: Record<string, string> = body.answers ?? {};
      const lines: string[] = [];
      for (const q of await questions.open(code)) {
        const a = answers[q.id]?.trim();
        if (!a) continue;
        await questions.answer(q.id, code, a);
        lines.push(`Q: ${q.question}\nA: ${a}`);
      }
      if (!lines.length) throw new HttpError(400, "no answers given");
      const stillOpen = (await questions.open(code)).length;
      if (!stillOpen) await enqueue(code, "Developer's answers:\n\n" + lines.join("\n\n") + "\n\nContinue the task.");
      return { resumed: !stillOpen, stillOpen };
    },
  ],
  // Free-form message: review feedback, extra instructions, "retry". Resumes the session.
  [
    "POST",
    /^\/api\/tasks\/([^/]+)\/messages$/,
    async ({ code, body }) => {
      await mustTask(code);
      const message = String(body.message ?? "").trim();
      if (!message) throw new HttpError(400, "empty message");
      await enqueue(code, message);
      return { ok: true };
    },
  ],
  [
    "POST",
    /^\/api\/tasks\/([^/]+)\/cancel$/,
    async ({ code }) => {
      await mustTask(code);
      cancel(code);
      await tasks.setStatus(code, "idle", "cancelled by user");
      return { ok: true };
    },
  ],
  // ---- Hasaki Work ----
  ["GET", /^\/api\/work\/status$/, () => authStatus()],
  // Open a plain Chromium on Hasaki Work; the developer logs in, we capture the token from its API calls.
  ["POST", /^\/api\/work\/login-window$/, async () => (await openLoginWindow(), authStatus())],
  ["POST", /^\/api\/work\/login-window\/close$/, async () => (await closeLoginWindow(), authStatus())],
  // Or paste the token ("Bearer eyJ..." from DevTools > Network > any wshr.hasaki.vn request).
  ["POST", /^\/api\/work\/token$/, async ({ body }) => (await setToken(String(body.token ?? "")), authStatus())],
  // Refresh the inbox from the Hasaki Work task list.
  ["POST", /^\/api\/work\/refresh$/, async () => ({ count: (await fetchTaskList()).length, inbox: await inbox.list() })],
  ["GET", /^\/api\/work\/inbox$/, () => inbox.list()],
  // Pick a task from the inbox: fetch its detail, import it, start the agent.
  ["POST", /^\/api\/work\/pick\/(\d+)$/, async ({ code: workId }) => pickTask(Number(workId))],
];

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(readFileSync(indexHtml));
  }
  for (const [method, pattern, handler] of routes) {
    const m = url.pathname.match(pattern);
    if (!m || method !== req.method) continue;
    try {
      const body = method === "POST" ? await readJson(req) : {};
      const out = await handler({ code: decodeURIComponent(m[1] ?? ""), body, url });
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(out));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 400;
      res.writeHead(status, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: (e as Error).message }));
    }
  }
  res.writeHead(404).end();
}

await migrate();
await loadToken();
// Tasks that were mid-run when the platform stopped: resume them.
for (const t of (await tasks.list()) as any[]) {
  if (t.status === "running" || t.status === "queued")
    await enqueue(t.code, "The platform restarted mid-run. Check the state of your worktrees and continue.");
}
startPolling();

// No auth on this API, so listen on loopback only (set HOST=0.0.0.0 to expose deliberately).
createServer(handle).listen(config.port, process.env.HOST ?? "127.0.0.1", () => console.log(`task platform on ${config.publicUrl}`));
