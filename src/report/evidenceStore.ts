import { pool, one, q, json } from "../db/pool.ts";
import { runEvents } from "../workflow/events.ts";

const MAX_BYTES = 10 * 1024 * 1024;
const MIME_OK = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|text\/plain|text\/csv|application\/json|text\/markdown)$/;

/**
 * Store user-supplied evidence for the report step as an artifact (kind 'evidence') in PostgreSQL. Evidence belongs to
 * the step, not an attempt: it survives regeneration, retries and restarts. Files are kept base64-encoded.
 */
export async function addEvidence(
  runId: number,
  stepKey: string,
  body: { requirement_id?: string | null; name?: string; mime?: string; data_base64?: string; note?: string; by?: string },
) {
  const step = await one(pool, "SELECT s.id, s.type, r.status AS run_status FROM workflow_steps s JOIN workflow_runs r ON r.id = s.run_id WHERE s.run_id = $1 AND s.key = $2", [runId, stepKey]);
  if (!step) throw new Error(`step "${stepKey}" not found`);
  if (step.type !== "task_result_report") throw new Error("evidence can only be attached to the Task Result Report step");
  if (step.run_status === "CANCELED") throw new Error("run is canceled");
  const req = body.requirement_id ? String(body.requirement_id) : null;
  if (req && !/^S\d+\.R\d+$/.test(req)) throw new Error("requirement_id must look like S1.R2");
  let content: string;
  let data: Record<string, unknown>;
  let name: string;
  if (body.data_base64) {
    const mime = String(body.mime ?? "");
    if (!MIME_OK.test(mime)) throw new Error(`unsupported file type ${mime || "(none)"}: png, jpg, gif, webp, pdf, txt, csv, json, md`);
    const bytes = Buffer.from(body.data_base64, "base64");
    if (!bytes.length) throw new Error("empty file");
    if (bytes.length > MAX_BYTES) throw new Error(`file too large (${bytes.length} bytes, max ${MAX_BYTES})`);
    name = String(body.name ?? "evidence").replace(/[^\w.\- ()]/g, "_").slice(0, 120);
    content = bytes.toString("base64");
    data = { mime, size: bytes.length, encoding: "base64", requirement_id: req, note: body.note ?? "", by: body.by ?? "" };
  } else if (body.note?.trim()) {
    name = "note";
    content = body.note.trim();
    data = { note_only: true, requirement_id: req, by: body.by ?? "" };
  } else throw new Error("send a file (data_base64 + mime) or a note");
  const row = await one(pool, "INSERT INTO workflow_artifacts (run_id, step_id, kind, name, content, data) VALUES ($1, $2, 'evidence', $3, $4, $5) RETURNING id, created_at", [
    runId,
    step.id,
    name,
    content,
    json(data),
  ]);
  await runEvents.add(pool, runId, "user", `evidence added${req ? ` for ${req}` : ""}: ${name}`, step.id);
  return { id: row.id, created_at: row.created_at, name, requirement_id: req };
}

export async function removeEvidence(artifactId: number) {
  const r = await q(pool, "DELETE FROM workflow_artifacts WHERE id = $1 AND kind = 'evidence' RETURNING run_id, step_id, name", [artifactId]);
  if (!r.length) throw new Error("evidence not found");
  await runEvents.add(pool, r[0].run_id, "user", `evidence removed: ${r[0].name}`, r[0].step_id);
  return { ok: true };
}
