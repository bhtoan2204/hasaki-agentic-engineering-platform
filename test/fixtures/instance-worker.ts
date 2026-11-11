import { config } from "../../src/config.ts";
import { pool } from "../../src/db/pool.ts";
import { claimJob } from "../../src/workflow/scheduler.ts";
import { beginAttempt, finishAttempt } from "../../src/workflow/engine.ts";
import { registerInstance } from "../../src/instances.ts";
try {
  const mode = process.argv[2];
  if (mode === "register") await registerInstance();
  else if (mode === "register-hold") {
    await registerInstance();
    process.stdout.write("registered\n");
    await new Promise<void>((resolve) => {
      process.stdin.resume();
      process.stdin.once("end", () => resolve());
    });
  } else if (mode === "claim") {
    const job = await claimJob("child", 30);
    console.log(JSON.stringify(job ?? null));
  } else if (mode === "begin") {
    const job = JSON.parse(process.argv[3]);
    console.log(JSON.stringify(!!(await beginAttempt(job, "child"))));
  } else if (mode === "finish") {
    const { job, attempt } = JSON.parse(process.argv[3]);
    console.log(
      JSON.stringify(
        await finishAttempt(job.id, job.fencing_token, attempt.id, {
          kind: "completed",
          output: { unauthorized: true },
        }),
      ),
    );
  } else console.log(JSON.stringify(config.instanceId));
} finally {
  await pool.end();
}
