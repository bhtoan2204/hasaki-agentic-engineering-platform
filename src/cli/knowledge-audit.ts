import { remediateKnowledgeAudit } from "../knowledge/auditRemediation.ts";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { loadKnowledgeAuditData } from "../knowledge/auditLoader.ts";
import { auditMarkdown } from "../knowledge/audit.ts";
import { pool } from "../db/pool.ts";

const offline = process.argv.includes("--offline");
const days = process.argv.find((a) => a.startsWith("--days="))?.slice(7);
const osUser = () => {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
};
const actor = process.argv.find((a) => a.startsWith("--actor="))?.slice(8) || osUser();
try {
  // The operator already has direct database access; repository restrictions would hide most shared items.
  const { input, report } = await loadKnowledgeAuditData({
    offline,
    allShared: true,
    windowDays: days ? Number(days) : 7,
  });
  const root = resolve("docs/audits");
  await mkdir(root, { recursive: true });
  let file = resolve(root, `${report.generatedAt.slice(0, 10)}-knowledge-audit`);
  if (existsSync(`${file}.md`) || existsSync(`${file}.json`))
    file += `-${report.generatedAt.slice(11, 19).replaceAll(":", "")}`;
  await writeFile(
    `${file}.md`,
    auditMarkdown(report) +
      `\nSources: ${JSON.stringify(report.sources)}\n\nPrivate aggregates: ${JSON.stringify(report.privateAggregates)}\n`,
  );
  await writeFile(`${file}.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes("--remediate")) {
    if (offline) throw new Error("Remediation requires database evidence");
    const confirmed = process.argv.includes("--yes");
    const { proposals } = await remediateKnowledgeAudit(input, {
      autoApply: confirmed && process.argv.includes("--auto-apply"),
      dryRun: !confirmed,
      operator: actor,
    });
    console.log(JSON.stringify({ operator: actor, proposals }, null, 2));
    if (!confirmed)
      console.log("Planned proposals only; re-run with --remediate --yes to create them.");
  }
} finally {
  await pool.end();
}
