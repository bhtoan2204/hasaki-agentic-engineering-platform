import { writeFile } from "node:fs/promises";
import { decryptSecret } from "../auth/crypto.ts";
import { one, pool } from "../db/pool.ts";
import { checkpointHash, readExecutionCheckpoint } from "../workflow/checkpoints.ts";

const [id, output] = process.argv.slice(2);
const attemptId = Number(id);
if (!Number.isSafeInteger(attemptId) || attemptId <= 0 || !output) {
  console.error(
    "Usage: node --env-file-if-exists=.env src/cli/export-workspace-checkpoint.ts ATTEMPT_ID OUTPUT_FILE",
  );
  process.exitCode = 2;
} else {
  try {
    const checkpoint = await readExecutionCheckpoint(pool, attemptId);
    if (!checkpoint?.workspace_artifact_id)
      throw new Error("No valid workspace artifact for this attempt");
    const artifact = await one<{ content: string }>(
      pool,
      "SELECT content FROM workflow_artifacts WHERE id=$1 AND attempt_id=$2",
      [checkpoint.workspace_artifact_id, attemptId],
    );
    if (!artifact || checkpointHash(artifact.content) !== checkpoint.workspace_artifact_digest)
      throw new Error("Workspace artifact changed or expired");
    const payload = decryptSecret(artifact.content);
    await writeFile(output, payload, { flag: "wx", mode: 0o600 });
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
